import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setup, configureProject } from '../setup.mjs';
import { doctor } from '../doctor.mjs';
import { loadConfig, saveConfig } from '../config.mjs';
import { campaignRoutingPath, loadCampaignRouting, routingPath, saveRouting, seedBuiltinRouting } from '../routing.mjs';
import { main } from '../inbox.mjs';
import { autostart } from '../autostart.mjs';

async function temporary(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'setup-test-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
test('prefilled setup is repeatable, preserves registrations, and writes project link once', async t => {
  const home = await temporary(t), projectRoot = path.join(home, 'repo'); await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Existing instructions\nKeep this.\n');
  const config = loadConfig({ home }); config.campaigns = [{ id: 'existing' }]; config.peers = [{ name: 'other' }]; saveConfig(config);
  const answers = { machine: { name: 'trial', port: 19880, remotePort: 19881 }, project: { root: projectRoot, storage: path.join(home, 'storage'), permissions: 'Ask before push.', tests: 'node --test' } };
  let installs = 0;
  const options = { home, startup: async () => { installs++; }, fetchImpl: async (url, init) => { assert.deepEqual(JSON.parse(init.body), {}); return Response.json({ ok: true, machine: 'trial', port: 19880, remotePort: 19881 }); } };
  await setup(answers, options); await setup(answers, options);
  assert.equal(installs, 2);
  assert.deepEqual(loadConfig({ home }).campaigns, config.campaigns); assert.deepEqual(loadConfig({ home }).peers, config.peers);
  assert.equal(loadConfig({ home }).lanTrustSubnet, false);
  const agents = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Keep this/); assert.equal(agents.split('docs/agents/orchestration.md').length, 2);
  await assert.rejects(configureProject({ ...answers.project, tests: 'changed' }), /already exist/);
});
test('setup 写回前重读 campaigns/peers，不覆盖手改', async t => {
  const home = await temporary(t);
  const config = loadConfig({ home }); config.campaigns = [{ id: 'keep' }]; config.peers = [{ name: 'old' }]; saveConfig(config);
  const answers = { machine: { name: 'trial', port: 19882, remotePort: 19883 } };
  const edited = loadConfig({ home });
  edited.peers = [{ name: 'hand-edited' }];
  edited.campaigns = [{ id: 'keep' }, { id: 'added' }];
  saveConfig(edited);
  // First read returns stale registrations; second read must take disk (hand-edited).
  let reads = 0;
  await setup(answers, {
    home,
    install: false,
    readConfig: opts => {
      reads++;
      const current = loadConfig(opts);
      if (reads === 1) return { ...current, campaigns: [{ id: 'stale' }], peers: [{ name: 'stale' }] };
      return current;
    },
  });
  assert.equal(reads, 2);
  const loaded = loadConfig({ home });
  assert.equal(loaded.name, 'trial');
  assert.deepEqual(loaded.peers, edited.peers);
  assert.deepEqual(loaded.campaigns, edited.campaigns);
});
test('setup validates remote modes and ports before install', async t => {
  const home = await temporary(t);
  for (const remote of [{ type: 'unknown' }, { type: 'url', publicUrl: 'file:///x' }, { type: 'url', publicUrl: 'https://u:p@example.test/' }, { type: 'ssh-reverse', publicUrl: 'https://example.test/' }]) {
    await assert.rejects(setup({ machine: { remote } }, { home, install: false }));
  }
  await assert.rejects(setup({ machine: { port: 18781, remotePort: 18781 } }, { home, install: false }), /distinct/);
  for (const type of ['none', 'tailscale', 'cloudflared', 'url', 'ssh-reverse']) {
    const remote = type === 'none' ? { type } : { type, publicUrl: 'https://example.test/', sshHost: 'relay', remoteBindPort: 19781 };
    await setup({ machine: { remote } }, { home, install: false });
    assert.equal(loadConfig({ home }).remote.type, type);
  }
});
test('doctor reports actionable failures and never initializes private configuration', async t => {
  const home = await temporary(t);
  const result = await doctor({ home, nodeVersion: '20.0.0', run: async () => { throw new Error('private diagnostic'); }, startup: async () => ({ enabled: false }) });
  assert.equal(result.ok, false);
  assert.ok(result.checks.filter(x => !x.ok).every(x => x.fix));
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
  await assert.rejects(readFile(path.join(home, '.agents/orchestration/machine.json')));
});
test('doctor distinguishes unrelated occupied ports from healthy configured Inbox', async t => {
  const home = await temporary(t);
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const config = loadConfig({ home }); config.name = 'trial'; config.port = server.address().port; config.remotePort = config.port; saveConfig(config);
  const { privateText } = await import('../config.mjs'); privateText(config.privateDir, 'admin-token', 'doctor-admin-token');
  const options = { home, run: async () => ({}), startup: async () => ({ enabled: true }), fetchImpl: async () => Response.json({ ok: true, machine: 'unrelated' }) };
  assert.equal((await doctor(options)).checks.find(x => x.name === 'port').ok, false);
  assert.equal((await doctor(options)).checks.find(x => x.name === 'admin-token').ok, true);
  options.fetchImpl = async () => Response.json({ ok: true, machine: 'trial', port: config.port, remotePort: config.remotePort });
  const owned = await doctor(options); assert.equal(owned.checks.find(x => x.name === 'port').ok, true); assert.equal(owned.ok, false); // identical ports
});
test('phone QR refuses redirected output before contacting service', async () => {
  await assert.rejects(main(['phone-qr'], { output: { isTTY: false }, fetchImpl: () => assert.fail('must not fetch') }), /interactive terminal/);
});
test('phone QR never returns or prints plaintext credential', async t => {
  const home = await temporary(t); const config = loadConfig({ home }); const { privateText } = await import('../config.mjs'); privateText(config.privateDir, 'admin-token', 'doctor-admin-token'); let text = '';
  const result = await main(['phone-qr'], { home, output: { isTTY: true, write: value => { text += value; } }, fetchImpl: async () => Response.json({ url: 'https://example.test/?k=memory-only' }) });
  assert.deepEqual(result, { ok: true }); assert.doesNotMatch(text, /memory-only|https:/); assert.match(text, /Scan locally/);
});
test('doctor uses each remote CLI version command, including OpenSSH -V', async t => {
  const home = await temporary(t);
  for (const [type, executable, args] of [['ssh-reverse', 'ssh', ['-V']], ['tailscale', 'tailscale', ['version']], ['cloudflared', 'cloudflared', ['--version']]]) {
    const config = loadConfig({ home }); config.port = 0; config.remotePort = 0; config.remote = { type, publicUrl: 'https://example.test/' }; saveConfig(config);
    let checked = false;
    const result = await doctor({ home, startup: async () => ({ enabled: true }), run: async (file, actual) => { if (file === executable) { assert.deepEqual(actual, args); checked = true; } return {}; } });
    assert.ok(checked); assert.equal(result.checks.find(check => check.name === executable).ok, true);
  }
});
test('setup refreshes a running Linux service so remote and login changes take effect', async t => {
  const home = await temporary(t);
  const config = loadConfig({ home }); config.name = 'trial'; config.port = 19890; config.remotePort = 19891; saveConfig(config);
  let running = structuredClone(config); // An existing process; enable --now alone leaves it unchanged.
  const startup = (command, options) => autostart(command, { ...options, platform: 'linux', run: async (file, args) => {
    if (args.includes('restart')) running = loadConfig({ home });
    return { stdout: '' };
  } });
  const result = await setup({ machine: { remote: { type: 'url', publicUrl: 'https://example.test/' }, lanTrustSubnet: true } }, { home, startup, fetchImpl: async () => Response.json({ ok: true, machine: running.name, port: running.port, remotePort: running.remotePort }) });
  assert.equal(result.healthy, true); assert.equal(running.remote.type, 'url'); assert.equal(running.lanTrustSubnet, true);
  const { privateText } = await import('../config.mjs');
  assert.ok(privateText(loadConfig({ home }).privateDir, 'admin-token'));
});
test('Windows setup restart ends an installed task before recreating and starting it', async t => {
  const home = await temporary(t), calls = [];
  await autostart('install', { home, platform: 'win32', user: 'trial', restart: true, run: async (file, args) => { calls.push(args[0]); return {}; } });
  assert.deepEqual(calls, ['/Query', '/End', '-NoProfile', '/Create', '/Run']);
});
test('configureProject omits capacity and routing; requires storage, permissions, tests', async t => {
  const home = await temporary(t), root = path.join(home, 'repo');
  await mkdir(root);
  await assert.rejects(configureProject({ root, permissions: 'Ask', tests: 'node --test' }), /storage/);
  await assert.rejects(configureProject({ root, storage: path.join(home, 'storage'), tests: 'node --test' }), /permissions/);
  await assert.rejects(configureProject({ root, storage: path.join(home, 'storage'), permissions: 'Ask' }), /tests/);
  const target = await configureProject({
    root,
    storage: path.join(home, 'storage'),
    owner: 'Ada',
    permissions: 'Ask before push.',
    tests: 'node --test',
    capacity: 3,
    designCapacity: 0,
    routing: 'legacy project routing must not be written',
  });
  const settings = await readFile(target, 'utf8');
  assert.match(settings, /Campaign storage/);
  assert.match(settings, /Owner display name: Ada/);
  assert.match(settings, /Inbox routing settings/);
  assert.match(settings, /routing-import/);
  assert.doesNotMatch(settings, /Running tickets|Tickets needing new design|legacy project routing/);
  assert.doesNotMatch(settings, /designCapacity|Running tickets:/);
});
test('setup hints routing-import when routing.json is missing and writes Campaign overrides', async t => {
  const home = await temporary(t);
  const campaignDir = path.join(home, 'campaigns', 'demo');
  await mkdir(campaignDir, { recursive: true });
  const missing = await setup({
    machine: { name: 'trial', port: 19910, remotePort: 19911 },
    campaignRouting: { dir: campaignDir, limits: { execution: 2 } },
  }, { home, install: false });
  assert.equal(missing.routing.present, false);
  assert.match(missing.routing.fix, /routing-import/);
  assert.deepEqual(loadCampaignRouting(campaignDir).limits, { execution: 2 });
  assert.ok(!(await readFile(routingPath(home), 'utf8').then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })));

  saveRouting(home, seedBuiltinRouting());
  const present = await setup({ machine: { name: 'trial', port: 19910, remotePort: 19911 } }, { home, install: false });
  assert.equal(present.routing.present, true);
  assert.equal(present.routing.fix, undefined);
  assert.ok(await readFile(campaignRoutingPath(campaignDir), 'utf8'));
});
