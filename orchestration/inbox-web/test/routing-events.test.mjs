import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, privateText } from '../config.mjs';
import { createInboxServer } from '../server.mjs';
import { loadRouting, saveRouting, seedBuiltinRouting } from '../routing.mjs';
import { buildRoutingChangeEvent } from '../routing-events.mjs';
import { verifyInboundReport } from '../../scripts/orchestrator-target.mjs';
import { main as reportMain } from '../../scripts/report.mjs';
import { main as inboxMain } from '../inbox.mjs';

const codeTier = (model, value = 'high') => ({ instanceId: 'pi', model, options: [{ id: 'thinking', value }] });

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-routing-events-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function addCampaign(config, home, id, campaignJson = {}) {
  const dir = path.join(home, 'campaigns', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ id, ...campaignJson }));
  config.campaigns.push({ id, title: id, dir });
  return dir;
}

function response(status = 200) {
  return new Response('', { status });
}

async function startMachine(t, root, { campaigns = [], fetchImpl, homeDir = 'home' } = {}) {
  const home = path.join(root, homeDir);
  const config = loadConfig({ home });
  config.name = 'workstation-a';
  config.port = 0;
  config.remotePort = 0;
  config.lanTrustSubnet = true;
  config.peers = [];
  config.campaigns = [];
  config.remote = { type: 'none' };
  const dirs = campaigns.map(([id, json]) => addCampaign(config, home, id, json));
  saveConfig(config);
  saveRouting(home, seedBuiltinRouting());
  const logs = [];
  const server = await createInboxServer({
    config,
    host: '127.0.0.1',
    interfaces: { eth0: [{ address: '192.168.1.10', netmask: '255.255.255.0', internal: false, family: 'IPv4' }] },
    push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} },
    fetch: fetchImpl,
    log: entry => logs.push(entry),
  });
  await server.start();
  t.after(() => server.stop());
  return { home, config, logs, dirs, base: `http://127.0.0.1:${server.health().port}` };
}

function recordingFetch(reply = () => response(200)) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: init.body });
    return reply(String(url), init);
  };
  return { calls, fetchImpl };
}

