import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { loadConfig, saveConfig } from '../config.mjs';
import { createInboxServer } from '../server.mjs';
import {
  RelayService, buildRelayEvent, renderRelayText, signRelayBody, verifyRelaySignature, hashRelayToken,
} from '../relay.mjs';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-relay-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'campaign');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ campaign: 'relay-demo', tickets: [] }));
  const asset = path.join(dir, 'media', 'shot.png');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const config = loadConfig({ home });
  config.port = 0;
  config.remotePort = 0;
  config.campaigns = [{ id: 'demo', title: 'relay-demo', dir }];
  saveConfig(config);
  return { home, dir, config };
}

function question(extra = {}) {
  return {
    kind: 'decide',
    title: '选择窗口',
    ticket: '#34',
    askerThreadId: 'thread-secret-should-not-leak',
    askerLabel: '#34 执行',
    blocking: false,
    background: ['背景一行'],
    options: [
      { key: 'now', label: '现在', consequence: '马上做', recommended: true },
      { key: 'later', label: '稍后', consequence: '明天做' },
    ],
    recommendation: '现在',
    media: [{ path: 'media/shot.png', caption: '截图' }],
    ...extra,
  };
}

async function startBridge() {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { body = raw; }
      events.push({
        headers: {
          signature: req.headers['x-inbox-relay-signature'],
          timestamp: req.headers['x-inbox-relay-timestamp'],
          id: req.headers['x-inbox-relay-id'],
          ua: req.headers['user-agent'],
        },
        body,
        raw,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    events,
    url: `http://127.0.0.1:${port}/bridge`,
    port,
    async stop() { await new Promise(resolve => server.close(resolve)); },
  };
}

async function enableRelay(server, campaign, bridgeUrl, extra = {}) {
  return server.admin('relay-set', { campaign, bridgeUrl, mediaBase: 'loopback', ...extra });
}

test('HMAC known vector and text rendering', () => {
  const secret = 'test-secret';
  const body = '{"ok":true}';
  const ts = '1710000000';
  const sig = signRelayBody(secret, ts, body);
  assert.equal(sig.length, 64);
  assert.equal(verifyRelaySignature(secret, ts, body, `sha256=${sig}`), true);
  assert.equal(verifyRelaySignature('other', ts, body, `sha256=${sig}`), false);
  const zh = renderRelayText({
    title: 'T', kind: 'decide', options: [{ key: 'a', label: '甲', consequence: '后果', recommended: true }],
  }, { language: 'zh', maxTextChars: 20 });
  assert.ok(zh.includes('…') || zh.length <= 20);
  const accept = renderRelayText({ title: '验收', kind: 'accept' }, { language: 'en' });
  assert.match(accept, /pass or rework/i);
});

test('disabled relay is a no-op: no fetch, no relay fields', async t => {
  const { config } = setup(t);
  let fetches = 0;
  const server = await createInboxServer({
    config,
    fetch: async () => { fetches++; return new Response(null, { status: 200 }); },
    relaySleep: async () => {},
  });
  await server.start();
  t.after(() => server.stop());
  const item = await server.admin('ask', { campaign: 'demo', item: question() });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fetches, 0);
  const loaded = server.store.load('demo').items[0];
  assert.equal(loaded.id, item.id);
  assert.equal(loaded.relay, undefined);
  assert.equal(loaded.answeredVia, undefined);
  const summary = await fetch(`http://127.0.0.1:${server.health().port}/api/summary`).then(r => r.json());
  assert.equal(summary.campaigns[0].pending, 1);
});

