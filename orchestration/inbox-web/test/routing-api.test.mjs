import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, privateText } from '../config.mjs';
import { Access, canManage } from '../access.mjs';
import { createInboxServer } from '../server.mjs';
import { seedBuiltinRouting, loadRouting, saveRouting, resolveRoute } from '../routing.mjs';
const importRulesRouting = seedBuiltinRouting;
import { parseCommand, main } from '../inbox.mjs';

function pushStub() {
  return { publicKey: 'test', start() {}, stop() {}, enqueue() {}, problem() {} };
}

function tempPair(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-routing-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function startMachine(t, root, name, { peers = [], lanTrustSubnet = true } = {}) {
  const home = path.join(root, name);
  const config = loadConfig({ home });
  const dir = path.join(home, 'campaign');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ id: 'demo', title: name }));
  Object.assign(config, {
    name,
    port: 0,
    remotePort: 0,
    lanTrustSubnet,
    peers,
    campaigns: [{ id: 'demo', title: name, dir }],
    remote: { type: 'none' },
  });
  saveConfig(config);
  saveRouting(home, importRulesRouting());
  const server = await createInboxServer({
    config,
    host: '127.0.0.1',
    interfaces: { eth0: [{ address: '192.168.1.10', netmask: '255.255.255.0', internal: false, family: 'IPv4' }] },
    push: pushStub(),
  });
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.health().port}`;
  return { home, config, server, base, dir };
}

test('canManage: cookie or trusted LAN; remote needs cookie', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-can-manage-'));
  try {
    const access = new Access(path.join(home, '.agents', 'orchestration', 'private'));
    const config = { lanTrustSubnet: true, lanTrustCidrs: ['192.168.1.0/24'] };
    const interfaces = { eth0: [{ address: '192.168.1.10', netmask: '255.255.255.0', internal: false, family: 'IPv4' }] };
    const lanReq = { headers: { cookie: '' }, socket: { remoteAddress: '192.168.1.20' } };
    assert.equal(canManage(lanReq, { access, config, isRemote: false, interfaces }), true);
    assert.equal(canManage(lanReq, { access, config, isRemote: true, interfaces }), false);
    const cookieReq = { headers: { cookie: `inbox_session=${access.cookie()}` }, socket: { remoteAddress: '203.0.113.9' } };
    assert.equal(canManage(cookieReq, { access, config: { lanTrustSubnet: false }, isRemote: true, interfaces }), true);
    assert.equal(canManage(lanReq, { access, config: { lanTrustSubnet: false }, isRemote: false, interfaces }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('routing API reads effective values; writes require canManage; version conflicts 409', async t => {
  const root = tempPair(t);
  const { base, config, home } = await startMachine(t, root, 'workstation-a', { lanTrustSubnet: false });
  const read = await fetch(`${base}/api/routing?campaign=demo`);
  assert.equal(read.status, 200);
  const view = await read.json();
  assert.equal(view.effective.limits.execution, 8);
  assert.equal(view.effective.routes.code.tiers[0].source, 'global');

  assert.equal((await fetch(`${base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ layer: 'global', patch: { limits: { execution: 7 } } }),
  })).status, 401);

  const cookie = `inbox_session=${new Access(config.privateDir).cookie()}`;
  const put = await fetch(`${base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base, cookie },
    body: JSON.stringify({ layer: 'global', expectedVersion: view.version, patch: { limits: { execution: 7 } } }),
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.version, view.version + 1);

  const stale = await fetch(`${base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base, cookie },
    body: JSON.stringify({ layer: 'global', expectedVersion: view.version, patch: { limits: { execution: 6 } } }),
  });
  assert.equal(stale.status, 409);

  const summary = await (await fetch(`${base}/api/summary`, { headers: { cookie } })).json();
  assert.equal(summary.canManage, true);
  assert.equal(summary.routingSync.version, loadRouting(home).version);

  const cross = await fetch(`${base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', cookie },
    body: JSON.stringify({
      layer: 'machine',
      machine: config.name,
      expectedVersion: loadRouting(home).version,
      patch: { limits: { execution: 3 } },
    }),
  });
  assert.equal(cross.status, 403);
});

test('quota API marks exhausted and resolve skips that tier', async t => {
  const root = tempPair(t);
  const { base, home } = await startMachine(t, root, 'workstation-a');
  const mark = await fetch(`${base}/api/quota`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      key: 'pi/xai/grok-4.5',
      exhausted: true,
      resumeAt: '2099-01-01T00:00:00.000Z',
      markedBy: 'owner',
      expectedVersion: loadRouting(home).version,
    }),
  });
  assert.equal(mark.status, 200);
  const resolved = resolveRoute({ home, machine: 'workstation-a', type: 'code' });
  assert.equal(resolved.tiers[0].model, 'cursor/grok-4.5');
  assert.equal(resolved.skipped[0].reason, 'exhausted');
});

test('hub sync pushes global routing to peer; stale version rejected; unreachable marked unsynced', async t => {
  const root = tempPair(t);
  const a = await startMachine(t, root, 'workstation-a');
  const b = await startMachine(t, root, 'workstation-b');
  // Share cookie-key for sync signatures.
  for (const file of ['remote-token', 'cookie-key']) {
    fs.copyFileSync(path.join(a.config.privateDir, file), path.join(b.config.privateDir, file));
  }
  a.config.peers = [{ name: 'workstation-b', lanUrl: `${b.base}/` }];
  b.config.peers = [{ name: 'workstation-a', lanUrl: `${a.base}/` }];
  saveConfig(a.config); saveConfig(b.config);

  const before = loadRouting(b.home).version;
  const put = await fetch(`${a.base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: a.base },
    body: JSON.stringify({
      layer: 'global',
      expectedVersion: loadRouting(a.home).version,
      patch: { limits: { execution: 5, design: 2 } },
    }),
  });
  assert.equal(put.status, 200);
  const body = await put.json();
  assert.equal(body.sync.peers['workstation-b'].status, 'ok');
  assert.equal(loadRouting(b.home).global.limits.execution, 5);
  assert.ok(loadRouting(b.home).version > before);

  // Offline peer is marked unsynced in summary.
  a.config.peers = [
    { name: 'workstation-b', lanUrl: `${b.base}/` },
    { name: 'offline', lanUrl: 'http://127.0.0.1:1/' },
  ];
  saveConfig(a.config);
  const again = await fetch(`${a.base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: a.base },
    body: JSON.stringify({
      layer: 'global',
      expectedVersion: loadRouting(a.home).version,
      patch: { limits: { execution: 4, design: 1 } },
    }),
  });
  const synced = await again.json();
  assert.equal(synced.sync.peers.offline.status, 'unreachable');
  const summary = await (await fetch(`${a.base}/api/summary`)).json();
  assert.equal(summary.routingSync.peers.offline.unsynced, true);

  // Machine layer stays local and is not overwritten by sync.
  await fetch(`${b.base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: b.base },
    body: JSON.stringify({
      layer: 'machine',
      machine: 'workstation-b',
      expectedVersion: loadRouting(b.home).version,
      patch: { limits: { execution: 2 } },
    }),
  });
  assert.equal(loadRouting(b.home).machines['workstation-b'].limits.execution, 2);
  await fetch(`${a.base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: a.base },
    body: JSON.stringify({
      layer: 'global',
      expectedVersion: loadRouting(a.home).version,
      patch: { limits: { execution: 3, design: 1 } },
    }),
  });
  assert.equal(loadRouting(b.home).machines['workstation-b'].limits.execution, 2);
  assert.equal(loadRouting(b.home).global.limits.execution, 3);
});

test('CLI route/routes/catalog-write/routing-import/quota work on temp INBOX_HOME', async t => {
  const root = tempPair(t);
  const home = path.join(root, 'cli');
  const config = loadConfig({ home });
  const dir = path.join(home, 'camp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
    id: 'demo',
    tickets: [
      { ticket: 'P33', title: 'templates', stage: '执行中' },
      { ticket: 'P1', title: '', stage: '执行中' },
    ],
  }));
  config.name = 'workstation-a';
  config.campaigns = [{ id: 'demo', title: 'demo', dir }];
  saveConfig(config);

  assert.deepEqual(parseCommand(['route', 'demo', 'code']).values, ['demo', 'code']);
  assert.deepEqual(parseCommand(['route', 'demo', 'code', '--ticket', 'P33']).flags.ticket, 'P33');
  assert.deepEqual(parseCommand(['routes']).values, []);
  assert.throws(() => parseCommand(['quota', 'nope', 'pi/xai/grok-4.5']), /mark|clear|quota/);

  const chunks = [];
  const output = { write: text => chunks.push(text), isTTY: false };
  await main(['routing-import'], { home, output });
  assert.match(chunks.join(''), /"version": 1/);
  await assert.rejects(main(['routing-import'], { home, output }), /已存在/);

  const capabilities = JSON.stringify({
    providers: [{
      providerInstanceId: 'pi',
      models: [{
        id: 'cursor/grok-4.5',
        options: [{ id: 'thinking', type: 'select', options: [{ id: 'high', label: 'High' }] }],
      }],
    }],
  });
  const { Readable } = await import('node:stream');
  // A short capture that omits routed models is refused and nothing is written.
  await assert.rejects(main(['catalog-write'], { home, output, input: Readable.from([capabilities]) }), /缺少路由使用的模型/);
  assert.equal(fs.existsSync(path.join(home, '.agents', 'orchestration', 'catalog.json')), false);
  // Base capture + search lookups (JSON array) are merged; all routed models present → written.
  const { routedModels } = await import('../routing.mjs');
  const lookups = routedModels(home).map(key => {
    const slash = key.indexOf('/');
    return { providers: [{ providerInstanceId: key.slice(0, slash), models: [{ id: key.slice(slash + 1), options: [{ id: 'thinking', type: 'select', options: [{ id: 'high' }] }] }] }] };
  });
  await main(['catalog-write'], { home, output, input: Readable.from([JSON.stringify([JSON.parse(capabilities), ...lookups])]) });
  const stored = JSON.parse(fs.readFileSync(path.join(home, '.agents', 'orchestration', 'catalog.json'), 'utf8'));
  assert.equal(stored.capabilities.providers.find(p => p.providerInstanceId === 'pi').models.filter(m => m.id === 'cursor/grok-4.5').length, 1);
  // Missing previously known options requires explicit confirmation as well.
  chunks.length = 0;
  await assert.rejects(main(['catalog-write', '--allow-missing'], { home, output, input: Readable.from([capabilities]) }), /此前已知/);
  await main(['catalog-write', '--allow-missing', '--allow-option-removal'], { home, output, input: Readable.from([capabilities]) });
  assert.ok(JSON.parse(chunks.join('')).missing.length > 0);
  await main(['catalog-write'], { home, output, input: Readable.from([JSON.stringify([JSON.parse(capabilities), ...lookups])]) });
  await main(['quota', 'mark', 'pi/xai/grok-4.5', '--resume', '2099-01-01T00:00:00.000Z'], { home, output });
  chunks.length = 0;
  await main(['route', 'demo', 'code'], { home, output });
  const routed = JSON.parse(chunks.join(''));
  assert.equal(routed.tiers[0].model, 'cursor/grok-4.5');
  chunks.length = 0;
  await main(['route', 'demo', 'code', '--ticket', 'P33'], { home, output });
  const routedTicket = JSON.parse(chunks.join(''));
  assert.equal(routedTicket.ticketRef, 'P33：templates');
  assert.equal(routedTicket.threadTitle, 'P33：templates');
  assert.equal(routedTicket.title, 'templates');
  await assert.rejects(
    main(['route', 'demo', 'code', '--ticket', 'P1'], { home, output: { write() {}, isTTY: false } }),
    /title/,
  );
  chunks.length = 0;
  await main(['routes', 'demo'], { home, output });
  const all = JSON.parse(chunks.join(''));
  assert.equal(all.limits.execution, 8);
  assert.ok(all.routes.design);
});

test('V4 sanctioned global patch round-trips through API and CLI without changing other owner routes', async t => {
  const root = tempPair(t);
  const { base, home } = await startMachine(t, root, 'v4');
  const tier = (instanceId, model, id = 'thinking') => ({ instanceId, model, options: [{ id, value: 'high' }] });
  const before = loadRouting(home);
  // Owner's v22 order differs from historical import defaults.
  before.global.routes.code.tiers = [tier('pi', 'opencode-go/deepseek-v4.1-flash'), tier('pi', 'xai/grok-4.5'), tier('pi', 'cursor/grok-4.5')];
  before.global.routes.review.tiers = [tier('pi', 'xai/grok-4.5'), tier('pi', 'opencode-go/deepseek-v4.1-flash'), tier('pi', 'cursor/grok-4.5'), tier('codex', 'gpt-6.1-terra', 'reasoningEffort')];
  saveRouting(home, before);
  const visual = { tiers: [tier('codex', 'gpt-6.1-sol', 'reasoningEffort'), tier('claudeAgent', 'claude-opus-5-5', 'effort'), tier('pi', 'cursor/claude-opus-5-5')] };
  const review = { tiers: before.global.routes.review.tiers.filter(item => item.model !== 'gpt-6.1-terra') };
  const put = await fetch(`${base}/api/routing`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ layer: 'global', expectedVersion: before.version, patch: { routes: { visual, review } } }),
  });
  assert.equal(put.status, 200);
  const after = loadRouting(home);
  for (const type of ['code', 'design', 'discussion', 'research', 'adjudication']) {
    assert.deepEqual(after.global.routes[type], before.global.routes[type]);
  }
  assert.deepEqual(after.global.routes.review, review);
  const chunks = [];
  const output = { write: text => chunks.push(text), isTTY: false };
  await main(['route', 'demo', 'visual'], { home, output });
  const resolved = JSON.parse(chunks.join(''));
  assert.deepEqual(resolved.tiers.map(({ source, ...item }) => item), visual.tiers);
  assert.ok(resolved.tiers.every(item => item.source === 'global'));
  chunks.length = 0;
  await main(['routes', 'demo'], { home, output });
  const all = JSON.parse(chunks.join('')).routes;
  assert.equal(all.design.tiers[0].model, 'claude-opus-5-5');
  assert.equal(all.code.tiers[0].model, 'opencode-go/deepseek-v4.1-flash');
  assert.deepEqual(all.review.tiers.map(item => item.model), ['xai/grok-4.5', 'opencode-go/deepseek-v4.1-flash', 'cursor/grok-4.5']);
  chunks.length = 0;
  await main(['route', 'demo', 'housekeeping'], { home, output });
  assert.deepEqual(JSON.parse(chunks.join('')).tiers.map(({ source, ...item }) => item), after.global.routes.housekeeping.tiers);
});
