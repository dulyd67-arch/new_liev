import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RoomServiceClient } from 'livekit-server-sdk';

const base = process.env.LIVE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1';
const databaseUrl = process.env.DATABASE_MIGRATION_URL;
assert.ok(databaseUrl && /test/i.test(new URL(databaseUrl).pathname), 'Use an isolated test database.');
const provider = new RoomServiceClient(process.env.LIVEKIT_API_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);

async function call(path, method = 'GET', body, token) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function account() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
  const result = await call('/auth/mobile/register', 'POST', {
    email: `live-fixture-${suffix}@integration.invalid`, username: `live_${suffix}`,
    displayName: 'Live integration fixture', password: `LiveFixture_${suffix}!`, birthDate: '1990-01-01',
    locale: 'en', termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true,
  });
  assert.equal(result.status, 201, 'Fixture registration must succeed against the actual restricted database role.');
  return result.data;
}

test('real LiveKit room creation, host authorization, publish-proof requirement and actual room deletion', { timeout: 60_000 }, async () => {
  const host = await account();
  const other = await account();
  let streamId;
  try {
    assert.equal((await call('/streams', 'POST', { title: 'Unauthorized' })).status, 401);
    const created = await call('/streams', 'POST', { title: 'LiveKit integration fixture', category: 'chat' }, host.accessToken);
    assert.equal(created.status, 201);
    streamId = created.data.stream.id;
    assert.equal(created.data.stream.status, 'SCHEDULED');
    const claim = JSON.parse(Buffer.from(created.data.token.split('.')[1], 'base64url').toString());
    assert.equal(claim.sub, host.user.id);
    assert.equal(claim.video.canPublish, true);
    assert.equal(claim.video.canPublishData, false);
    assert.equal((await provider.listRooms([claim.video.room])).length, 1, 'The media room must exist at the actual provider.');
    assert.equal((await call('/streams', 'POST', { title: 'Duplicate' }, host.accessToken)).status, 409);
    assert.equal((await call(`/streams/${streamId}/activate`, 'POST', {}, host.accessToken)).status, 409,
      'A reserved room cannot be falsely presented as a live broadcast without published media.');
    assert.equal((await call(`/streams/${streamId}/token`, 'POST')).status, 409);
    assert.equal((await call(`/streams/${streamId}/host-token`, 'POST', {}, other.accessToken)).status, 403);
    assert.equal((await call(`/streams/${streamId}/end`, 'POST', {}, other.accessToken)).status, 403);
    assert.equal((await call(`/streams/${streamId}/messages`, 'POST', { body: 'Not live yet' }, host.accessToken)).status, 409);
    const ended = await call(`/streams/${streamId}/end`, 'POST', {}, host.accessToken);
    assert.equal(ended.data.status, 'ENDED');
    assert.equal((await provider.listRooms([claim.video.room])).length, 0, 'Ending the stream must delete the actual media room.');
    assert.equal((await call(`/streams/${streamId}/host-token`, 'POST', {}, host.accessToken)).status, 409);
    assert.equal((await call(`/streams/${streamId}/end`, 'POST', {}, host.accessToken)).data.status, 'ENDED');
    console.log('Actual LiveKit lifecycle and publish permissions verified; camera/video transport is tested separately in Chromium.');
  } finally {
    if (streamId) await call(`/streams/${streamId}/end`, 'POST', {}, host.accessToken);
  }
});