test('opened event is signed and omits secrets; relay answer then second is 409; web may override', async t => {
  const { config, home } = setup(t);
  const bridge = await startBridge();
  t.after(() => bridge.stop());
  const server = await createInboxServer({
    config,
    fetch: async (url, init) => {
      if (String(url).startsWith(bridge.url)) {
        return await fetch(url, init);
      }
      return new Response(null, { status: 200 });
    },
    relaySleep: async () => {},
  });
  await server.start();
  t.after(() => server.stop());
  const secrets = await enableRelay(server, 'demo', bridge.url);
  const item = await server.admin('ask', { campaign: 'demo', item: question() });
  await server.relay.queues.get('demo');
  assert.equal(bridge.events.length, 1);
  const evt = bridge.events[0];
  assert.equal(evt.body.schema, 'inbox-relay/1');
  assert.equal(evt.body.event, 'question.opened');
  assert.equal(evt.body.question.id, item.id);
  assert.equal(evt.body.question.askerThreadId, undefined);
  assert.doesNotMatch(JSON.stringify(evt.body), /thread-secret/);
  assert.doesNotMatch(JSON.stringify(evt.body), new RegExp(secrets.inboundToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(evt.headers.signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(evt.headers.ua, 'Orchestration-Inbox/1.0');
  const cfg = JSON.parse(fs.readFileSync(path.join(config.privateDir, 'relays', 'demo.json'), 'utf8'));
  assert.equal(verifyRelaySignature(cfg.signingSecret, evt.headers.timestamp, evt.raw, evt.headers.signature), true);

  const base = `http://127.0.0.1:${server.health().port}`;
  const token = `${secrets.tokenId}.${secrets.inboundToken}`;
  const first = await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaign: 'demo',
      items: [{ id: item.id, expect: { questionId: item.id, status: 'open' }, answer: { choices: ['now'] } }],
    }),
  });
  assert.equal(first.status, 200);
  const saved = server.store.load('demo').items[0];
  assert.equal(saved.answeredVia, `relay:${secrets.tokenId}`);
  assert.equal(saved.answeredBy, 'owner');
  assert.equal(saved.status, 'saved');

  const second = await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaign: 'demo',
      items: [{ id: item.id, expect: { questionId: item.id }, answer: { choices: ['later'] } }],
    }),
  });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.reason, 'answered');
  assert.equal(body.answeredVia, `relay:${secrets.tokenId}`);

  // Web override still allowed (last write wins).
  const web = await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaign: 'demo',
      items: [{ id: item.id, answer: { choices: ['later'], note: '网页改答' } }],
    }),
  });
  assert.equal(web.status, 200);
  assert.equal(server.store.load('demo').items[0].answeredVia, 'web');
  assert.equal(server.store.load('demo').items[0].answer.choices[0], 'later');

  // Secrets must not appear in inbox.json or logs dump of home public files.
  const inbox = fs.readFileSync(path.join(config.campaigns[0].dir, 'inbox.json'), 'utf8');
  assert.doesNotMatch(inbox, new RegExp(secrets.inboundToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(inbox, new RegExp(secrets.signingSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.privateDir, 'relays', 'demo.json'), 'utf8')).inboundTokenHash, hashRelayToken(secrets.inboundToken));
  assert.ok(!('inboundToken' in JSON.parse(fs.readFileSync(path.join(config.privateDir, 'relays', 'demo.json'), 'utf8'))));
  assert.ok(home.startsWith(os.tmpdir()) || home.includes('inbox-relay-'));
});

test('relay withdraw only own answer; web withdraw emits withdrawn', async t => {
  const { config } = setup(t);
  const bridge = await startBridge();
  t.after(() => bridge.stop());
  const server = await createInboxServer({
    config,
    fetch: (url, init) => String(url).startsWith(bridge.url) ? fetch(url, init) : Promise.resolve(new Response(null, { status: 200 })),
    relaySleep: async () => {},
  });
  await server.start();
  t.after(() => server.stop());
  const secrets = await enableRelay(server, 'demo', bridge.url);
  const item = await server.admin('ask', { campaign: 'demo', item: question() });
  await server.relay.queues.get('demo');
  const base = `http://127.0.0.1:${server.health().port}`;
  const token = `${secrets.tokenId}.${secrets.inboundToken}`;
  await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: 'demo', items: [{ id: item.id, answer: { choices: ['now'] } }] }),
  });
  const submissionId = server.store.load('demo').items[0].submissionId;
  const withdrawn = await fetch(`${base}/api/item/demo/${item.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'withdraw', expect: { submissionId } }),
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(server.store.load('demo').items[0].status, 'open');
  await server.relay.queues.get('demo');
  assert.ok(bridge.events.some(e => e.body.event === 'answer.withdrawn'));

  // Web answers then relay cannot withdraw it.
  await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: 'demo', items: [{ id: item.id, answer: { choices: ['later'] } }] }),
  });
  const denied = await fetch(`${base}/api/item/demo/${item.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'withdraw' }),
  });
  assert.equal(denied.status, 409);
});

