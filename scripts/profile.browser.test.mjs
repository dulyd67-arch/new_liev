import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';

// Real local identities and HTTP mutations only. No cloud identities, media,
// artificial financial transactions or published demo profiles are created.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function localUrl(raw, protocols, label) {
  let value;
  try { value = new URL(raw); } catch { throw new Error(`${label} must be a valid local test URL.`); }
  assert.ok(protocols.includes(value.protocol) && loopback.has(value.hostname.toLowerCase()), `${label} must use loopback.`);
  return value;
}
const migration = localUrl(process.env.DATABASE_MIGRATION_URL, ['postgres:', 'postgresql:'], 'DATABASE_MIGRATION_URL');
const runtime = localUrl(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'DATABASE_URL');
assert.match(decodeURIComponent(migration.pathname), /(?:^|[_-])test(?:$|[_-])/i);
assert.equal(runtime.pathname, migration.pathname); assert.equal(runtime.port, migration.port);
assert.equal(decodeURIComponent(runtime.username), 'livestar_app');
const web = localUrl(process.env.PROFILE_TEST_WEB_URL || 'http://localhost:3000', ['http:', 'https:'], 'PROFILE_TEST_WEB_URL');
const api = localUrl(process.env.PROFILE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'PROFILE_TEST_API_URL');
assert.equal(web.pathname.replace(/\/$/, ''), ''); assert.equal(api.pathname.replace(/\/$/, ''), '/api/v1');
for (const url of [web, api]) assert.ok(!url.username && !url.password && !url.search && !url.hash);
const base = web.origin, apiBase = api.origin + '/api/v1';
const pool = new pg.Pool({ connectionString: migration.href, max: 2 });
const artifact = resolve(process.cwd(), 'artifacts');

