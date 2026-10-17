import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setup, configureProject } from '../setup.mjs';
import { doctor } from '../doctor.mjs';
import { loadConfig, saveConfig } from '../config.mjs';
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
  const answers = { machine: { name: 'trial', port: 19880, remotePort: 19881 }, project: { root: projectRoot, storage: path.join(home, 'storage'), routing: 'Owner-selected catalog profiles.', permissions: 'Ask before push.', tests: 'node --test' } };
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
  const options = { home, run: async () => ({}), startup: async () => ({ enabled: true }), fetchImpl: async () => Response.json({ ok: true, machine: 'unrelated' }) };
  assert.equal((await doctor(options)).checks.find(x => x.name === 'port').ok, false);
  options.fetchImpl = async () => Response.json({ ok: true, machine: 'trial', port: config.port, remotePort: config.remotePort });
  const owned = await doctor(options); assert.equal(owned.checks.find(x => x.name === 'port').ok, true); assert.equal(owned.ok, false); // identical ports
});
test('phone QR refuses redirected output before contacting service', async () => {
  await assert.rejects(main(['phone-qr'], { output: { isTTY: false }, fetchImpl: () => assert.fail('must not fetch') }), /interactive terminal/);
});
test('phone QR never returns or prints plaintext credential', async t => {
  const home = await temporary(t); let text = '';
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
});
test('Windows setup restart ends an installed task before recreating and starting it', async t => {
  const home = await temporary(t), calls = [];
  await autostart('install', { home, platform: 'win32', user: 'trial', restart: true, run: async (file, args) => { calls.push(args[0]); return {}; } });
  assert.deepEqual(calls, ['/Query', '/End', '/Create', '/Run']);
});
