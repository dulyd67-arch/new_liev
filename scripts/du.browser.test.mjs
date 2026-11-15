import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

// Browser regression is deliberately local-only, including every database and
// media endpoint. It never uses a cloud identity, balance, room or credential.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function localUrl(raw, protocols, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid local test URL.`); }
  assert.ok(protocols.includes(url.protocol) && loopback.has(url.hostname.toLowerCase()), `${label} must use loopback; cloud browser fixtures are forbidden.`);
  return url;
}
const migration = localUrl(process.env.DATABASE_MIGRATION_URL, ['postgres:', 'postgresql:'], 'DATABASE_MIGRATION_URL');
const runtime = localUrl(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'DATABASE_URL');
assert.match(decodeURIComponent(migration.pathname), /(?:^|[_-])test(?:$|[_-])/i, 'Use an isolated test database.');
assert.equal(runtime.pathname, migration.pathname); assert.equal(runtime.port, migration.port);
assert.equal(decodeURIComponent(runtime.username), 'livestar_app');
const webUrl = localUrl(process.env.DU_TEST_WEB_URL || process.env.LIVE_TEST_WEB_URL || 'http://localhost:3000', ['http:', 'https:'], 'DU_TEST_WEB_URL');
const apiUrl = localUrl(process.env.DU_TEST_API_URL || process.env.LIVE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'DU_TEST_API_URL');
assert.equal(webUrl.pathname.replace(/\/$/, ''), ''); assert.equal(apiUrl.pathname.replace(/\/$/, ''), '/api/v1');
for (const url of [webUrl, apiUrl]) assert.ok(!url.username && !url.password && !url.search && !url.hash);
localUrl(process.env.LIVEKIT_URL, ['ws:', 'wss:'], 'LIVEKIT_URL');
localUrl(process.env.LIVEKIT_API_URL, ['http:', 'https:'], 'LIVEKIT_API_URL');
const base = webUrl.origin, api = apiUrl.origin + '/api/v1';
const artifact = resolve(process.cwd(), 'artifacts');

