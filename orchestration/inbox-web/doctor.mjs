import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { readJson } from './config.mjs';
import { autostart } from './autostart.mjs';
import { matchingHealth } from './health.mjs';

const execute = promisify(execFile);
export function availablePort(port, host) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

// Read public configuration only. Never initialize or inspect private state.
export async function doctor({ home = process.env.INBOX_HOME || os.homedir(), run = execute, startup = autostart, fetchImpl = fetch, nodeVersion = process.versions.node } = {}) {
  const checks = [];
  const add = (name, ok, fix) => checks.push({ name, ok, fix: ok ? '' : fix });
  add('Node >= 22', Number(nodeVersion.split('.')[0]) >= 22, 'Install Node.js 22 or later; rerun setup.');
  for (const [name, command, args, fix] of [
    ['git', 'git', ['--version'], 'Install git and add it to PATH.'],
    ['GitHub authentication', 'gh', ['auth', 'status'], 'Install GitHub CLI; run gh auth login. Local smoke tickets do not require GitHub.'],
  ]) {
    // Command output can contain account details. Report exit status only.
    const ok = await run(command, args, { timeout: 10000, windowsHide: true }).then(() => true).catch(() => false);
    add(name, ok, fix);
  }
  let config;
  try { config = { port: 8780, remotePort: 8781, ...readJson(path.join(home, '.agents/orchestration/machine.json'), {}) }; }
  catch { add('machine.json', false, 'Repair the public machine.json JSON, then rerun setup.'); return { ok: false, checks }; }
  const remoteCommand = { tailscale: ['tailscale', 'version'], cloudflared: ['cloudflared', '--version'], 'ssh-reverse': ['ssh', '-V'] }[config.remote?.type];
  if (remoteCommand) add(remoteCommand[0], await run(remoteCommand[0], remoteCommand.slice(1), { timeout: 10000, windowsHide: true }).then(() => true).catch(() => false), `Install ${remoteCommand[0]}; follow docs/remote-access.md for its external configuration.`);
  const healthy = await matchingHealth(config, { fetchImpl });
  for (const key of ['port', 'remotePort']) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65535) {
      add(key, false, 'Choose a port from 1 to 65535 in setup.'); continue;
    }
    const free = await availablePort(config[key], '127.0.0.1') && (key !== 'port' || await availablePort(config[key], '0.0.0.0'));
    add(key, free || healthy, 'Choose an unused port; do not stop an unrelated service.');
  }
  add('distinct ports', config.port !== config.remotePort, 'Use different LAN and remote ports.');
  add('Inbox health', healthy, 'Run setup/install, then check node inbox.mjs health.');
  let state;
  try { state = await startup('status', { home }); } catch { state = {}; }
  add('autostart enabled', state.enabled === true, 'Run node inbox.mjs install as your logged-in user, then check health.');
  if ('active' in state) add('autostart active', state.active === true, 'Check your user service manager and rerun install.');
  return { ok: checks.every(check => check.ok), checks };
}
