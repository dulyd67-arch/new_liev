import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

// This regression creates and deletes its own fixture account and room. Both
// application endpoints must be local, and the configured database must be an
// isolated test database. Never point this script at a public deployment.
function localEndpoint(raw, pathname) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('Browser fixture endpoints must be valid loopback URLs.'); }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  assert.ok(['http:', 'https:'].includes(url.protocol) && loopback.has(url.hostname.toLowerCase())
    && !url.username && !url.password && !url.search && !url.hash
    && url.pathname.replace(/\/$/, '') === pathname,
  'Browser fixtures require loopback web/API endpoints with their expected paths.');
  return url.origin + pathname;
}

let database;
try { database = new URL(process.env.DATABASE_MIGRATION_URL); }
catch { throw new Error('DATABASE_MIGRATION_URL must select an isolated test database.'); }
assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && /test/i.test(decodeURIComponent(database.pathname)),
  'Browser fixtures require an isolated test database.');
const base = localEndpoint(process.env.LIVE_TEST_WEB_URL || 'http://localhost:3000', '');
const api = localEndpoint(process.env.LIVE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', '/api/v1');
const artifact = resolve(process.cwd(), 'artifacts');
mkdirSync(artifact, { recursive: true });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const identity = { email: `studio-qa-${suffix}@integration.invalid`, password: `StudioFixture_${randomUUID().replaceAll('-', '')}!`, username: `studioqa_${suffix}` };
const report = { localOnly: true, site: base, startedAt: new Date().toISOString(), passed: false, checks: [], cleanup: {}, screenshots: [] };
let browser, hostContext, guestContext, host, guest, userId, streamId;
let phase = 'launch';
const errors = [];
const record = name => { report.checks.push(name); console.log(JSON.stringify({ check: name, ok: true })); };
const stage = name => { phase = name; console.log(JSON.stringify({ phase })); };

async function screenshot(page, name) {
  await page.screenshot({ path: `${artifact}/${name}`, fullPage: true });
  report.screenshots.push(name);
}

async function mediaEnabled(page, kind) {
  return page.evaluate(kind => {
    const tracks = [...window.__studioQaCaptures.flatMap(stream => stream.getTracks()),
      ...window.__studioQaPeers.flatMap(peer => peer.getSenders().map(sender => sender.track).filter(Boolean))];
    return tracks.some(track => track.kind === kind && track.readyState === 'live' && track.enabled);
  }, kind);
}

async function fixtureLogin() {
  const response = await fetch(`${api}/auth/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: identity.email, password: identity.password }), signal: AbortSignal.timeout(20_000), redirect: 'error' });
  assert.equal(response.status, 200);
  return response.json();
}

async function request(path, token, { method = 'GET', body } = {}) {
  return fetch(`${api}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: 'error' });
}