test('replaced and closed reasons; concurrent relay submits only one wins', async t => {
  const { config } = setup(t);
  const server = await createInboxServer({ config, fetch: async () => new Response(null, { status: 200 }), relaySleep: async () => {} });
  await server.start();
  t.after(() => server.stop());
  const secrets = await enableRelay(server, 'demo', 'http://127.0.0.1:9/no-bridge');
  const first = await server.admin('ask', { campaign: 'demo', item: question() });
  const second = await server.admin('ask', { campaign: 'demo', item: question({ title: '修订', replaces: first.id }) });
  const base = `http://127.0.0.1:${server.health().port}`;
  const token = `${secrets.tokenId}.${secrets.inboundToken}`;
  const replaced = await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: 'demo', items: [{ id: first.id, answer: { choices: ['now'] } }] }),
  });
  assert.equal(replaced.status, 409);
  assert.equal((await replaced.json()).reason, 'replaced');

  const open = server.store.load('demo').items.find(i => i.id === second.id);
  const results = await Promise.all([0, 1].map(() => fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: 'demo', items: [{ id: open.id, expect: { questionId: open.id, status: 'open' }, answer: { choices: ['now'] } }] }),
  })));
  const codes = results.map(r => r.status).sort();
  assert.deepEqual(codes, [200, 409]);

  await server.admin('ack', { id: open.id });
  await server.admin('close', { id: open.id });
  const closed = await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: 'demo', items: [{ id: open.id, answer: { choices: ['later'] } }] }),
  });
  assert.equal(closed.status, 409);
  assert.equal((await closed.json()).reason, 'closed');
});

test('payload builder omits absolute paths and askerThreadId', () => {
  const item = {
    id: 'Q1', kind: 'decide', title: 'T', ticket: 1, askerLabel: 'L', askerThreadId: 'secret',
    status: 'open', background: [], options: [{ key: 'a', label: 'A', consequence: 'c' }], media: [{ path: 'media/a.png' }],
  };
  const body = buildRelayEvent({
    event: 'question.opened',
    item,
    campaignId: 'demo',
    config: { name: 'machine-a', port: 19791, remote: { type: 'none' }, campaigns: [{ id: 'demo', dir: path.join(os.tmpdir(), 'x') }] },
    relayConfig: { language: 'zh', mediaBase: 'loopback', maxTextChars: 1500 },
  });
  assert.equal(body.question.askerThreadId, undefined);
  assert.doesNotMatch(JSON.stringify(body), /askerThreadId/);
});

test('relay resend and failed delivery records relay.state', async t => {
  const { config } = setup(t);
  let calls = 0;
  const server = await createInboxServer({
    config,
    fetch: async () => {
      calls++;
      return new Response(null, { status: 500 });
    },
    relaySleep: async () => {},
  });
  await server.start();
  t.after(() => server.stop());
  await enableRelay(server, 'demo', 'http://127.0.0.1:9/down');
  const item = await server.admin('ask', { campaign: 'demo', item: question() });
  await server.relay.queues.get('demo');
  assert.equal(server.store.load('demo').items[0].relay.state, 'failed');
  assert.ok(calls >= 3);
  const before = calls;
  await server.admin('relay-resend', { campaign: 'demo', id: item.id });
  assert.equal(calls, before + 1);
});
