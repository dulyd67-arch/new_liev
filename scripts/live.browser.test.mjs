import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

const base = process.env.LIVE_TEST_WEB_URL || 'http://localhost:3000';
const api = process.env.LIVE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1';
assert.ok(process.env.DATABASE_MIGRATION_URL && /test/i.test(new URL(process.env.DATABASE_MIGRATION_URL).pathname),
  'Browser fixtures require the isolated test database.');

test('two browsers: real registration, camera publication, remote video/audio, chat, discovery and ending', { timeout: 150_000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const executable = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ executablePath: executable, headless: true, args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  ] });
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'] });
  const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  for (const context of [hostContext, viewerContext]) await context.addInitScript(() => {
    if (location.protocol.startsWith('http')) localStorage.setItem('livestar-locale', 'en');
  });
  const host = await hostContext.newPage();
  const viewer = await viewerContext.newPage();
  const errors = [];
  host.on('pageerror', error => errors.push(error.message));
  viewer.on('pageerror', error => errors.push(error.message));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const credentials = { email: `broadcast-${suffix}@integration.invalid`, password: `CameraFixture_${suffix}!` };
  let streamId;

  async function register(page, prefix, auth) {
    await page.goto(`${base}/register`);
    await page.locator('input[name="displayName"]').fill(`${prefix} live test`);
    await page.locator('input[name="username"]').fill(`${prefix}_${suffix}`);
    await page.locator('input[name="email"]').fill(auth.email);
    await page.locator('input[name="password"]').fill(auth.password);
    await page.locator('input[name="birthDate"]').fill('1990-01-01');
    await page.locator('input[name="accept"]').check();
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole('link', { name: 'Account settings' })).toBeVisible({ timeout: 20_000 });
  }

  try {
    await register(host, 'host', credentials);
    await register(viewer, 'viewer', { email: `watch-${suffix}@integration.invalid`, password: credentials.password });
    await host.goto(`${base}/go-live`);
    await expect(host.getByTestId('studio-title')).toBeVisible({ timeout: 15_000 });
    await host.getByTestId('studio-title').fill(`A real live moment ${suffix}`);
    await host.getByTestId('studio-preview').click();
    await expect(host.getByTestId('studio-start')).toBeEnabled({ timeout: 15_000 });
    const reservedRoom = host.waitForResponse(response => response.url().endsWith('/api/v1/streams') && response.request().method() === 'POST');
    await host.getByTestId('studio-start').click();
    const reservation = await (await reservedRoom).json();
    streamId = reservation.stream?.id;
    await expect(host.getByTestId('studio-end')).toBeVisible({ timeout: 30_000 });
    const shareLink = await host.getByTestId('studio-sharelink').getAttribute('href');
    assert.match(shareLink, /^\/live\/[0-9a-f-]{36}$/);
    streamId = shareLink.split('/').at(-1);
    await host.screenshot({ path: 'artifacts/live-studio.png', fullPage: true });

    await viewer.goto(`${base}${shareLink}`);
    await expect.poll(() => viewer.getByTestId('watch-video').evaluate(video => video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5),
      { timeout: 30_000 }).toBe(true);
    await expect.poll(() => viewer.locator('audio[data-stream-audio]').count(), { timeout: 15_000 }).toBeGreaterThan(0);

    const chat = `Hello from the other browser ${suffix}`;
    await viewer.getByTestId('chat-input').fill(chat);
    await viewer.getByTestId('chat-send').click();
    await expect(host.getByRole('log').getByText(chat, { exact: true })).toBeVisible({ timeout: 12_000 });
    await viewer.screenshot({ path: 'artifacts/live-watch.png', fullPage: true });

    const discovery = await viewerContext.newPage();
    await discovery.goto(base);
    await expect(discovery.getByRole('heading', { name: `A real live moment ${suffix}` })).toBeVisible({ timeout: 15_000 });
    const actual = await discovery.request.get(`${base}/api/v1/streams/${streamId}`);
    const state = await actual.json();
    assert.equal(state.status, 'LIVE');
    assert.equal(state.publisherConnected, true);
    assert.ok(state.viewerCount >= 1, 'Viewers are counted from actual media-server participants.');
    await discovery.setViewportSize({ width: 390, height: 844 });
    assert.ok(await discovery.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile layout must fit the viewport.');
    await discovery.screenshot({ path: 'artifacts/live-mobile.png', fullPage: true });
    await discovery.close();

    await host.getByTestId('studio-end').click();
    await expect(host.getByRole('dialog')).toBeVisible();
    await host.getByTestId('studio-confirm-end').click();
    await expect(host).toHaveURL(new URL('/', base).toString(), { timeout: 15_000 });
    await expect(viewer.getByRole('heading', { name: 'This moment has ended', exact: true })).toBeVisible({ timeout: 20_000 });
    assert.equal((await (await viewer.request.get(`${base}/api/v1/streams/${streamId}`)).json()).status, 'ENDED');
    assert.deepEqual(errors, [], 'No unhandled application JavaScript errors are allowed.');
    writeFileSync('artifacts/live-browser-result.json', JSON.stringify({
      passed: true, transport: 'WebRTC via actual LiveKit server', capture: 'Chromium synthetic camera and microphone test devices',
      verified: ['web registration', 'camera and microphone publish', 'remote decoded video frames', 'remote audio track', 'cross-browser chat', 'actual viewers', 'mobile layout', 'stream ended'],
      recordedAt: new Date().toISOString(),
    }, null, 2));
    console.log('Real WebRTC video frames and audio tracks arrived in the second browser; chat and stream stopping passed.');
  } catch (error) {
    await host.screenshot({ path: 'artifacts/live-failure-host.png', fullPage: true }).catch(() => undefined);
    await viewer.screenshot({ path: 'artifacts/live-failure-viewer.png', fullPage: true }).catch(() => undefined);
    console.error('Browser URL:', host.url(), 'Visible error:', await host.getByRole('alert').allTextContents().catch(() => []));
    throw error;
  } finally {
    if (streamId) {
      try {
        const response = await fetch(`${api}/auth/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
        const account = await response.json();
        if (account.accessToken) await fetch(`${api}/streams/${streamId}/end`, { method: 'POST', headers: { Authorization: `Bearer ${account.accessToken}` } });
      } catch { /* The room also has provider-side departure expiry. */ }
    }
    await browser.close();
  }
});