async function request(path, token, { method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
async function login(identity) {
  const result = await request('/auth/mobile/login', undefined, { method: 'POST', body: { email: identity.email, password: identity.password } });
  assert.equal(result.status, 200, 'An independent ordinary session is required for observing fixture state.');
  return result.data;
}

test('mobile AR/EN: persistent DU wallet, actual gifts and immersive live viewing', { timeout: 210_000 }, async () => {
  mkdirSync(artifact, { recursive: true });
  const report = { localOnly: true, passed: false, checks: [], screenshots: [], cleanup: {}, startedAt: new Date().toISOString() };
  const accounts = [];
  const errors = [];
  let browser, host, viewer, streamId;
  let phase = 'launch';
  const record = name => { report.checks.push(name); console.log(JSON.stringify({ check: name, ok: true })); };
  const stage = name => { phase = name; console.log(JSON.stringify({ phase })); };
  async function screenshot(page, name) {
    await page.screenshot({ path: resolve(artifact, name), fullPage: true });
    report.screenshots.push(name);
  }
  async function fits(page) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile content must fit without horizontal scrolling.');
  }
  async function register(page, label) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const identity = { email: `du-browser-${suffix}@integration.invalid`, username: `duweb_${suffix}`, password: `DuBrowser_${suffix}!` };
    await page.goto(`${base}/register`);
    assert.equal(new URL(page.url()).origin, base);
    await page.locator('input[name="displayName"]').fill(`DU ${label}`);
    await page.locator('input[name="username"]').fill(identity.username);
    await page.locator('input[name="email"]').fill(identity.email);
    await page.locator('input[name="password"]').fill(identity.password);
    await page.locator('input[name="birthDate"]').fill('1990-01-01');
    await page.locator('input[name="accept"]').check();
    const registration = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST');
    await page.locator('button[type="submit"]').click();
    const response = await registration;
    assert.equal(response.status(), 201);
    const result = await response.json();
    const account = { identity, userId: result.user.id };
    accounts.push(account);
    await expect(page).not.toHaveURL(/\/register$/);
    account.session = await login(identity);
    assert.equal(account.session.user.id, account.userId);
    return account;
  }

  try {
    const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true, args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    ] });
    const hostContext = await browser.newContext({ viewport: { width: 1280, height: 950 }, permissions: ['camera', 'microphone'] });
    const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    for (const [context, locale] of [[hostContext, 'en'], [viewerContext, 'ar']]) {
      context.setDefaultTimeout(20_000);
      await context.addInitScript(locale => {
        if (location.protocol.startsWith('http') && !localStorage.getItem('livestar-locale')) localStorage.setItem('livestar-locale', locale);
      }, locale);
    }
    host = await hostContext.newPage(); viewer = await viewerContext.newPage();
    for (const page of [host, viewer]) page.on('pageerror', error => errors.push(error.message));
    host.on('response', response => {
      if (response.url().endsWith('/api/v1/streams') && response.request().method() === 'POST' && response.ok())
        void response.json().then(body => { streamId = body.stream?.id || streamId; }).catch(() => undefined);
    });
    stage('normal web registration');
    const hostAccount = await register(host, 'browser broadcaster');
    const viewerAccount = await register(viewer, 'browser viewer');
    record('two ordinary members register with separate authenticated sessions');

    stage('mobile Arabic wallet and one-time claim');
    await viewer.goto(`${base}/wallet`);
    await viewer.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await expect(viewer.getByTestId('wallet-balance')).toContainText(/0|٠/);
    await expect(viewer.getByTestId('wallet-balance')).toContainText('DU');
    await expect(viewer.getByTestId('wallet-claim')).toBeEnabled();
    await expect(viewer.getByTestId('wallet-history').locator('article')).toHaveCount(0);
    assert.equal(await viewer.evaluate(() => document.documentElement.dir), 'rtl');
    await fits(viewer);
    await screenshot(viewer, 'du-wallet-empty-ar.png');
    const claiming = viewer.waitForResponse(response => response.url().endsWith('/api/v1/wallet/claim') && response.request().method() === 'POST');
    await viewer.getByTestId('wallet-claim').click();
    const claimResponse = await claiming;
    assert.equal(claimResponse.status(), 200);
    const claimed = await claimResponse.json();
    assert.equal(claimed.wallet.balance, '100');
    await expect(viewer.getByTestId('wallet-claim-success')).toBeVisible();
    await expect(viewer.getByTestId('wallet-balance')).toContainText(/100|١٠٠/);
    await expect(viewer.getByTestId('wallet-history')).toContainText(/100|١٠٠/);
    await screenshot(viewer, 'du-wallet-claimed-ar.png');
    await viewer.reload();
    await expect(viewer.getByTestId('wallet-balance')).toContainText(/100|١٠٠/);
    await expect(viewer.getByTestId('wallet-claim')).toBeDisabled();
    assert.equal((await request('/wallet', viewerAccount.session.accessToken)).data.claimAvailable, false);
    await viewer.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await expect.poll(() => viewer.evaluate(() => document.documentElement.dir)).toBe('ltr');
    await expect(viewer.getByTestId('wallet-history')).toContainText(/100/);
    await fits(viewer); await screenshot(viewer, 'du-wallet-claimed-en.png');
    record('wallet starts at zero, claims 100 DU once and persists its actual history in Arabic and English');

    stage('publish a real local stream');
    await host.goto(`${base}/go-live`);
    await host.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await host.getByTestId('studio-title').fill(`DU browser live ${randomUUID().slice(0, 8)}`);
    await host.getByTestId('studio-preview').click();
    await expect(host.getByTestId('studio-start')).toBeEnabled();
    const activation = host.waitForResponse(response => /\/api\/v1\/streams\/[^/]+\/activate$/.test(response.url()) && response.request().method() === 'POST', { timeout: 40_000 });
    await host.getByTestId('studio-start').click();
    assert.equal((await activation).status(), 201);
    await expect(host.getByTestId('studio-end')).toBeVisible();
    assert.ok(streamId);
    await viewer.goto(`${base}/live/${streamId}`);
    await viewer.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await expect.poll(() => viewer.getByTestId('watch-video').evaluate(video => video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => viewer.locator('audio[data-stream-audio]').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const detail = await request(`/streams/${streamId}`);
    assert.equal(detail.data.status, 'LIVE'); assert.equal(detail.data.publisherConnected, true);
    await fits(viewer);
    const stageBox = await viewer.getByTestId('watch-stage').boundingBox();
    assert.ok(stageBox && stageBox.height >= 800 && stageBox.width >= 380, 'The phone watch stage must fill the viewport.');
    await screenshot(viewer, 'du-watch-mobile-en.png');
    record('mobile watch fills the screen and receives actual local WebRTC video and audio');

    stage('follow controls and persistent report');
    await expect(viewer.getByTestId('watch-follow')).toHaveAttribute('aria-pressed', 'false');
    await viewer.getByTestId('watch-follow').click();
    await expect(viewer.getByTestId('watch-follow')).toHaveAttribute('aria-pressed', 'true');
    assert.equal((await request(`/social/${hostAccount.userId}`, viewerAccount.session.accessToken)).data.following, true);
    await viewer.getByTestId('watch-follow').click();
    await expect(viewer.getByTestId('watch-follow')).toHaveAttribute('aria-pressed', 'false');
    assert.equal((await request(`/social/${hostAccount.userId}`, viewerAccount.session.accessToken)).data.following, false);
    await viewer.getByTestId('watch-more').click();
    await viewer.getByRole('button', { name: 'Report inappropriate content', exact: true }).click();
    await viewer.getByRole('textbox', { name: 'What is the reason for this report?', exact: true }).fill('Local browser regression fixture: verify reporting reaches moderator review.');
    const reporting = viewer.waitForResponse(response => response.url().endsWith(`/api/v1/streams/${streamId}/report`) && response.request().method() === 'POST');
    await viewer.getByRole('button', { name: 'Submit report', exact: true }).click();
    const reportResponse = await reporting;
    assert.equal(reportResponse.status(), 200);
    const receipt = await reportResponse.json();
    assert.equal(receipt.status, 'OPEN'); assert.match(receipt.id, /^[0-9a-f-]{36}$/);
    await expect(viewer.getByText('Your report was submitted for review.', { exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
    assert.equal((await request(`/streams/${streamId}`)).data.status, 'LIVE');
    record('follow and unfollow persist, and reporting creates an actual open moderation receipt');

    stage('choose and send an actual gift');
    const catalog = (await request('/gifts')).data;
    const affordable = [...catalog.items].filter(gift => BigInt(gift.price) <= 100n).sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)));
    assert.ok(affordable.length >= 2, 'A claimed wallet must offer several real gift choices.');
    const gift = affordable[1];
    await viewer.getByTestId('gift-trigger').click();
    await expect(viewer.getByTestId('gift-dialog')).toBeVisible();
    await expect(viewer.getByTestId('gift-balance')).toContainText('100');
    await viewer.getByTestId(`gift-item-${gift.slug}`).click();
    await expect(viewer.getByTestId(`gift-item-${gift.slug}`)).toHaveAttribute('aria-pressed', 'true');
    await screenshot(viewer, 'du-gift-picker-mobile-en.png');
    const sending = viewer.waitForResponse(response => response.url().endsWith(`/api/v1/streams/${streamId}/gifts`) && response.request().method() === 'POST');
    await viewer.getByTestId('gift-send').click();
    const sentResponse = await sending;
    assert.equal(sentResponse.status(), 200);
    const sent = await sentResponse.json();
    assert.equal(sent.transaction.gift.id, gift.id); assert.equal(sent.transaction.quantity, 1);
    assert.equal(sent.wallet.balance, String(100n - BigInt(gift.price)));
    await expect(viewer.getByTestId('gift-success')).toBeVisible();
    await expect.poll(async () => (await request('/wallet', viewerAccount.session.accessToken)).data.balance).toBe(sent.wallet.balance);
    await expect.poll(async () => (await request('/wallet', hostAccount.session.accessToken)).data.receivedCoins).toBe(gift.price);
    // Host view is a separate browser context; this must arrive through the
    // persisted event feed rather than the sender's immediate success state.
    await expect(host.getByTestId('gift-feed')).toContainText('DU browser viewer', { timeout: 15_000 });
    await screenshot(host, 'du-gift-received-host.png');
    if (await viewer.getByTestId('gift-dialog').isVisible()) await viewer.keyboard.press('Escape');
    await expect(viewer.getByTestId('gift-dialog')).toHaveCount(0);
    await expect(viewer.getByTestId('gift-trigger')).toBeFocused();
    record('gift selection spends the exact DU price once and another browser receives the committed gift event');

    stage('full screen and Arabic gift sheet');
    await viewer.getByTestId('watch-more').click();
    await viewer.getByTestId('watch-fullscreen').click();
    await expect.poll(() => viewer.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await fits(viewer);
    await screenshot(viewer, 'du-watch-fullscreen.png');
    await viewer.getByTestId('gift-trigger').click();
    await expect(viewer.getByTestId('gift-dialog')).toBeVisible();
    assert.equal(await viewer.getByTestId('gift-dialog').evaluate(element => document.fullscreenElement?.contains(element)), true,
      'The gift sheet must render inside the active fullscreen player.');
    await screenshot(viewer, 'du-gift-picker-fullscreen.png');
    await viewer.getByRole('button', { name: 'Close gifts', exact: true }).click();
    await expect(viewer.getByTestId('gift-dialog')).toHaveCount(0);
    await viewer.evaluate(() => document.exitFullscreen());
    await viewer.goto(`${base}/wallet`);
    await expect(viewer.getByTestId('wallet-balance')).toContainText(sent.wallet.balance);
    await expect(viewer.getByTestId('wallet-history')).toContainText(gift.nameEn);
    await screenshot(viewer, 'du-wallet-history-en.png');
    await viewer.getByRole('button', { name: 'التبديل إلى العربية', exact: true }).click();
    await expect.poll(() => viewer.evaluate(() => document.documentElement.dir)).toBe('rtl');
    await expect(viewer.getByTestId('wallet-history')).toContainText(gift.nameAr);
    await screenshot(viewer, 'du-wallet-history-ar.png');
    await viewer.goto(`${base}/live/${streamId}`);
    await viewer.getByTestId('gift-trigger').click();
    await expect(viewer.getByTestId('gift-dialog')).toBeVisible();
    await expect(viewer.getByTestId(`gift-item-${gift.slug}`)).toContainText(gift.nameAr);
    await fits(viewer); await screenshot(viewer, 'du-gift-picker-mobile-ar.png');
    await viewer.keyboard.press('Escape');
    record('full screen works, deducted wallet history persists, and the gift picker supports Arabic RTL');

    stage('end stream and prevent additional gifting');
    await host.getByTestId('studio-end').click();
    await host.getByTestId('studio-confirm-end').click();
    await expect(host).toHaveURL(`${base}/`);
    await expect(viewer.getByRole('heading', { name: 'انتهت هذه اللحظة', exact: true })).toBeVisible({ timeout: 20_000 });
    assert.equal((await request(`/streams/${streamId}`)).data.status, 'ENDED');
    const giftButtons = viewer.getByTestId('gift-trigger');
    if (await giftButtons.count()) await expect(giftButtons).toBeDisabled();
    const finalWallet = await request('/wallet', viewerAccount.session.accessToken);
    assert.equal(finalWallet.data.balance, sent.wallet.balance);
    const history = await request('/wallet/history', viewerAccount.session.accessToken);
    assert.equal(history.data.items.length, 2); assert.equal(history.data.items[0].id, sent.transaction.id);
    assert.deepEqual(errors, [], 'The complete flow must have no unhandled application JavaScript errors.');
    record('ended streams stop gifting and the wallet retains exactly the real claim and gift');
    report.passed = true;
  } catch (error) {
    report.failure = { phase, type: error?.name || 'Error', message: error.message?.slice(0, 500) };
    await screenshot(viewer, 'du-browser-failure-viewer.png').catch(() => undefined);
    await screenshot(host, 'du-browser-failure-host.png').catch(() => undefined);
    throw error;
  } finally {
    try {
      const cleanup = await Promise.allSettled(accounts.map(async account => {
        const session = await login(account.identity);
        const mine = await request('/streams/mine', session.accessToken);
        if (mine.data.stream) {
          assert.equal(mine.data.stream.creator.id, account.userId);
          assert.equal((await request(`/streams/${mine.data.stream.id}/end`, session.accessToken, { method: 'POST' })).status, 201);
        }
        assert.equal((await request('/users/me', session.accessToken, { method: 'DELETE', body: { password: account.identity.password } })).status, 202);
        assert.equal((await request('/auth/me', session.accessToken)).status, 401);
        assert.equal((await request(`/users/${account.identity.username}`)).status, 404);
      }));
      const failures = cleanup.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'DU browser fixture cleanup failed.');
      report.cleanup = { ownRoomsEnded: true, fixtureAccountsSoftDeleted: accounts.length, sessionsRevoked: true };
    } catch (error) {
      report.cleanup = { failed: true, type: error.name, message: error.message?.slice(0, 300) }; report.passed = false;
      throw error;
    } finally {
      await browser?.close();
      report.completedAt = new Date().toISOString();
      writeFileSync(resolve(artifact, 'du-browser-result.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, cleanup: report.cleanup, screenshots: report.screenshots }));
    }
  }
});