async function run() {
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  ] });
  hostContext = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
  guestContext = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  for (const [context, locale] of [[hostContext, 'ar'], [guestContext, 'en']]) {
    context.setDefaultTimeout(20_000);
    await context.addInitScript(locale => {
      if (location.protocol.startsWith('http')) localStorage.setItem('livestar-locale', locale);
      window.__studioQaCaptures = [];
      window.__studioQaPeers = [];
      if (navigator.mediaDevices?.getUserMedia) {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
          const stream = await original(constraints);
          window.__studioQaCaptures.push(stream);
          return stream;
        };
      }
      const Original = window.RTCPeerConnection;
      if (Original) window.RTCPeerConnection = class extends Original {
        constructor(...args) { super(...args); window.__studioQaPeers.push(this); }
      };
    }, locale);
  }
  host = await hostContext.newPage(); guest = await guestContext.newPage();
  host.on('pageerror', error => errors.push(error.name));
  guest.on('pageerror', error => errors.push(error.name));
  host.on('response', response => {
    if (response.url().endsWith('/api/v1/streams') && response.request().method() === 'POST' && response.ok())
      void response.json().then(value => { streamId = value.stream?.id || streamId; }).catch(() => undefined);
  });

  stage('register local QA publisher');
  await host.goto(`${base}/register`);
  assert.equal(new URL(host.url()).origin, base, 'Fixture registration must remain on the configured loopback origin.');
  await host.locator('input[name="displayName"]').fill('Studio QA');
  await host.locator('input[name="username"]').fill(identity.username);
  await host.locator('input[name="email"]').fill(identity.email);
  await host.locator('input[name="password"]').fill(identity.password);
  await host.locator('input[name="birthDate"]').fill('1990-01-01');
  await host.locator('input[name="accept"]').check();
  const registration = host.waitForResponse(response => response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST');
  await host.locator('button[type="submit"]').click();
  const registered = await registration;
  assert.equal(registered.status(), 201);
  const account = await registered.json(); userId = account.user.id;
  // A page reload legitimately rotates the web refresh family. Use an
  // independent normal mobile session for read-only owner observations.
  const observer = await fixtureLogin();
  stage('mobile Arabic pre-live');
  await host.goto(`${base}/go-live`);
  assert.equal(new URL(host.url()).origin, base, 'Studio navigation must remain on the configured loopback origin.');
  // The development-only Next toolbar overlaps the phone's bottom-left control.
  // It is absent from production; hide only this external development portal.
  await host.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await expect(host.getByTestId('studio-title')).toBeVisible();
  await expect(host.getByTestId('studio-start')).toBeDisabled();
  assert.equal(await host.evaluate(() => document.documentElement.dir), 'rtl');
  assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.equal((await (await request('/streams/mine', observer.accessToken)).json()).stream, null);
  record('studio is immersive RTL with no auto-broadcast');
  await host.getByTestId('studio-title').fill(`Local studio QA ${suffix}`);
  await host.getByTestId('studio-preview').click();
  await expect(host.getByTestId('studio-start')).toBeEnabled();
  assert.equal((await (await request('/streams/mine', observer.accessToken)).json()).stream, null);
  assert.equal(await mediaEnabled(host, 'video'), true);
  assert.equal(await mediaEnabled(host, 'audio'), true);
  record('camera preview does not reserve or publish a stream');

  stage('preview control and sheets');
  await host.getByTestId('studio-mic').click();
  await expect.poll(() => mediaEnabled(host, 'audio')).toBe(false);
  await host.getByTestId('studio-mic').click();
  await expect.poll(() => mediaEnabled(host, 'audio')).toBe(true);
  await host.getByTestId('studio-camera').click();
  await expect.poll(() => mediaEnabled(host, 'video')).toBe(false);
  await host.getByTestId('studio-camera').click();
  await expect.poll(() => mediaEnabled(host, 'video')).toBe(true);
  const cameraCount = await host.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput').length);
  if (cameraCount < 2) await expect(host.getByTestId('studio-flip')).toBeDisabled();
  record('preview camera and microphone controls affect actual capture tracks');
  await host.getByTestId('studio-settings').click();
  await expect(host.getByRole('dialog')).toBeVisible();
  await host.keyboard.press('Escape');
  await expect(host.getByRole('dialog')).toHaveCount(0);
  await expect(host.getByTestId('studio-settings')).toBeFocused();
  record('settings opens and Escape returns focus');
  await screenshot(host, 'studio-new-preview-ar.png');
  await host.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await expect.poll(() => host.evaluate(() => document.documentElement.dir)).toBe('ltr');
  assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await screenshot(host, 'studio-new-preview-en.png');
  await host.getByRole('button', { name: 'التبديل إلى العربية', exact: true }).click();
  await host.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await host.setViewportSize({ width: 390, height: 844 });
  record('Arabic English and desktop mobile layouts fit viewport');

  stage('publish actual local WebRTC');
  const activated = host.waitForResponse(response => /\/api\/v1\/streams\/[^/]+\/activate$/.test(response.url()) && response.request().method() === 'POST', { timeout: 40_000 });
  await host.getByTestId('studio-start').click();
  assert.equal((await activated).status(), 201);
  await expect(host.getByTestId('studio-end')).toBeVisible();
  assert.ok(streamId);
  const sharePath = `/live/${streamId}`;
  await guest.goto(`${base}${sharePath}`);
  assert.equal(new URL(guest.url()).origin, base, 'Guest navigation must remain on the configured loopback origin.');
  await guest.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await expect.poll(() => guest.getByTestId('watch-video').evaluate(video => video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => guest.locator('audio[data-stream-audio]').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => guest.evaluate(async () => {
    let bytes = 0;
    for (const peer of window.__studioQaPeers) for (const row of (await peer.getStats()).values())
      if (row.type === 'inbound-rtp' && (row.kind === 'audio' || row.mediaType === 'audio')) bytes += row.bytesReceived || 0;
    return bytes;
  }), { timeout: 15_000 }).toBeGreaterThan(0);
  report.media = await guest.getByTestId('watch-video').evaluate(video => ({ videoWidth: video.videoWidth, videoHeight: video.videoHeight, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames }));
  record('guest receives decoded video frames and audio RTP');
  stage('live camera and microphone controls');
  await host.getByTestId('studio-mic').click();
  await expect.poll(() => mediaEnabled(host, 'audio')).toBe(false);
  await host.getByTestId('studio-mic').click();
  await expect.poll(() => mediaEnabled(host, 'audio')).toBe(true);
  await host.getByTestId('studio-camera').click();
  await expect.poll(() => mediaEnabled(host, 'video')).toBe(false);
  await host.getByTestId('studio-camera').click();
  await expect.poll(() => mediaEnabled(host, 'video')).toBe(true);
  await expect.poll(() => guest.getByTestId('watch-video').evaluate(video => video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5), { timeout: 15_000 }).toBe(true);
  record('live camera and microphone controls affect real media tracks and video resumes');
  const message = `Studio QA message ${suffix}`;
  await host.getByTestId('chat-input').fill(message);
  await host.getByTestId('chat-send').click();
  await expect(guest.getByRole('log').getByText(message, { exact: true })).toBeVisible();
  const detail = await (await request(`/streams/${streamId}`)).json();
  assert.equal(detail.status, 'LIVE'); assert.equal(detail.publisherConnected, true); assert.ok(detail.viewerCount >= 1);
  await expect.poll(async () => (await host.getByTestId('studio-viewers').textContent()).replace(/[٠-٩]/g, character => '٠١٢٣٤٥٦٧٨٩'.indexOf(character)), { timeout: 15_000 }).toBe(String(detail.viewerCount));
  await host.getByTestId('studio-audience').click();
  await expect(host.getByRole('dialog')).toBeVisible();
  await host.keyboard.press('Escape');
  await expect(host.getByRole('dialog')).toHaveCount(0);
  record('chat delivery and real viewer count work');
  await host.getByTestId('studio-share').click();
  const sharedHref = await host.getByTestId('studio-sharelink').getAttribute('href');
  assert.equal(new URL(sharedHref, base).pathname, sharePath);
  if (await host.getByRole('dialog').count()) await host.keyboard.press('Escape');
  record('share sheet links to actual stream');
  await screenshot(host, 'studio-new-live-ar.png');

  stage('end confirmation and broadcast termination');
  await host.getByTestId('studio-end').click();
  await expect(host.getByTestId('studio-confirm-end')).toBeVisible();
  await host.keyboard.press('Escape');
  await expect(host.getByTestId('studio-confirm-end')).toHaveCount(0);
  assert.equal((await (await request(`/streams/${streamId}`)).json()).status, 'LIVE');
  await host.getByTestId('studio-end').click();
  await host.getByTestId('studio-confirm-end').click();
  await host.waitForURL(`${base}/`);
  await expect(guest.getByRole('heading', { name: 'This moment has ended', exact: true })).toBeVisible({ timeout: 20_000 });
  assert.equal((await (await request(`/streams/${streamId}`)).json()).status, 'ENDED');
  assert.equal(await mediaEnabled(host, 'video'), false);
  assert.equal(await mediaEnabled(host, 'audio'), false);
  record('end confirmation can cancel and confirmed end stops room and capture');
  assert.deepEqual(errors, []);
  report.passed = true;
}

async function cleanup() {
  if (!userId) { report.cleanup.account = 'not created'; return; }
  const account = await fixtureLogin();
  assert.equal(account.user.id, userId);
  const token = account.accessToken;
  const mine = await (await request('/streams/mine', token)).json();
  if (mine.stream?.id) {
    assert.equal(mine.stream.creator.id, userId);
    streamId = mine.stream.id;
  }
  if (streamId) {
    const detail = await (await request(`/streams/${streamId}`)).json();
    assert.equal(detail.creator.id, userId);
    const response = await request(`/streams/${streamId}/end`, token, { method: 'POST' });
    assert.equal(response.status, 201);
  }
  assert.equal((await (await request('/streams/mine', token)).json()).stream, null);
  const deletion = await request('/users/me', token, { method: 'DELETE', body: { password: identity.password } });
  assert.equal(deletion.status, 202);
  assert.equal((await request('/auth/me', token)).status, 401);
  assert.equal((await request(`/users/${identity.username}`)).status, 404);
  report.cleanup = { ownRoomEnded: true, accountDeletionAccepted: true, sessionRevoked: true, profileHidden: true };
}

try { await run(); }
catch (error) {
  report.failure = { phase, type: error?.name || 'Error',
    ...(error?.code === 'ERR_ASSERTION' ? { actualType: typeof error.actual, expectedType: typeof error.expected, actualStatus: typeof error.actual === 'number' ? error.actual : undefined } : {}),
  };
  await screenshot(host, 'studio-new-failure.png').catch(() => undefined);
  console.log(JSON.stringify({ failed: true, phase, type: error?.name || 'Error' }));
} finally {
  try { await cleanup(); } catch (error) { report.cleanup = { failed: true, type: error?.name || 'Error' }; report.passed = false; }
  await browser?.close();
  report.completedAt = new Date().toISOString();
  writeFileSync(`${artifact}/studio-local-qa-result.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checkCount: report.checks.length, cleanup: report.cleanup, screenshots: report.screenshots }));
  process.exitCode = report.passed ? 0 : 1;
}