function putRouting(base, body, { origin = base } = {}) {
  return fetch(`${base}/api/routing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
}

function parseBody(call) {
  return JSON.parse(String(call.body));
}

test('buildRoutingChangeEvent reports tier before/after without secrets and skips no-ops', () => {
  const before = seedBuiltinRouting();
  const after = structuredClone(before);
  after.version = before.version + 1;
  after.updatedAt = '2026-10-29T04:00:00.000Z';
  after.global.routes.code.tiers = [codeTier('cursor/grok-4.5', 'low'), ...before.global.routes.code.tiers.slice(1)];

  const event = buildRoutingChangeEvent({
    scope: 'global',
    beforeLayer: before.global,
    afterLayer: after.global,
    routingVersion: after.version,
    changedBy: 'ui',
    changedAt: '2026-10-29T04:00:00.000Z',
  });
  assert.equal(event.schema, 'orch-report/1');
  assert.equal(event.event, 'routing-change');
  assert.equal(event.routingChange.scope, 'global');
  assert.equal(event.routingChange.changedBy, 'ui');
  assert.equal(event.routingChange.changedAt, '2026-10-29T04:00:00.000Z');
  assert.equal(event.routingChange.routingVersion, after.version);
  assert.deepEqual(event.routingChange.routes.map(route => route.type), ['code']);
  assert.equal(event.routingChange.routes[0].before[0].model, 'xai/grok-4.5');
  assert.deepEqual(event.routingChange.routes[0].after[0], codeTier('cursor/grok-4.5', 'low'));
  assert.match(event.summary, /code/);
  const text = JSON.stringify(event);
  assert.ok(!/https?:\/\//i.test(text), 'event must not carry URLs');
  assert.ok(!/webhook|token|secret|authorization/i.test(text), 'event must not carry secret-shaped fields');

  assert.equal(buildRoutingChangeEvent({
    scope: 'global', beforeLayer: before.global, afterLayer: structuredClone(before.global), routingVersion: 2,
  }), null, 'identical layers must not produce an event');

  const quotaEvent = buildRoutingChangeEvent({
    scope: 'global',
    beforeLayer: before.global,
    afterLayer: {
      routes: before.global.routes,
      limits: before.global.limits,
      quota: { 'pi/xai/grok-4.5': { exhausted: true, resumeAt: null, markedBy: 'owner', markedAt: '2026-10-29T04:00:00.000Z' } },
    },
    routingVersion: 3,
    changedBy: 'api',
  });
  assert.deepEqual(quotaEvent.routingChange.routes, []);
  assert.deepEqual(quotaEvent.routingChange.quota.map(entry => entry.key), ['pi/xai/grok-4.5']);
  assert.equal(quotaEvent.routingChange.quota[0].before, null);

  const campaignEvent = buildRoutingChangeEvent({
    scope: 'campaign',
    campaignId: 'demo',
    beforeLayer: {},
    afterLayer: { routes: { design: { tiers: [codeTier('cursor/grok-4.5')] } } },
    routingVersion: 3,
    changedBy: 'ui',
  });
  assert.equal(campaignEvent.routingChange.scope, 'campaign');
  assert.equal(campaignEvent.routingChange.campaignId, 'demo');
  assert.equal(campaignEvent.campaign, 'demo');
  assert.deepEqual(campaignEvent.routingChange.routes[0].before, null);
});

test('UI and API saves deliver one signed event per affected Campaign; external event verifies', async t => {
  const root = tempRoot(t);
  const webhook = 'http://127.0.0.1:9/inbox/t3?token=hidden';
  const externalUrl = 'http://127.0.0.1:9/ext?secret=hidden';
  const { calls, fetchImpl } = recordingFetch();
  const { home, config, base, dirs } = await startMachine(t, root, {
    campaigns: [
      ['demo', { id: 'demo', orchestrator: 'mcp:thread-1' }],
      ['ext', { id: 'ext', orchestratorKind: 'external', orchestratorRef: 'bot1' }],
    ],
    fetchImpl,
  });
  privateText(config.privateDir, 'webhooks/demo.url', webhook);
  privateText(config.privateDir, 'orchestrators/bot1.json', JSON.stringify({
    type: 'webhook', url: externalUrl, signingSecret: 'test-signing-secret', queueOnly: true,
  }));

  const tiers = [codeTier('cursor/grok-4.5', 'low'), ...loadRouting(home).global.routes.code.tiers.slice(1)];
  const uiSave = await putRouting(base, {
    layer: 'global',
    expectedVersion: loadRouting(home).version,
    patch: { routes: { code: { tiers } } },
  });
  assert.equal(uiSave.status, 200);
  assert.equal(calls.length, 2, 'one event per affected Campaign');

  const t3 = calls.find(call => call.url === webhook);
  assert.ok(t3, 't3-thread Campaign receives the event on the Inbox webhook path');
  const t3Body = parseBody(t3);
  assert.equal(t3Body.event, 'routing-change');
  assert.equal(t3Body.campaign, 'demo');
  assert.equal(t3Body.routingChange.scope, 'global');
  assert.equal(t3Body.routingChange.changedBy, 'ui');
  assert.deepEqual(t3Body.routingChange.routes.map(route => route.type), ['code']);
  assert.equal(t3.headers['X-Orch-Queue'], '1');

  const external = calls.find(call => call.url === externalUrl);
  assert.ok(external, 'external Campaign receives a signed report-shaped event');
  const externalBody = parseBody(external);
  assert.equal(externalBody.schema, 'orch-report/1');
  assert.equal(externalBody.campaign, 'ext');
  assert.match(external.headers['X-Orch-Signature'], /^sha256=[0-9a-f]{64}$/);
  assert.match(external.headers['X-Orch-Id'], /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(externalBody).includes('hidden'));

  const bodyFile = path.join(root, 'body.txt');
  const headersFile = path.join(root, 'headers.json');
  fs.writeFileSync(bodyFile, String(external.body));
  fs.writeFileSync(headersFile, JSON.stringify({
    'X-Orch-Signature': external.headers['X-Orch-Signature'],
    'X-Orch-Timestamp': external.headers['X-Orch-Timestamp'],
    'X-Orch-Id': external.headers['X-Orch-Id'],
  }));
  assert.deepEqual(
    verifyInboundReport({ home, campaignDir: dirs[1], bodyText: String(external.body), headers: JSON.parse(fs.readFileSync(headersFile, 'utf8')), recordReplay: false }),
    { ok: true },
  );

  const chunks = [];
  const output = { write: text => chunks.push(text), isTTY: false };
  await reportMain(['verify', '--campaign-dir', dirs[1], '--body-file', bodyFile, '--headers-file', headersFile], { home, output });
  assert.equal(chunks.join('').trim(), '{"ok":true}', 'report.mjs verify accepts the routing event');

  // API save (no browser Origin) is recorded as api and still emits exactly one event per Campaign.
  calls.length = 0;
  const apiSave = await putRouting(base, {
    layer: 'global',
    expectedVersion: loadRouting(home).version,
    patch: { routes: { code: { tiers: tiers.map(tier => ({ ...tier })), } } },
  }, { origin: null });
  assert.equal(apiSave.status, 200);
  assert.equal(calls.length, 0, 'a save without tier changes emits no event');

  const changed = [codeTier('cursor/grok-4.5', 'medium'), ...tiers.slice(1)];
  const apiChange = await putRouting(base, {
    layer: 'global',
    expectedVersion: loadRouting(home).version,
    patch: { routes: { code: { tiers: changed } } },
  }, { origin: null });
  assert.equal(apiChange.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(parseBody(calls[0]).routingChange.changedBy, 'api');
});

test('Campaign-layer changes notify only that Campaign and delivery failures never block the save', async t => {
  const root = tempRoot(t);
  const { calls, fetchImpl } = recordingFetch();
  const { home, config, base, dirs } = await startMachine(t, root, {
    campaigns: [
      ['demo', { id: 'demo' }],
      ['other', { id: 'other' }],
    ],
    fetchImpl,
  });
  privateText(config.privateDir, 'webhooks/demo.url', 'http://127.0.0.1:9/inbox/demo');
  privateText(config.privateDir, 'webhooks/other.url', 'http://127.0.0.1:9/inbox/other');

  const patch = { routes: { design: { tiers: [codeTier('cursor/grok-4.5')] } } };
  const saved = await putRouting(base, {
    layer: 'campaign',
    campaign: 'demo',
    expectedVersion: loadRouting(home).version,
    patch,
  });
  assert.equal(saved.status, 200);
  assert.equal(calls.length, 1, 'campaign layer only wakes its own Campaign');
  assert.equal(calls[0].url, 'http://127.0.0.1:9/inbox/demo');
  const body = parseBody(calls[0]);
  assert.equal(body.routingChange.scope, 'campaign');
  assert.equal(body.routingChange.campaignId, 'demo');

  // Session 2: every delivery fails; the save still succeeds and the failure is logged without URLs.
  const failing = await startMachine(t, root, {
    campaigns: [['demo', { id: 'demo' }]],
    fetchImpl: async () => { throw new Error('http://127.0.0.1:9/secret?token=leak'); },
  });
  privateText(failing.config.privateDir, 'webhooks/demo.url', 'http://127.0.0.1:9/inbox/demo');
  const stillSaved = await putRouting(failing.base, {
    layer: 'global',
    expectedVersion: loadRouting(failing.home).version,
    patch: { routes: { code: { tiers: [codeTier('cursor/grok-4.5', 'low')] } } },
  });
  assert.equal(stillSaved.status, 200, 'a delivery failure must not block the routing save');
  const failure = failing.logs.find(entry => entry.event === 'routing-event' && entry.result === 'failed');
  assert.ok(failure, 'delivery failures are logged');
  assert.equal(failure.campaign, 'demo');
  assert.ok(!JSON.stringify(failing.logs).includes('leak'), 'logs never contain the endpoint URL');
  assert.ok(!JSON.stringify(failing.logs).includes('token='));
});

test('machine-layer change notifies every Campaign on the machine', async t => {
  const root = tempRoot(t);
  const { calls, fetchImpl } = recordingFetch();
  const { home, config, base } = await startMachine(t, root, {
    campaigns: [['demo', { id: 'demo' }], ['other', { id: 'other' }]],
    fetchImpl,
  });
  privateText(config.privateDir, 'webhooks/demo.url', 'http://127.0.0.1:9/inbox/demo');
  privateText(config.privateDir, 'webhooks/other.url', 'http://127.0.0.1:9/inbox/other');

  const saved = await putRouting(base, {
    layer: 'machine',
    machine: 'workstation-a',
    expectedVersion: loadRouting(home).version,
    patch: { routes: { review: { tiers: [codeTier('cursor/grok-4.5')] } } },
  });
  assert.equal(saved.status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const body = parseBody(call);
    assert.equal(body.routingChange.scope, 'machine');
    assert.equal(body.routingChange.machine, 'workstation-a');
    assert.equal(body.routingChange.routes[0].type, 'review');
  }
});

test('a peer global sync wakes the receiving machine Campaigns once', async t => {
  const root = tempRoot(t);
  const incoming = recordingFetch();
  const a = await startMachine(t, root, { campaigns: [['demo', { id: 'demo' }]], homeDir: 'machine-a' });
  const b = await startMachine(t, root, { campaigns: [['demo', { id: 'demo' }]], homeDir: 'machine-b', fetchImpl: incoming.fetchImpl });
  for (const file of ['remote-token', 'cookie-key']) {
    fs.copyFileSync(path.join(a.config.privateDir, file), path.join(b.config.privateDir, file));
  }
  a.config.peers = [{ name: 'workstation-b', lanUrl: `${b.base}/` }];
  b.config.peers = [{ name: 'workstation-a', lanUrl: `${a.base}/` }];
  saveConfig(a.config); saveConfig(b.config);
  privateText(b.config.privateDir, 'webhooks/demo.url', 'http://127.0.0.1:9/inbox/demo');

  const saved = await putRouting(a.base, {
    layer: 'global',
    expectedVersion: loadRouting(a.home).version,
    patch: { routes: { review: { tiers: [codeTier('cursor/grok-4.5', 'low')] } } },
  });
  assert.equal(saved.status, 200);
  assert.equal(incoming.calls.length, 1, 'the receiving machine notifies its Campaign once');
  const body = parseBody(incoming.calls[0]);
  assert.equal(body.campaign, 'demo');
  assert.equal(body.routingChange.scope, 'global');
  assert.equal(body.routingChange.changedBy, 'sync');
  assert.equal(body.routingChange.routes[0].type, 'review');
});

test('CLI routing writers emit an event that report.mjs verify would accept', async t => {
  const root = tempRoot(t);
  const { calls, fetchImpl } = recordingFetch();
  const home = path.join(root, 'home');
  const config = loadConfig({ home });
  config.name = 'workstation-a';
  config.campaigns = [];
  config.remote = { type: 'none' };
  addCampaign(config, home, 'ext', { id: 'ext', orchestratorKind: 'external', orchestratorRef: 'bot1' });
  saveConfig(config);
  saveRouting(home, seedBuiltinRouting());
  privateText(config.privateDir, 'orchestrators/bot1.json', JSON.stringify({
    type: 'webhook', url: 'http://127.0.0.1:9/ext', signingSecret: 'cli-signing-secret', queueOnly: true,
  }));

  const chunks = [];
  const output = { write: text => chunks.push(text), isTTY: false };
  await inboxMain(['quota', 'mark', 'pi/xai/grok-4.5', '--by', 'orchestrator'], { home, output, fetchImpl });
  assert.equal(calls.length, 1);
  const body = parseBody(calls[0]);
  assert.equal(body.event, 'routing-change');
  assert.equal(body.routingChange.changedBy, 'cli');
  assert.deepEqual(body.routingChange.quota.map(entry => entry.key), ['pi/xai/grok-4.5']);
  assert.equal(calls[0].headers['X-Orch-Queue'], '1');
  assert.match(calls[0].headers['X-Orch-Signature'], /^sha256=[0-9a-f]{64}$/);

  // Unmarking a model that was never marked is a no-op and emits nothing.
  await inboxMain(['quota', 'clear', 'cursor/grok-4.5'], { home, output, fetchImpl });
  assert.equal(calls.length, 1);
});
