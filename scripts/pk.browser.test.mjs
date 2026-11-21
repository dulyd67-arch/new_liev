import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { RoomServiceClient } from 'livekit-server-sdk';

// This regression never creates accounts, rooms or currency outside loopback.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function localUrl(raw, protocols, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid local test URL.`); }
  assert.ok(protocols.includes(url.protocol) && loopback.has(url.hostname.toLowerCase()), `${label} must use loopback; cloud fixtures are forbidden.`);
  assert.ok(!url.hash, `${label} cannot contain a fragment.`);
  return url;
}
const migration = localUrl(process.env.DATABASE_MIGRATION_URL, ['postgres:', 'postgresql:'], 'DATABASE_MIGRATION_URL');
const runtime = localUrl(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'DATABASE_URL');
assert.match(decodeURIComponent(migration.pathname), /(?:^|[_-])test(?:$|[_-])/i, 'Use an isolated test database.');
assert.equal(runtime.pathname, migration.pathname); assert.equal(runtime.port, migration.port);
assert.equal(decodeURIComponent(runtime.username), 'livestar_app', 'The actual API must use its restricted application role.');
const webUrl = localUrl(process.env.PK_TEST_WEB_URL || process.env.LIVE_TEST_WEB_URL || 'http://localhost:3000', ['http:', 'https:'], 'PK_TEST_WEB_URL');
const apiUrl = localUrl(process.env.PK_TEST_API_URL || process.env.LIVE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'PK_TEST_API_URL');
assert.equal(webUrl.pathname.replace(/\/$/, ''), ''); assert.equal(apiUrl.pathname.replace(/\/$/, ''), '/api/v1');
for (const url of [webUrl, apiUrl]) assert.ok(!url.username && !url.password && !url.search);
localUrl(process.env.LIVEKIT_URL, ['ws:', 'wss:'], 'LIVEKIT_URL');
const mediaUrl = localUrl(process.env.LIVEKIT_API_URL, ['http:', 'https:'], 'LIVEKIT_API_URL');
const provider = new RoomServiceClient(mediaUrl.origin, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
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
function ok(result, label) {
  assert.equal(result.status, 200, `${label} failed with HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}
async function decoded(page, selector) {
  await expect.poll(() => page.getByTestId(selector).evaluate(video =>
    video.videoWidth > 0 && video.videoHeight > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5).catch(() => false),
  { timeout: 35_000, message: `${selector} must decode real WebRTC video frames` }).toBe(true);
}

test('PK: two independent publishers, a third viewer, real DU scoring, persisted animated likes and forfeit cleanup', { timeout: 240_000 }, async () => {
  mkdirSync(artifact, { recursive: true });
  const report = { localOnly: true, passed: false, checks: [], screenshots: [], cleanup: {}, startedAt: new Date().toISOString() };
  const accounts = [], errors = [], rooms = [];
  let browser, host, guest, viewer, battleId, phase = 'launch';
  const stage = value => { phase = value; console.log(JSON.stringify({ phase })); };
  const record = value => { report.checks.push(value); console.log(JSON.stringify({ check: value, ok: true })); };
  async function screenshot(page, name) {
    await page.screenshot({ path: resolve(artifact, name), fullPage: true });
    report.screenshots.push(name);
  }
  async function register(page, label) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const identity = { email: `pk-browser-${suffix}@integration.invalid`, username: `pkweb_${suffix}`, password: `PkBrowser_${suffix}!` };
    await page.goto(`${base}/register`);
    await page.locator('input[name="displayName"]').fill(`PK ${label}`);
    await page.locator('input[name="username"]').fill(identity.username);
    await page.locator('input[name="email"]').fill(identity.email);
    await page.locator('input[name="password"]').fill(identity.password);
    await page.locator('input[name="birthDate"]').fill('1990-01-01');
    await page.locator('input[name="accept"]').check();
    const registering = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST');
    await page.locator('button[type="submit"]').click();
    const registration = await registering;
    assert.equal(registration.status(), 201);
    const registered = await registration.json();
    const account = { identity, userId: registered.user.id };
    accounts.push(account);
    await expect(page).not.toHaveURL(/\/register$/);
    account.session = ok(await request('/auth/mobile/login', undefined, { method: 'POST', body: { email: identity.email, password: identity.password } }), 'independent fixture login');
    assert.equal(account.session.user.id, account.userId);
    return account;
  }
  async function publish(page, account, label) {
    await page.goto(`${base}/go-live`);
    await page.getByTestId('studio-title').fill(`PK ${label} ${randomUUID().slice(0, 8)}`);
    await page.getByTestId('studio-preview').click();
    await expect(page.getByTestId('studio-start')).toBeEnabled();
    const reserving = page.waitForResponse(response => response.url().endsWith('/api/v1/streams') && response.request().method() === 'POST');
    const activating = page.waitForResponse(response => /\/api\/v1\/streams\/[^/]+\/activate$/.test(response.url()) && response.request().method() === 'POST', { timeout: 40_000 });
    await page.getByTestId('studio-start').click();
    const reservation = await (await reserving).json();
    account.streamId = reservation.stream.id;
    localUrl(reservation.url, ['ws:', 'wss:'], 'actual publisher media URL');
    account.room = JSON.parse(Buffer.from(reservation.token.split('.')[1], 'base64url').toString()).video.room;
    rooms.push(account.room);
    assert.equal((await activating).status(), 201);
    await expect(page.getByTestId('studio-end')).toBeVisible({ timeout: 30_000 });
    const detail = ok(await request(`/streams/${account.streamId}`), 'published stream detail');
    assert.equal(detail.status, 'LIVE'); assert.equal(detail.publisherConnected, true);
  }
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    ] });
    const contexts = await Promise.all([
      browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'] }),
      browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'] }),
      browser.newContext({ viewport: { width: 390, height: 844 } }),
    ]);
    for (const context of contexts) {
      context.setDefaultTimeout(20_000);
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (['http:', 'https:'].includes(url.protocol) && !loopback.has(url.hostname.toLowerCase())) {
          errors.push(`Nonlocal browser request blocked: ${url.origin}`);
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
      await context.addInitScript(() => {
        if (location.protocol.startsWith('http')) localStorage.setItem('livestar-locale', 'en');
        window.__pkCaptureTracks = [];
        const getUserMedia = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
        if (getUserMedia) navigator.mediaDevices.getUserMedia = async constraints => {
          const stream = await getUserMedia(constraints);
          const tracks = stream.getTracks();
          window.__pkCaptureTracks.push(...tracks);
          sessionStorage.setItem('pk-captured-tracks', String(Number(sessionStorage.getItem('pk-captured-tracks') || 0) + tracks.length));
          for (const track of tracks) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              const wasLive = track.readyState === 'live'; stop();
              if (wasLive && track.readyState === 'ended') sessionStorage.setItem('pk-stopped-tracks', String(Number(sessionStorage.getItem('pk-stopped-tracks') || 0) + 1));
            };
          }
          return stream;
        };
      });
    }
    [host, guest, viewer] = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of [host, guest, viewer]) {
      page.on('pageerror', error => errors.push(error.message));
      page.on('websocket', socket => {
        if (!loopback.has(new URL(socket.url()).hostname.toLowerCase())) errors.push('Nonlocal WebSocket attempted.');
      });
    }
    stage('three separate ordinary member sessions');
    const hostAccount = await register(host, 'first host');
    const guestAccount = await register(guest, 'second host');
    const viewerAccount = await register(viewer, 'viewer');
    stage('publish two separate real local camera and microphone rooms');
    await publish(host, hostAccount, 'first host');
    await publish(guest, guestAccount, 'second host');
    await decoded(host, 'studio-video'); await decoded(guest, 'studio-video');
    assert.notEqual(hostAccount.room, guestAccount.room);
    record('each host independently publishes its own LIVE room');

    stage('invite and accept through the host controls');
    await host.getByTestId('pk-trigger').click();
    await expect(host.getByTestId(`pk-invite-${guestAccount.streamId}`)).toBeVisible();
    const inviting = host.waitForResponse(response => response.url().endsWith(`/api/v1/streams/${hostAccount.streamId}/battles`) && response.request().method() === 'POST');
    await host.getByTestId(`pk-invite-${guestAccount.streamId}`).click();
    const invitedResponse = await inviting;
    assert.equal(invitedResponse.status(), 200);
    const invited = await invitedResponse.json(); battleId = invited.battle.id;
    assert.equal(invited.battle.status, 'INVITED');
    await host.keyboard.press('Escape');
    assert.deepEqual(ok(await request('/battles/invitations', viewerAccount.session.accessToken), 'private unrelated invitations').items, []);
    assert.deepEqual(ok(await request('/battles/invitations', hostAccount.session.accessToken), 'inviter incoming invitations').items, []);
    await guest.getByTestId('pk-trigger').click();
    await expect(guest.getByTestId(`pk-accept-${battleId}`)).toBeVisible();
    const accepting = guest.waitForResponse(response => response.url().endsWith(`/api/v1/battles/${battleId}/accept`) && response.request().method() === 'POST');
    await guest.getByTestId(`pk-accept-${battleId}`).click();
    assert.equal((await accepting).status(), 200);
    await expect(host.getByTestId('pk-scoreboard')).toHaveAttribute('data-status', 'ACTIVE');
    await expect(guest.getByTestId('pk-scoreboard')).toHaveAttribute('data-status', 'ACTIVE');
    await decoded(host, 'studio-opponent-video'); await decoded(guest, 'studio-opponent-video');
    const active = ok(await request(`/streams/${hostAccount.streamId}/battle`), 'public active battle').battle;
    assert.equal(active.id, battleId); assert.equal(active.status, 'ACTIVE');
    assert.equal(active.hostScore, '0'); assert.equal(active.guestScore, '0'); assert.equal(active.winnerStreamId, null);
    assert.equal(new Date(active.endsAt) - new Date(active.startsAt), 300_000);
    const timerBefore = await host.getByTestId('pk-timer').textContent();
    await expect.poll(() => host.getByTestId('pk-timer').textContent(), { timeout: 4_000 }).not.toBe(timerBefore);
    record('only the invited host accepts, and the server starts a genuine five minute countdown');

    stage('third browser receives two independent media feeds');
    await viewer.goto(`${base}/live/${hostAccount.streamId}`);
    await decoded(viewer, 'watch-video'); await decoded(viewer, 'watch-opponent-video');
    for (const streamId of [hostAccount.streamId, guestAccount.streamId]) {
      await expect.poll(() => viewer.locator(`audio[data-stream-audio][data-stream-id="${streamId}"]`).evaluateAll(elements => elements.some(element =>
        element.srcObject instanceof MediaStream && element.srcObject.getAudioTracks().some(track => track.readyState === 'live'))), { timeout: 20_000 }).toBe(true);
    }
    await expect(viewer.getByTestId('pk-scoreboard')).toHaveAttribute('data-battle-id', battleId);
    assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The split view must fit a phone viewport.');
    for (const account of [hostAccount, guestAccount]) {
      const participants = await provider.listParticipants(account.room);
      const publisher = participants.find(participant => participant.identity === account.userId);
      assert.ok(publisher && publisher.tracks.length >= 2, 'Each room must still contain its own audio/video publisher.');
      assert.ok(participants.filter(participant => participant.identity !== account.userId).every(participant => !participant.permission?.canPublish && participant.tracks.length === 0),
        'The opponent and viewer connections must remain subscribe-only in the other host room.');
    }
    record('both host previews and the phone viewer decode opponent video; the viewer has live audio from both rooms');
    await screenshot(host, 'pk-active-host.png');
    await screenshot(guest, 'pk-active-guest.png');
    await screenshot(viewer, 'pk-active-mobile-viewer.png');
    await viewer.getByRole('button', { name: 'التبديل إلى العربية', exact: true }).click();
    await expect(viewer.locator('html')).toHaveAttribute('dir', 'rtl');
    const [hostVideoBox, guestVideoBox, hostGiftBox, guestGiftBox] = await Promise.all([
      viewer.getByTestId('watch-video').boundingBox(), viewer.getByTestId('watch-opponent-video').boundingBox(),
      viewer.getByTestId('pk-host-gifts').boundingBox(), viewer.getByTestId('pk-guest-gifts').boundingBox(),
    ]);
    assert.ok(hostVideoBox && guestVideoBox && hostVideoBox.x < guestVideoBox.x, 'RTL keeps the host video physically left and opponent video right.');
    assert.ok(hostGiftBox && guestGiftBox && hostGiftBox.x < guestGiftBox.x, 'RTL keeps recipient gift controls aligned with their video sides.');
    await expect(viewer.getByTestId('live-like-button')).toBeVisible();
    assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Arabic PK must fit the phone viewport.');
    await screenshot(viewer, 'pk-active-mobile-viewer-ar.png');
    await viewer.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await expect(viewer.locator('html')).toHaveAttribute('dir', 'ltr');
    record('Arabic RTL keeps physical host and guest sides, recipient gifts and heart controls visible without horizontal overflow');

    stage('persist exact real likes and animate accepted activity');
    assert.equal(ok(await request(`/streams/${hostAccount.streamId}/likes`), 'initial likes').total, '0');
    for (let index = 0; index < 5; index++) await viewer.getByTestId('live-like-button').click();
    await expect.poll(() => viewer.getByTestId('live-like-particle').count(), { timeout: 5_000 }).toBeGreaterThan(0);
    await expect.poll(async () => ok(await request(`/streams/${hostAccount.streamId}/likes`), 'persisted likes').total, { timeout: 12_000 }).toBe('5');
    await expect(viewer.getByTestId('live-like-count')).toHaveText('5');
    await viewer.reload();
    await expect(viewer.getByTestId('live-like-count')).toHaveText('5');
    await decoded(viewer, 'watch-video'); await decoded(viewer, 'watch-opponent-video');
    assert.equal(ok(await request(`/streams/${hostAccount.streamId}/battle`), 'likes do not score').battle.hostScore, '0');
    record('five actual taps persist exactly five likes, animate hearts and survive reload without changing PK points');

    stage('a real DU gift determines the actual score');
    const claimed = ok(await request('/wallet/claim', viewerAccount.session.accessToken, { method: 'POST', body: { idempotencyKey: randomUUID() } }), 'viewer promotional DU claim');
    assert.equal(claimed.wallet.balance, '100');
    const catalog = ok(await request('/gifts'), 'real gift catalog');
    const gift = [...catalog.items].sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)))[0];
    assert.ok(gift && BigInt(gift.price) <= 100n);
    await viewer.getByTestId('pk-host-gifts').getByTestId('gift-trigger').click();
    await viewer.getByTestId(`gift-item-${gift.slug}`).click();
    await screenshot(viewer, 'pk-host-gift-mobile.png');
    const sending = viewer.waitForResponse(response => response.url().endsWith(`/api/v1/streams/${hostAccount.streamId}/gifts`) && response.request().method() === 'POST');
    await viewer.getByTestId('gift-send').click();
    const giftResponse = await sending;
    assert.equal(giftResponse.status(), 200);
    const sent = await giftResponse.json();
    assert.equal(sent.wallet.balance, String(100n - BigInt(gift.price)));
    for (const page of [host, guest, viewer]) await expect(page.getByTestId('pk-host-score')).toHaveText(gift.price, { timeout: 15_000 });
    const scored = ok(await request(`/streams/${hostAccount.streamId}/battle`), 'actual gift PK score').battle;
    assert.equal(scored.hostScore, gift.price); assert.equal(scored.guestScore, '0'); assert.equal(scored.winnerStreamId, null);
    if (await viewer.getByTestId('gift-dialog').isVisible()) await viewer.keyboard.press('Escape');
    record('the committed DU debit produces the same exact score in all three independent browsers');
    await viewer.getByTestId('pk-guest-gifts').getByTestId('gift-trigger').click();
    await expect(viewer.getByTestId('gift-dialog')).toContainText('PK second host');
    await viewer.getByTestId(`gift-item-${gift.slug}`).click();
    const opponentSending = viewer.waitForResponse(response => response.url().endsWith(`/api/v1/streams/${guestAccount.streamId}/gifts`) && response.request().method() === 'POST');
    await viewer.getByTestId('gift-send').click();
    const opponentGift = await opponentSending;
    assert.equal(opponentGift.status(), 200);
    assert.equal((await opponentGift.json()).wallet.balance, String(100n - BigInt(gift.price) * 2n));
    for (const page of [host, guest, viewer]) await expect(page.getByTestId('pk-guest-score')).toHaveText(gift.price, { timeout: 15_000 });
    await viewer.keyboard.press('Escape');
    record('the opponent gift control targets the second publisher and updates only that side of the score');
    await screenshot(viewer, 'pk-scored-mobile-viewer.png');

    stage('end the second host and verify real forfeit and media cleanup');
    await guest.getByTestId('studio-end').click();
    await guest.getByTestId('studio-confirm-end').click();
    await expect(guest).toHaveURL(`${base}/`, { timeout: 20_000 });
    await expect.poll(async () => ok(await request(`/streams/${hostAccount.streamId}/battle`), 'forfeit settlement').battle.status, { timeout: 15_000 }).toBe('FINISHED');
    const final = ok(await request(`/streams/${hostAccount.streamId}/battle`), 'final battle').battle;
    assert.equal(final.finishReason, 'FORFEIT'); assert.equal(final.winnerStreamId, hostAccount.streamId);
    assert.equal(final.hostScore, gift.price); assert.equal(final.guestScore, gift.price);
    await expect(host.getByTestId('pk-result')).toBeVisible(); await expect(viewer.getByTestId('pk-result')).toBeVisible();
    await expect(viewer.getByTestId('watch-opponent-video')).toHaveCount(0);
    await expect(viewer.locator(`audio[data-stream-audio][data-stream-id="${guestAccount.streamId}"]`)).toHaveCount(0);
    await expect(host.getByTestId('studio-opponent-video')).toHaveCount(0);
    await expect.poll(() => guest.evaluate(() => {
      const captured = Number(sessionStorage.getItem('pk-captured-tracks') || 0);
      return captured >= 2 && captured === Number(sessionStorage.getItem('pk-stopped-tracks') || 0);
    })).toBe(true);
    assert.equal((await provider.listRooms([guestAccount.room])).length, 0);
    assert.equal((await provider.listRooms([hostAccount.room])).length, 1);
    assert.equal(ok(await request(`/streams/${hostAccount.streamId}`), 'continuing host').publisherConnected, true);
    await decoded(viewer, 'watch-video');
    record('ending one host awards the surviving host, deletes only the ended room and releases its capture and opponent subscriptions');
    await screenshot(host, 'pk-forfeit-host.png');
    await screenshot(viewer, 'pk-forfeit-mobile-viewer.png');

    stage('another genuine round survives mute and settles an abrupt publisher disconnect');
    await publish(guest, guestAccount, 'second host reconnect');
    await host.getByTestId('pk-trigger').click();
    await expect(host.getByTestId(`pk-invite-${guestAccount.streamId}`)).toBeVisible();
    const invitingAgain = host.waitForResponse(response => response.url().endsWith(`/api/v1/streams/${hostAccount.streamId}/battles`) && response.request().method() === 'POST');
    await host.getByTestId(`pk-invite-${guestAccount.streamId}`).click();
    const again = await invitingAgain;
    assert.equal(again.status(), 200);
    const nextBattleId = (await again.json()).battle.id;
    assert.notEqual(nextBattleId, battleId);
    await host.keyboard.press('Escape');
    await guest.getByTestId('pk-trigger').click();
    await expect(guest.getByTestId(`pk-accept-${nextBattleId}`)).toBeVisible();
    await guest.getByTestId(`pk-accept-${nextBattleId}`).click();
    await expect(host.getByTestId('pk-scoreboard')).toHaveAttribute('data-battle-id', nextBattleId);
    await expect(host.getByTestId('pk-scoreboard')).toHaveAttribute('data-status', 'ACTIVE');
    await decoded(host, 'studio-opponent-video');
    await guest.getByTestId('studio-camera').click();
    await guest.getByTestId('studio-mic').click();
    await expect(guest.getByTestId('studio-camera')).toHaveAttribute('aria-pressed', 'true');
    await expect(guest.getByTestId('studio-mic')).toHaveAttribute('aria-pressed', 'true');
    const mutedAt = Date.now();
    await expect.poll(async () => {
      assert.equal(ok(await request(`/streams/${hostAccount.streamId}/battle`), 'muted publisher battle').battle.status, 'ACTIVE');
      const publisher = (await provider.listParticipants(guestAccount.room)).find(participant => participant.identity === guestAccount.userId);
      assert.ok(publisher, 'The actual muted publisher must remain connected to its own room.');
      return publisher.tracks.length >= 2 && publisher.tracks.every(track => track.muted) && Date.now() - mutedAt >= 17_000;
    }, { timeout: 23_000, intervals: [1_000, 2_000] }).toBe(true);
    record('a connected broadcaster may mute both media tracks beyond the disconnect grace without forfeiting');
    await guest.context().route(`**/api/v1/streams/${guestAccount.streamId}/end`, route => route.abort('connectionclosed'));
    await guest.context().close();
    assert.equal(ok(await request(`/streams/${hostAccount.streamId}/battle`), 'transient disconnect grace').battle.status, 'ACTIVE');
    assert.equal(ok(await request(`/streams/${guestAccount.streamId}`), 'abruptly disconnected stream remains live').status, 'LIVE');
    await expect.poll(async () => ok(await request(`/streams/${hostAccount.streamId}/battle`), 'abrupt disconnect reconciliation').battle.status,
      { timeout: 40_000, intervals: [1_000, 2_000] }).toBe('FINISHED');
    const disconnected = ok(await request(`/streams/${hostAccount.streamId}/battle`), 'abrupt disconnect final result').battle;
    assert.equal(disconnected.id, nextBattleId);
    assert.equal(disconnected.finishReason, 'FORFEIT'); assert.equal(disconnected.winnerStreamId, hostAccount.streamId);
    assert.equal(disconnected.hostScore, '0'); assert.equal(disconnected.guestScore, '0');
    const reconnectable = ok(await request(`/streams/${guestAccount.streamId}`), 'disconnected publisher reconnectable stream');
    assert.equal(reconnectable.status, 'LIVE'); assert.equal(reconnectable.publisherConnected, false);
    assert.equal(ok(await request(`/streams/${hostAccount.streamId}`), 'surviving publisher after abrupt disconnect').publisherConnected, true);
    await expect(host.getByTestId('pk-scoreboard')).toHaveAttribute('data-status', 'FINISHED');
    await expect(host.getByTestId('studio-opponent-video')).toHaveCount(0);
    await screenshot(host, 'pk-disconnect-forfeit-host.png');
    record('continuous actual publisher absence settles after the server grace and preserves both reconnectable stream state and the surviving publisher');
    assert.deepEqual(errors, [], 'The complete local PK flow must have no unhandled browser errors or nonlocal traffic.');
    report.passed = true;
  } catch (error) {
    report.failure = { phase, message: error.message?.slice(0, 1000) };
    for (const [page, name] of [[host, 'pk-failure-host.png'], [guest, 'pk-failure-guest.png'], [viewer, 'pk-failure-viewer.png']]) {
      if (page) await screenshot(page, name).catch(() => undefined);
    }
    console.error(JSON.stringify({ phase, failure: error.message?.slice(0, 700), alerts: await host?.getByRole('alert').allTextContents().catch(() => []) }));
    throw error;
  } finally {
    const failures = [];
    // Keep sessions alive until every room is ended, then soft-delete accounts.
    for (const account of accounts) {
      try {
        if (account.streamId && account.session) {
          const ended = await request(`/streams/${account.streamId}/end`, account.session.accessToken, { method: 'POST' });
          assert.equal(ended.status, 201);
        }
      } catch (error) { failures.push(error); }
    }
    await browser?.close().catch(error => failures.push(error));
    for (const account of accounts) {
      try {
        const session = account.session || ok(await request('/auth/mobile/login', undefined, { method: 'POST', body: { email: account.identity.email, password: account.identity.password } }), 'cleanup login');
        assert.equal((await request('/users/me', session.accessToken, { method: 'DELETE', body: { password: account.identity.password } })).status, 202);
        assert.equal((await request('/auth/me', session.accessToken)).status, 401);
      } catch (error) { failures.push(error); }
    }
    try { assert.equal((await provider.listRooms(rooms)).length, 0, 'Every fixture media room must be deleted.'); }
    catch (error) { failures.push(error); }
    report.cleanup = { passed: failures.length === 0, accounts: accounts.length, rooms: rooms.length, errors: failures.map(error => error.message) };
    report.browserErrors = errors;
    report.passed = report.passed && report.cleanup.passed;
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(artifact, 'pk-browser-result.json'), JSON.stringify(report, null, 2) + '\n');
    if (failures.length) throw new AggregateError(failures, 'PK browser fixture cleanup failed.');
  }
});