async function request(path, token, { method = 'GET', body } = {}) {
  const response = await fetch(apiBase + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
function ok(result, label = 'request') { assert.equal(result.status, 200, `${label}: HTTP ${result.status}`); return result.data; }
function png() {
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  }
  const width = 64, height = 64, header = Buffer.alloc(13), scanlines = Buffer.alloc(height * (width * 4 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    scanlines[offset] = x + 90; scanlines[offset + 1] = y + 40; scanlines[offset + 2] = 170; scanlines[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

test('Profile browser: real photo editing, social interactions, sharing, navigation and bilingual responsive views', { timeout: 180_000 }, async () => {
  mkdirSync(artifact, { recursive: true });
  const report = { localOnly: true, passed: false, checks: [], screenshots: [], cleanup: {}, startedAt: new Date().toISOString() };
  const accounts = [], errors = [], pages = [], sessions = [];
  let browser, phase = 'launch';
  const stage = value => { phase = value; console.log(JSON.stringify({ phase })); };
  const record = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
  async function shot(page, name) { await page.screenshot({ path: resolve(artifact, name), fullPage: true }); report.screenshots.push(name); }
  async function fits(page, label) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ' must fit without horizontal scrolling.'); }
  async function register(page, name) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const identity = { email: `profile-browser-${suffix}@integration.invalid`, username: `prweb_${suffix}`, password: `ProfileBrowser_${suffix}!` };
    await page.goto(base + '/register');
    await page.locator('input[name="displayName"]').fill(name);
    await page.locator('input[name="username"]').fill(identity.username);
    await page.locator('input[name="email"]').fill(identity.email);
    await page.locator('input[name="password"]').fill(identity.password);
    await page.locator('input[name="birthDate"]').fill('1990-01-01');
    await page.locator('input[name="accept"]').check();
    const registering = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST');
    await page.locator('button[type="submit"]').click();
    const response = await registering; assert.equal(response.status(), 201);
    const result = await response.json();
    const account = { ...result, identity }; accounts.push(account);
    assert.ok(account.accessToken && account.user.id);
    await expect(page).not.toHaveURL(/\/register$/);
    // Browser reloads rotate its WEB session. Keep an independent MOBILE
    // observer session so those legitimate rotations cannot break cleanup.
    account.observer = ok(await request('/auth/mobile/login', undefined, { method: 'POST', body: { email: identity.email, password: identity.password } }), 'independent fixture session');
    assert.equal(account.observer.user.id, account.user.id);
    return account;
  }
  async function publicProfile(account) { return ok(await request(`/users/${account.identity.username}`), 'public profile'); }
  async function waitAvatar(page) {
    const image = page.getByTestId('profile-avatar').locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth > 0).catch(() => false)).toBe(true);
  }
  async function save(page) {
    const saving = page.waitForResponse(response => response.url().endsWith('/api/v1/users/me') && response.request().method() === 'PATCH');
    await page.getByTestId('profile-save').click(); assert.equal((await saving).status(), 200);
    await expect(page.getByTestId('profile-edit-dialog')).toHaveCount(0);
  }
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }, { width: 320, height: 780 }]) {
      const context = await browser.newContext({ viewport, locale: 'ar', permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' }); sessions.push(context);
      context.setDefaultTimeout(20_000);
      await context.addInitScript(() => { if (location.protocol.startsWith('http') && !localStorage.getItem('livestar-locale')) localStorage.setItem('livestar-locale', 'ar'); });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (['http:', 'https:'].includes(url.protocol) && !loopback.has(url.hostname.toLowerCase())) { errors.push('Unexpected nonlocal request: ' + url.origin); return route.abort('blockedbyclient'); }
        if (/\/(?:token|activate|host-token)(?:\/|$)/.test(url.pathname)) { errors.push('Unexpected media endpoint: ' + url.pathname); return route.abort('blockedbyclient'); }
        return route.continue();
      });
      await context.routeWebSocket(/.*/, socket => { errors.push('Unexpected WebSocket'); socket.close(); });
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
    }
    const [authorPage, visitorPage, thirdPage, anonymous] = pages;
    stage('three ordinary independent web sessions');
    const author = await register(authorPage, 'ليان أحمد');
    const visitor = await register(visitorPage, 'محمد علي');
    const third = await register(thirdPage, 'سارة خالد');
    await authorPage.goto(base + '/profile');
    await expect(authorPage).toHaveURL(new RegExp(`/u/${author.identity.username}$`));
    await expect(authorPage.getByTestId('profile-edit')).toBeVisible();
    await expect(authorPage.getByTestId('profile-follow')).toHaveCount(0);
    await fits(authorPage, 'Own mobile profile');
    record('normal members have independent sessions, and /profile opens the signed-in owner profile');

    stage('real owned profile edit and safe photo upload');
    await authorPage.getByTestId('profile-edit').click();
    const editor = authorPage.getByTestId('profile-edit-dialog'); await expect(editor).toBeVisible();
    await authorPage.getByTestId('profile-edit-avatar').setInputFiles({ name: 'blocked.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(editor.getByRole('alert')).toContainText(/JPG|PNG|WebP/);
    await authorPage.getByTestId('profile-edit-avatar').setInputFiles({ name: 'profile.png', mimeType: 'image/png', buffer: png() });
    await expect(authorPage.getByTestId('profile-save')).toBeEnabled();
    const biography = 'أشارك الموسيقى والحوار مع جمهوري. <img src=x onerror=window.__profileXss=1>';
    await authorPage.getByTestId('profile-edit-name').fill('ليان أحمد');
    await authorPage.getByTestId('profile-edit-bio').fill(biography);
    await save(authorPage);
    await expect(authorPage.getByTestId('profile-name')).toHaveText('ليان أحمد');
    await expect(authorPage.getByTestId('profile-bio')).toHaveText(biography);
    await expect(authorPage.getByTestId('profile-bio').locator('img')).toHaveCount(0);
    assert.equal(await authorPage.evaluate(() => window.__profileXss), undefined);
    await waitAvatar(authorPage);
    const stored = await publicProfile(author);
    assert.match(stored.avatarUrl, /^\/api\/v1\/users\//); assert.equal(stored.avatarKey, null);
    await authorPage.reload(); await waitAvatar(authorPage);
    assert.equal((await publicProfile(author)).bio, biography);
    // Keep the final visual specimen readable after proving untrusted text is
    // rendered literally; this is a real update to this test's own profile.
    await authorPage.getByTestId('profile-edit').click();
    await authorPage.getByTestId('profile-edit-bio').fill('أشارك الموسيقى والحوار مع جمهوري. لحظات مباشرة تجمعنا.');
    await save(authorPage); await waitAvatar(authorPage);
    record('owner edits persist after reload, rejected SVG stays local, the real photo decodes, and bio text cannot inject HTML');

    stage('actual follows and public lists');
    await visitorPage.goto(`${base}/u/${author.identity.username}`);
    await expect(visitorPage.getByTestId('profile-follow')).toBeEnabled();
    await visitorPage.getByTestId('profile-follow').click();
    await expect.poll(async () => (await publicProfile(author)).followerCount).toBe(1);
    assert.equal(ok(await request(`/social/${author.user.id}/follow`, third.observer.accessToken, { method: 'POST', body: {} })).following, true);
    await visitorPage.reload();
    await expect(visitorPage.getByTestId('profile-followers')).toContainText(/2|٢/);
    await visitorPage.getByTestId('profile-followers').click();
    const members = visitorPage.getByTestId('profile-members-dialog');
    await expect(members).toBeVisible();
    await expect(members.locator('a[href^="/u/"]')).toHaveCount(2);
    await expect(members).toContainText(visitor.identity.username); await expect(members).toContainText(third.identity.username);
    await visitorPage.keyboard.press('Escape');
    await expect(members).toHaveCount(0); await expect(visitorPage.getByTestId('profile-followers')).toBeFocused();
    await visitorPage.getByTestId('profile-follow').click();
    await expect.poll(async () => (await publicProfile(author)).followerCount).toBe(1);
    await expect(visitorPage.getByTestId('profile-follow')).toContainText('متابعة');
    await visitorPage.getByTestId('profile-follow').click();
    await expect.poll(async () => (await publicProfile(author)).followerCount).toBe(2);
    await expect(visitorPage.getByTestId('profile-edit')).toHaveCount(0);
    record('visitor follows and unfollows the real owner; active public lists and counts agree and dialogs restore keyboard focus');

    stage('completed session history is metadata, not a playable recording');
    const sessionId = randomUUID();
    await pool.query("INSERT INTO live_streams(id,creator_id,title,category,status,livekit_room,started_at,ended_at) VALUES($1,$2,$3,'music','ENDED',$4,clock_timestamp()-interval '30 minutes',clock_timestamp()-interval '5 minutes')", [sessionId, author.user.id, 'جلسة موسيقى وحوار', `profile-browser-${sessionId}`]);
    await authorPage.reload(); await waitAvatar(authorPage);
    await expect(authorPage.getByTestId('profile-history').locator('article')).toHaveCount(1);
    await expect(authorPage.getByTestId('profile-history')).toContainText('جلسة موسيقى وحوار');
    await expect(authorPage.getByTestId('profile-history').locator('a,video')).toHaveCount(0);
    await expect(authorPage.getByTestId('profile-broadcast-count')).toContainText(/1|١/);
    await fits(authorPage, 'Arabic owner profile'); await shot(authorPage, 'profile-owner-mobile-ar.png');
    await authorPage.setViewportSize({ width: 1440, height: 1000 });
    await fits(authorPage, 'Desktop owner profile'); await shot(authorPage, 'profile-owner-desktop-ar.png');
    await authorPage.setViewportSize({ width: 320, height: 780 });
    await fits(authorPage, '320px owner profile'); await shot(authorPage, 'profile-owner-mobile-320-ar.png');
    await authorPage.getByTestId('profile-tab-about').click();
    await expect(authorPage.locator('#profile-about-panel')).toContainText('ليان أحمد');
    await authorPage.getByTestId('profile-tab-about').press('ArrowLeft');
    await expect(authorPage.getByTestId('profile-tab-streams')).toHaveAttribute('aria-selected', 'true');
    record('real completed session metadata and counts render without recording controls; AR mobile, narrow and desktop layouts fit');

    stage('English visitor, owner navigation and sharing');
    await visitorPage.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await expect(visitorPage.locator('html')).toHaveAttribute('dir', 'ltr');
    await fits(visitorPage, 'English visitor profile'); await shot(visitorPage, 'profile-visitor-mobile-en.png');
    const navigation = visitorPage.getByTestId('home-mobile-navigation');
    await expect(navigation.locator(`a[href="/u/${visitor.identity.username}"]`)).toBeVisible();
    await navigation.locator(`a[href="/u/${visitor.identity.username}"]`).click();
    await expect(visitorPage).toHaveURL(new RegExp(`/u/${visitor.identity.username}$`));
    await expect(visitorPage.getByTestId('profile-edit')).toBeVisible();
    await visitorPage.getByRole('link', { name: 'Account settings', exact: true }).click();
    await expect(visitorPage).toHaveURL(/\/settings$/);
    await expect(visitorPage.locator('input[type="email"]')).toHaveValue(visitor.identity.email);
    await visitorPage.getByRole('link', { name: 'My profile', exact: true }).click();
    await expect(visitorPage).toHaveURL(new RegExp(`/u/${visitor.identity.username}$`));
    await authorPage.setViewportSize({ width: 390, height: 844 });
    await authorPage.bringToFront();
    // Exercise the real clipboard fallback without opening an OS share sheet.
    await authorPage.evaluate(() => Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }));
    await authorPage.getByTestId('profile-share').click();
    await expect(authorPage.getByTestId('profile-status')).toContainText('تم نسخ');
    assert.equal(await authorPage.evaluate(() => navigator.clipboard.readText()), `${base}/u/${author.identity.username}`);
    record('English layout, own-profile navigation, settings and copied profile sharing all work with the actual identity');

    stage('anonymous access, missing profiles, photo removal and dialog cancel');
    await anonymous.goto(`${base}/u/${author.identity.username}`);
    await expect(anonymous.getByTestId('profile-follow')).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent(`/u/${author.identity.username}`)}`);
    await expect(anonymous.getByTestId('profile-edit')).toHaveCount(0);
    await fits(anonymous, 'Anonymous narrow profile'); await shot(anonymous, 'profile-anonymous-mobile-ar.png');
    await anonymous.goto(`${base}/u/missing_${randomUUID().replaceAll('-', '').slice(0, 12)}`);
    await expect(anonymous.getByTestId('profile-not-found')).toBeVisible();
    await authorPage.getByTestId('profile-edit').click();
    await authorPage.keyboard.press('Escape');
    await expect(authorPage.getByTestId('profile-edit-dialog')).toHaveCount(0); await expect(authorPage.getByTestId('profile-edit')).toBeFocused();
    await authorPage.getByTestId('profile-edit').click();
    await authorPage.getByTestId('profile-remove-avatar').click(); await save(authorPage);
    await expect(authorPage.getByTestId('profile-avatar').locator('img')).toHaveCount(0);
    assert.equal((await publicProfile(author)).avatarUrl, null);
    for (const page of [authorPage, visitorPage, anonymous]) assert.doesNotMatch(await page.locator('body').innerText(), /\b(?:OpenAI|ChatGPT|Codex|AI-generated|AI-powered|prototype)\b|مصمم بالذكاء|الذكاء الاصطناعي/i);
    record('anonymous follows require login, missing profiles recover clearly, owner cancellation restores focus, and photo removal persists');
    assert.deepEqual(errors, [], 'Profile flow must not emit unhandled browser errors or attempt cloud/media traffic.');
    report.passed = true;
  } catch (error) {
    report.failure = { phase, message: String(error.message || error).slice(0, 1200) };
    for (const [index, page] of pages.entries()) await shot(page, `profile-failure-${index}.png`).catch(() => {});
    throw error;
  } finally {
    await browser?.close().catch(error => errors.push(error.message));
    const failures = [];
    for (const account of accounts) {
      try {
        const session = account.observer || ok(await request('/auth/mobile/login', undefined, { method: 'POST', body: { email: account.identity.email, password: account.identity.password } }), 'cleanup login');
        assert.equal((await request('/users/me', session.accessToken, { method: 'DELETE', body: { password: account.identity.password } })).status, 202);
        assert.equal((await request('/auth/me', session.accessToken)).status, 401);
      } catch (error) { failures.push(error.message); }
    }
    await pool.end();
    report.browserErrors = errors;
    report.cleanup = { passed: failures.length === 0, accounts: accounts.length, errors: failures };
    report.passed = report.passed && report.cleanup.passed && errors.length === 0;
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(artifact, 'profile-browser-result.json'), JSON.stringify(report, null, 2) + '\n');
    if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), 'Profile browser fixture cleanup failed.');
  }
});
