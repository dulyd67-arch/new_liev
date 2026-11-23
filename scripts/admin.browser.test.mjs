import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { RoomServiceClient } from 'livekit-server-sdk';

// Real local identities, real HTTP mutations and empty local provider rooms.
// Browser sessions and MOBILE cleanup sessions have independent rotation.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function localUrl(raw, protocols, label) {
  let value;
  try { value = new URL(raw); } catch { throw new Error(`${label} must be a local test URL.`); }
  assert.ok(protocols.includes(value.protocol) && loopback.has(value.hostname.toLowerCase()), `${label} must use loopback.`);
  assert.ok(!value.hash, `${label} must not contain a fragment.`); return value;
}
const migration = localUrl(process.env.DATABASE_MIGRATION_URL, ['postgres:', 'postgresql:'], 'DATABASE_MIGRATION_URL');
const runtime = localUrl(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'DATABASE_URL');
assert.match(decodeURIComponent(migration.pathname), /(?:^|[_-])test(?:$|[_-])/i);
assert.equal(runtime.pathname, migration.pathname); assert.equal(runtime.port, migration.port); assert.equal(decodeURIComponent(runtime.username), 'livestar_app');
const web = localUrl(process.env.ADMIN_TEST_WEB_URL || 'http://localhost:3000', ['http:', 'https:'], 'ADMIN_TEST_WEB_URL');
const api = localUrl(process.env.ADMIN_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'ADMIN_TEST_API_URL');
const media = localUrl(process.env.LIVEKIT_API_URL, ['http:', 'https:'], 'LIVEKIT_API_URL');
localUrl(process.env.LIVEKIT_URL, ['ws:', 'wss:'], 'LIVEKIT_URL');
assert.equal(web.pathname.replace(/\/$/, ''), ''); assert.equal(api.pathname.replace(/\/$/, ''), '/api/v1');
for (const url of [web, api, media]) assert.ok(!url.username && !url.password && !url.search);
assert.ok(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
const provider = new RoomServiceClient(media.origin, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const pool = new pg.Pool({ connectionString: migration.href, max: 2 });
const base = web.origin, apiBase = api.origin + '/api/v1', directory = resolve(process.cwd(), 'artifacts');
async function request(path, token, { method = 'GET', body } = {}) {
  const response = await fetch(apiBase + path, { method, redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
function success(response, label = 'request') { assert.ok([200, 201].includes(response.status), `${label}: HTTP ${response.status}`); return response.data; }

test('Admin browser: real staff access, safe actions, report review, preserved audit and bilingual responsive views', { timeout: 240_000 }, async () => {
  mkdirSync(directory, { recursive: true });
  const report = { localOnly: true, passed: false, checks: [], screenshots: [], cleanup: {}, startedAt: new Date().toISOString() };
  const accounts = [], streams = [], contexts = [], errors = [], adminRequests = [];
  let browser, staff, target, phase = 'setup';
  const stage = value => { phase = value; console.log(JSON.stringify({ phase })); };
  const record = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
  async function shot(page, name) { const filename = `admin-${name}.png`; await page.screenshot({ path: resolve(directory, filename), fullPage: true }); report.screenshots.push(filename); }
  async function fits(page, label) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} must fit without horizontal scrolling.`); }
  async function actionGeometry(button, label) {
    const box = await button.boundingBox(); assert.ok(box && box.height >= 40, `${label} needs a usable pointer target.`);
    const icon = button.locator('svg').first();
    if (await icon.count()) { const graphic = await icon.boundingBox(); assert.ok(graphic && Math.abs(graphic.y + graphic.height / 2 - box.y - box.height / 2) <= 3, `${label} icon and text must share a horizontal row.`); }
  }
  async function register(label, displayName) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const identity = { email: `admin-browser-${label}-${suffix}@integration.invalid`, username: `adweb_${suffix}`, password: `AdminBrowser_${suffix}!` };
    const response = await request('/auth/mobile/register', undefined, { method: 'POST', body: { ...identity, displayName, birthDate: '1990-01-01', locale: 'ar', termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true } });
    assert.equal(response.status, 201);
    const account = { ...response.data, identity }; accounts.push(account);
    assert.deepEqual((await pool.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [account.user.id])).rows, [{ name: 'USER' }]);
    return account;
  }
  async function loginMobile(account) { const result = success(await request('/auth/mobile/login', undefined, { method: 'POST', body: { email: account.identity.email, password: account.identity.password } })); account.accessToken = result.accessToken; return result; }
  async function loginBrowser(page, account) {
    await page.goto(base + '/login?returnTo=%2Fadmin');
    await page.locator('input[name="email"]').fill(account.identity.email); await page.locator('input[name="password"]').fill(account.identity.password);
    const loggingIn = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
    await page.locator('button[type="submit"]').click(); assert.equal((await loggingIn).status(), 200);
    await expect(page).toHaveURL(/\/admin$/);
  }
  async function create(account, title) {
    const result = success(await request('/streams', account.accessToken, { method: 'POST', body: { title, category: 'chat' } }));
    assert.equal(result.stream.status, 'SCHEDULED');
    const stream = (await pool.query('SELECT id,creator_id,livekit_room FROM live_streams WHERE id=$1', [result.stream.id])).rows[0];
    assert.equal(stream.creator_id, account.user.id); streams.push({ ...stream, account });
    assert.equal((await provider.listRooms([stream.livekit_room])).length, 1); return stream;
  }
  const status = async account => (await pool.query('SELECT status FROM users WHERE id=$1', [account.user.id])).rows[0].status;
  const auditCount = async () => Number((await pool.query('SELECT COUNT(*) FROM admin_audit_logs WHERE actor_id=$1 AND action LIKE \'ADMIN_%\'', [staff.user.id])).rows[0].count);
  async function confirm(page, path, reason, method = 'POST') {
    await expect(page.getByTestId('admin-action-dialog')).toBeVisible();
    await page.getByTestId('admin-action-reason').fill(reason);
    const pending = page.waitForResponse(response => response.url().includes('/api/v1' + path) && response.request().method() === method);
    await page.getByTestId('admin-action-confirm').click(); assert.equal((await pending).status(), 200);
    await expect(page.getByTestId('admin-action-dialog')).toHaveCount(0); await expect(page.getByTestId('admin-status')).toBeVisible();
  }
  async function reveal(page, locator) {
    for (let count = 0; count < 100; count++) {
      if (await locator.isVisible()) return;
      const more = page.getByTestId('admin-load-more');
      if (await more.isVisible()) { await expect(more).toBeEnabled(); await more.click(); }
      else { await expect(locator.or(more).first()).toBeVisible(); }
    }
    throw new Error('Local fixture was not found within the bounded page traversal.');
  }
  try {
    staff = await register('staff', 'فريق إدارة LiveStar'); target = await register('member', 'ليان أحمد'); const reporter = await register('reporter', 'سارة خالد');
    assert.equal((await pool.query('INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE name=\'ADMIN\' ON CONFLICT DO NOTHING RETURNING user_id', [staff.user.id])).rowCount, 1);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const pages = [];
    for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
      const context = await browser.newContext({ viewport, locale: 'ar', serviceWorkers: 'block' }); contexts.push(context); context.setDefaultTimeout(20_000);
      await context.addInitScript(() => { if (location.protocol.startsWith('http') && !localStorage.getItem('livestar-locale')) localStorage.setItem('livestar-locale', 'ar'); });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (['http:', 'https:'].includes(url.protocol) && !loopback.has(url.hostname.toLowerCase())) { errors.push('Unexpected nonlocal request: ' + url.origin); return route.abort('blockedbyclient'); }
        if (/\/(?:token|activate|host-token)(?:\/|$)/.test(url.pathname)) { errors.push('Unexpected media endpoint: ' + url.pathname); return route.abort('blockedbyclient'); }
        return route.continue();
      });
      await context.routeWebSocket(/.*/, socket => { errors.push('Unexpected WebSocket'); socket.close(); });
      const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message));
      page.on('request', req => { if (new URL(req.url()).pathname.includes('/api/v1/admin/')) adminRequests.push({ page: pages.indexOf(page), method: req.method(), path: new URL(req.url()).pathname }); });
    }
    const [page, memberPage, anonymous] = pages;
    stage('anonymous and member gates');
    await anonymous.goto(base + '/admin'); await expect(anonymous.locator('a[href="/login?returnTo=%2Fadmin"]')).toBeVisible();
    await expect(anonymous.getByTestId('admin-dashboard')).toHaveCount(0); await expect(anonymous.locator('a[href="/admin"]')).toHaveCount(0); await fits(anonymous, 'Anonymous 320px gate');
    await loginBrowser(memberPage, target); await expect(memberPage.getByRole('heading', { name: 'الوصول مقيد' })).toBeVisible();
    await expect(memberPage.getByTestId('admin-dashboard')).toHaveCount(0); await expect(memberPage.locator('a[href="/admin"]')).toHaveCount(0);
    assert.equal(adminRequests.filter(item => item.page !== 0).length, 0, 'Unauthorized gates do not request admin data.');
    record('anonymous and USER views show the proper gate, hide staff navigation and never request admin data');

    stage('real staff sign-in and overview');
    await loginBrowser(page, staff); await expect(page.getByTestId('admin-dashboard')).toBeVisible(); await expect(page.getByTestId('admin-overview')).toContainText('رصيد ترويجي');
    await expect(page.locator('a[href="/admin"]').first()).toBeVisible(); await actionGeometry(page.getByTestId('admin-refresh'), 'Refresh'); await fits(page, 'Arabic 390px overview'); await shot(page, 'overview-ar-390');
    record('normal staff sign-in loads actual overview and identifies DU as promotional rather than cash');
    const stream = await create(target, 'حوار مباشر مع ليان');
    const malicious = '<img src=x onerror=window.__adminXss=1> بلاغ تجريبي محلي';
    const receipt = success(await request(`/streams/${stream.id}/report`, reporter.accessToken, { method: 'POST', body: { reason: malicious } }));

    stage('member search, filter and nonmutating dialog cancellation');
    await page.getByTestId('admin-tab-users').click(); await page.getByTestId('admin-user-search').fill(target.identity.username); await page.getByTestId('admin-user-search').press('Enter');
    await page.getByTestId('admin-filter-status').selectOption('ACTIVE'); const targetRow = page.getByTestId(`admin-user-${target.user.id}`); await expect(targetRow).toBeVisible();
    await fits(page, 'Arabic 390px member search'); await shot(page, 'members-ar-390');
    const beforeCancel = await auditCount(), mutationsBefore = adminRequests.filter(item => item.method !== 'GET').length;
    const suspendButton = page.getByTestId(`admin-suspend-${target.user.id}`);
    await suspendButton.click(); await expect(page.getByTestId('admin-action-confirm')).toBeDisabled(); await expect(page.getByTestId('admin-action-reason')).toBeFocused();
    await page.getByTestId('admin-action-reason').fill('سبب محلي قابل للمراجعة قبل التأكيد'); await actionGeometry(page.getByTestId('admin-action-confirm'), 'Destructive confirmation'); await actionGeometry(page.getByTestId('admin-action-cancel'), 'Cancel'); await fits(page, 'Arabic action dialog'); await shot(page, 'reason-dialog-ar-390');
    await page.getByTestId('admin-action-cancel').click(); await expect(page.getByTestId('admin-action-dialog')).toHaveCount(0); await expect(suspendButton).toBeFocused();
    await suspendButton.click(); await page.keyboard.press('Escape'); await expect(page.getByTestId('admin-action-dialog')).toHaveCount(0);
    assert.equal(await status(target), 'ACTIVE'); assert.equal(await auditCount(), beforeCancel); assert.equal(adminRequests.filter(item => item.method !== 'GET').length, mutationsBefore);
    record('real search/filter retains the target, and Cancel/Escape restore focus without a request or audit mutation');

    stage('populated tab switches and actual room termination');
    await page.getByTestId('admin-tab-streams').click(); await page.getByTestId('admin-filter-status').selectOption('SCHEDULED');
    await expect(page.getByTestId(`admin-stream-${stream.id}`)).toBeVisible(); await fits(page, 'Arabic streams'); await shot(page, 'streams-ar-390');
    await page.getByTestId(`admin-terminate-${stream.id}`).click(); await confirm(page, `/admin/streams/${stream.id}/terminate`, 'اختبار محلي: إيقاف الغرفة الفعلية من واجهة الإدارة');
    assert.equal((await provider.listRooms([stream.livekit_room])).length, 0); assert.equal((await pool.query('SELECT status FROM live_streams WHERE id=$1', [stream.id])).rows[0].status, 'TERMINATED');
    await page.getByTestId('admin-filter-status').selectOption('TERMINATED'); await expect(page.getByTestId(`admin-stream-${stream.id}`)).toBeVisible(); await expect(page.getByTestId(`admin-terminate-${stream.id}`)).toHaveCount(0);
    record('populated tab changes render safely and confirmed termination removes the real provider room and preserves history');

    stage('suspension and restoration through the UI');
    const suspendedRoom = await create(target, 'جلسة محلية لاختبار تعليق الحساب');
    await page.getByTestId('admin-tab-users').click(); await expect(suspendButton).toBeVisible(); await suspendButton.click();
    await confirm(page, `/admin/users/${target.user.id}/suspend`, 'اختبار محلي: تعليق العضو وإلغاء الجلسات وإيقاف البث');
    assert.equal(await status(target), 'SUSPENDED'); assert.equal((await request('/auth/me', target.accessToken)).status, 401);
    assert.equal((await provider.listRooms([suspendedRoom.livekit_room])).length, 0);
    await page.getByTestId('admin-filter-status').selectOption('SUSPENDED'); await expect(page.getByTestId(`admin-restore-${target.user.id}`)).toBeEnabled(); await shot(page, 'suspended-ar-390');
    await page.getByTestId(`admin-restore-${target.user.id}`).click(); await confirm(page, `/admin/users/${target.user.id}/restore`, 'اختبار محلي: إعادة تفعيل العضو بعد اكتمال المراجعة');
    assert.equal(await status(target), 'ACTIVE'); assert.equal((await request('/auth/me', target.accessToken)).status, 401); await loginMobile(target);
    record('confirmed suspend revokes sessions and stops media; restore allows fresh login without reviving the old session');

    stage('literal report text, review and terminal actions');
    await page.getByTestId('admin-tab-reports').click(); const reportCard = page.getByTestId(`admin-report-${receipt.id}`); await reveal(page, reportCard); await expect(reportCard).toContainText(malicious); await expect(reportCard.locator('img')).toHaveCount(0); assert.equal(await page.evaluate(() => window.__adminXss), undefined);
    await shot(page, 'reports-ar-390');
    await page.getByTestId(`admin-review-${receipt.id}-REVIEWING`).click(); await confirm(page, `/admin/reports/${receipt.id}`, 'اختبار محلي: بدء مراجعة البلاغ', 'PATCH');
    await page.getByTestId('admin-filter-status').selectOption('REVIEWING'); await reveal(page, reportCard);
    await page.getByTestId(`admin-review-${receipt.id}-RESOLVED`).click(); await confirm(page, `/admin/reports/${receipt.id}`, 'اختبار محلي: تمت معالجة البلاغ وحفظ القرار', 'PATCH');
    await page.getByTestId('admin-filter-status').selectOption('RESOLVED'); await reveal(page, reportCard); await expect(reportCard.locator('[data-testid^="admin-review-"]')).toHaveCount(0);
    assert.equal((await pool.query('SELECT status FROM reports WHERE id=$1', [receipt.id])).rows[0].status, 'RESOLVED');
    record('untrusted report content stays literal; review transitions persist and terminal decisions hide further decision actions');

    stage('audit retention and responsive Arabic and English views');
    await page.getByTestId('admin-tab-audit').click(); await reveal(page, page.getByTestId('admin-audit').getByText('اختبار محلي: تمت معالجة البلاغ وحفظ القرار', { exact: true })); await shot(page, 'audit-ar-390');
    await page.setViewportSize({ width: 320, height: 780 }); await fits(page, 'Arabic 320px audit'); await shot(page, 'audit-ar-320');
    await page.getByTestId('admin-tab-users').click(); await page.getByTestId('admin-filter-status').selectOption('ACTIVE'); await fits(page, 'Arabic 320px users');
    await page.getByTestId('admin-tab-streams').click(); await fits(page, 'Arabic 320px streams'); await page.getByTestId('admin-tab-reports').click(); await fits(page, 'Arabic 320px reports');
    await page.evaluate(() => localStorage.setItem('livestar-locale', 'en')); await page.reload(); await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByRole('heading', { name: 'Platform management' })).toBeVisible(); await expect(page.getByTestId('admin-overview')).toContainText('free promotional gift credits'); await fits(page, 'English desktop overview'); await shot(page, 'overview-en-1440');
    await page.getByTestId('admin-tab-users').click(); await expect(page.getByTestId('admin-users-table')).toBeVisible(); if (await page.getByTestId('admin-load-more').isVisible()) await actionGeometry(page.getByTestId('admin-load-more'), 'Load more'); await fits(page, 'English desktop users'); await shot(page, 'members-en-1440');
    await page.getByTestId('admin-tab-streams').click(); await page.getByTestId('admin-tab-reports').click(); await page.getByTestId('admin-tab-audit').click(); await expect(page.getByTestId('admin-audit')).toBeVisible(); await fits(page, 'English desktop audit'); await shot(page, 'audit-en-1440');
    assert.deepEqual(errors, []); assert.ok(await auditCount() >= 6); record('Arabic 390/320px and English 1440px views fit, audit entries persist, and populated tab switches raise no browser errors');
    report.passed = true;
  } catch (error) { report.failure = { phase, message: error.message }; if (browser) { for (const context of contexts.slice(0, 1)) for (const page of context.pages()) await shot(page, 'failure').catch(() => {}); } throw error;
  } finally {
    report.browserErrors = errors;
    if (browser) await browser.close();
    for (const stream of streams) {
      try {
        const current = (await pool.query('SELECT status FROM live_streams WHERE id=$1', [stream.id])).rows[0]?.status;
        if (staff && ['LIVE', 'SCHEDULED'].includes(current)) success(await request(`/admin/streams/${stream.id}/terminate`, staff.accessToken, { method: 'POST', body: { reason: 'Local browser fixture cleanup: stop only the owned test room', idempotencyKey: randomUUID() } }));
        if ((await provider.listRooms([stream.livekit_room])).length) await provider.deleteRoom(stream.livekit_room);
      } catch (error) { report.cleanup[`media:${stream.id}`] = error.message; report.passed = false; }
    }
    if (target && staff && await status(target).catch(() => '') === 'SUSPENDED') {
      try { success(await request(`/admin/users/${target.user.id}/restore`, staff.accessToken, { method: 'POST', body: { reason: 'Local browser fixture cleanup: restore before normal deletion', idempotencyKey: randomUUID() } })); } catch (error) { report.cleanup.restore = error.message; report.passed = false; }
    }
    for (const account of [...accounts].reverse()) {
      try { await loginMobile(account); assert.equal((await request('/users/me', account.accessToken, { method: 'DELETE', body: { password: account.identity.password } })).status, 202); assert.equal((await request('/auth/me', account.accessToken)).status, 401); report.cleanup[account.user.id] = 'deleted through authenticated account lifecycle'; }
      catch (error) { report.cleanup[account.user.id] = error.message; report.passed = false; }
    }
    report.completedAt = new Date().toISOString(); writeFileSync(resolve(directory, 'admin-browser-result.json'), JSON.stringify(report, null, 2) + '\n'); await pool.end();
    assert.ok(report.passed, 'All browser checks and ordinary fixture cleanup must complete.');
  }
});
