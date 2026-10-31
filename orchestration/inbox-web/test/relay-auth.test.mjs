import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig } from '../config.mjs';
import { Access, canManage, parseBearer, relayAllowedPath } from '../access.mjs';
import { createInboxServer } from '../server.mjs';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-relay-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'campaign');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ campaign: 'auth', tickets: [] }));
  const other = path.join(home, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'campaign.json'), JSON.stringify({ campaign: 'other', tickets: [] }));
  const config = loadConfig({ home });
  config.port = 0;
  config.remotePort = 0;
  config.lanTrustSubnet = true;
  config.campaigns = [
    { id: 'demo', title: 'auth', dir },
    { id: 'other', title: 'other', dir: other },
  ];
  saveConfig(config);
  return { home, dir, config };
}

const question = {
  kind: 'decide', title: 'Q', ticket: '#1', askerThreadId: 't', askerLabel: 'a',
  options: [{ key: 'a', label: 'A', consequence: 'c' }],
};

test('parseBearer and path allowlist', () => {
  assert.deepEqual(parseBearer('Bearer r1.secret'), { tokenId: 'r1', secret: 'secret' });
  assert.equal(parseBearer('Basic x'), null);
  assert.equal(relayAllowedPath('POST', ['api', 'submit'], { campaign: 'demo' }), true);
  assert.equal(relayAllowedPath('POST', ['api', 'item', 'demo', 'Q1'], { campaign: 'demo' }), true);
  assert.equal(relayAllowedPath('POST', ['api', 'item', 'other', 'Q1'], { campaign: 'demo' }), false);
  assert.equal(relayAllowedPath('POST', ['api', 'remove-campaign'], { campaign: 'demo' }), false);
  assert.equal(relayAllowedPath('PUT', ['api', 'routing'], { campaign: 'demo' }), false);
  assert.equal(relayAllowedPath('POST', ['api', 'add-device'], { campaign: 'demo' }), false);
  assert.equal(relayAllowedPath('POST', ['api', 'subscribe'], { campaign: 'demo' }), false);
  assert.equal(relayAllowedPath('POST', ['admin', 'ask'], { campaign: 'demo' }), false);
  assert.equal(relayAllowedPath('GET', ['media', 'demo', 'a.png'], { campaign: 'demo' }), true);
  assert.equal(relayAllowedPath('GET', ['media', 'other', 'a.png'], { campaign: 'demo' }), false);
});

test('relay token auth, lockout, cross-campaign and manage denial', async t => {
  const { config } = setup(t);
  const server = await createInboxServer({
    config,
    fetch: async () => new Response(null, { status: 200 }),
    relaySleep: async () => {},
  });
  await server.start();
  t.after(() => server.stop());
  const secrets = await server.admin('relay-set', { campaign: 'demo', bridgeUrl: 'http://127.0.0.1:9/b' });
  const item = await server.admin('ask', { campaign: 'demo', item: question });
  const base = `http://127.0.0.1:${server.health().port}`;
  const good = `${secrets.tokenId}.${secrets.inboundToken}`;

  const ok = await fetch(`${base}/api/campaign/demo`, { headers: { Authorization: `Bearer ${good}` } });
  assert.equal(ok.status, 200);
  const health = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${good}` } });
  assert.equal(health.status, 200);
  await health.json();

  const otherCampaign = await fetch(`${base}/api/campaign/other`, { headers: { Authorization: `Bearer ${good}` } });
  assert.equal(otherCampaign.status, 403);

  const badPaths = [
    ['POST', '/api/remove-campaign', { campaign: 'demo' }],
    ['PUT', '/api/routing', { layer: 'global', expectedVersion: 1, patch: {} }],
    ['POST', '/api/add-device', {}],
    ['POST', '/api/subscribe', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: 'y' } }],
    ['POST', '/api/quota', { key: 'x', expectedVersion: 1 }],
  ];
  for (const [method, pathName, body] of badPaths) {
    const response = await fetch(`${base}${pathName}`, {
      method,
      headers: { Authorization: `Bearer ${good}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, pathName);
    await response.arrayBuffer();
  }

  // Relay principal never gets canManage: manage APIs reject bearer with 403 above.
  // canManage itself only looks at cookie / trusted LAN, not Authorization.
  const access = new Access(config.privateDir);
  assert.equal(canManage({
    headers: { authorization: `Bearer ${good}`, cookie: '' },
    socket: { remoteAddress: '127.0.0.1' },
  }, { access, config: { ...config, lanTrustSubnet: false }, isRemote: false }), false);
  assert.equal(access.validCookie(''), false);

  // Wrong token failures then lockout.
  for (let i = 0; i < 5; i++) {
    const response = await fetch(`${base}/api/campaign/demo`, {
      headers: { Authorization: 'Bearer r1.not-the-token' },
    });
    assert.ok([401, 429].includes(response.status));
    await response.arrayBuffer();
  }
  const locked = await fetch(`${base}/api/campaign/demo`, {
    headers: { Authorization: 'Bearer r1.not-the-token' },
  });
  assert.equal(locked.status, 429);

  // Messages forbidden for relay.
  const fresh = await createInboxServer({
    config: loadConfig({ home: config.home }),
    fetch: async () => new Response(null, { status: 200 }),
    relaySleep: async () => {},
  });
  // Use original server after revoke lockout by rotating via new token path: submit with messages.
  // Lockout is per source IP; continue with good token may still be locked. Use item path on same server after waiting is hard; assert store path instead.
  assert.throws(
    () => server.store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }], [{ note: 'hi' }], { via: 'relay', tokenId: secrets.tokenId }),
    /留言|403|中继/,
  );
});

test('relay media read limited to own campaign', async t => {
  const { config, dir } = setup(t);
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const otherDir = config.campaigns[1].dir;
  fs.writeFileSync(path.join(otherDir, 'secret.png'), 'nope');
  const server = await createInboxServer({
    config,
    fetch: async () => new Response(null, { status: 200 }),
    relaySleep: async () => {},
  });
  await server.start();
  t.after(() => server.stop());
  const secrets = await server.admin('relay-set', { campaign: 'demo', bridgeUrl: 'http://127.0.0.1:9/b', mediaBase: 'loopback' });
  const base = `http://127.0.0.1:${server.health().port}`;
  const token = `${secrets.tokenId}.${secrets.inboundToken}`;
  const own = await fetch(`${base}/media/demo/pic.png`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(own.status, 200);
  await own.arrayBuffer();
  const cross = await fetch(`${base}/media/other/secret.png`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(cross.status, 403);
  await cross.arrayBuffer();
});

test('relay upload then answer with image reference', async t => {
  const { config } = setup(t);
  const server = await createInboxServer({
    config,
    fetch: async () => new Response(null, { status: 200 }),
    relaySleep: async () => {},
  });
  await server.start();
  t.after(() => server.stop());
  const secrets = await server.admin('relay-set', { campaign: 'demo', bridgeUrl: 'http://127.0.0.1:9/b' });
  const item = await server.admin('ask', { campaign: 'demo', item: question });
  const base = `http://127.0.0.1:${server.health().port}`;
  const token = `${secrets.tokenId}.${secrets.inboundToken}`;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const uploaded = await fetch(`${base}/api/upload/demo/${item.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  assert.equal(uploaded.status, 200);
  const ref = await uploaded.json();
  const answered = await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaign: 'demo',
      items: [{ id: item.id, answer: { choices: [], note: '见图', images: [ref.reference] } }],
    }),
  });
  assert.equal(answered.status, 200);
  assert.equal(server.store.load('demo').items[0].answer.images[0], ref.reference);
});
