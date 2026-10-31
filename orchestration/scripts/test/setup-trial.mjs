// Manual isolated-user acceptance runner. Does not invoke a real service manager.
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const installed = process.argv.includes('--installed');
const home = installed ? path.resolve(process.env.INBOX_HOME || '') : await mkdtemp(path.join(tmpdir(), 'orchestration-setup-trial-'));
const source = fileURLToPath(new URL('../../', import.meta.url));
const skill = path.join(home, '.agents/skills/orchestration');
if (installed && (!path.basename(home).startsWith('orchestration-release-trial-') || home !== path.resolve(homedir()) || home !== path.resolve(process.env.HOME || '') || source.replace(/[\\/]$/, '') !== skill)) throw new Error('--installed requires an installed skill in an isolated orchestration-release-trial-* HOME/INBOX_HOME.');
const record = { platform: process.platform, node: process.version, isolatedHome: home, skills: skill, startup: 'SIMULATED runner only; no real service-manager calls', runs: [], startupCalls: [] };
const oldEnv = { ...process.env };
let server;
try {
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.INBOX_HOME = home; process.env.GH_CONFIG_DIR = path.join(home, '.config/gh');
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  if (!installed) await cp(source, skill, { recursive: true });
  record.companions = [];
  for (const name of ['implement', 'code-review', 'to-tickets', 'wayfinder']) {
    if (await readFile(path.join(home, '.agents/skills', name, 'SKILL.md'), 'utf8').then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) record.companions.push(name);
  }
  await mkdir(path.join(home, 'project')); await mkdir(path.join(home, '.config/gh'), { recursive: true });
  const { main } = await import(pathToFileURL(path.join(skill, 'inbox-web/inbox.mjs')));
  const { autostart } = await import(pathToFileURL(path.join(skill, 'inbox-web/autostart.mjs')));
  const { createInboxServer } = await import(pathToFileURL(path.join(skill, 'inbox-web/server.mjs')));
  const { loadConfig } = await import(pathToFileURL(path.join(skill, 'inbox-web/config.mjs')));
  const { doctor } = await import(pathToFileURL(path.join(skill, 'inbox-web/doctor.mjs')));
  const port = async () => { const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value; };
  const lan = await port(); let remote; do { remote = await port(); } while (remote === lan);
  if ([lan, remote].some(value => [8780, 8781].includes(value))) throw new Error('Retry trial to choose isolated ports.');
  record.ports = [lan, remote];
  const answers = { machine: { name: 'isolated-setup-trial', port: lan, remotePort: remote, remote: { type: 'none' } }, project: { root: path.join(home, 'project'), storage: path.join(home, 'campaigns'), permissions: 'No push, no GitHub issues, no real dispatch.', tests: 'node --test' } };
  const answersFile = path.join(home, 'answers.json'); await writeFile(answersFile, JSON.stringify(answers));
  let enabled = false;
  const stop = async () => { if (server) { await server.stop(); server = null; } };
  const start = async () => {
    if (server) return;
    server = await createInboxServer({ home, host: '127.0.0.1', push: { publicKey: '', start() {}, stop() {} } });
    await server.start();
  };
  const startup = async (command, options) => {
    if (command === 'status') return { enabled, ...(process.platform === 'win32' ? {} : { active: Boolean(server) }) };
    await autostart(command, { ...options, home, run: async (file, args) => {
      record.startupCalls.push({ file, operation: args.slice(0, 3) });
      if (file === 'launchctl' && args[0] === 'print' && !server) throw new Error('Trial: not loaded');
      if (args.includes('/End') || args.includes('bootout') || args.includes('restart')) await stop();
      if (args.includes('/Run') || args.includes('bootstrap') || (file === 'systemctl' && (args.includes('enable') || args.includes('restart')))) await start();
      return { stdout: '' };
    } });
    enabled = true;
    return { ok: true };
  };
  for (let i = 0; i < 2; i++) {
    let output = '';
    const result = await main(['setup', '--answers', answersFile], { home, autostartImpl: startup, output: { write: value => { output += value; } } });
    record.runs.push({ run: i + 1, result, publicOutput: output.trim() });
  }
  answers.machine.remote = { type: 'url', publicUrl: 'https://example.test/' };
  await writeFile(answersFile, JSON.stringify(answers));
  await main(['setup', '--answers', answersFile], { home, autostartImpl: startup, output: { write() {} } });
  record.remoteChangeApplied = server.config.remote.type === 'url';
  if (!record.remoteChangeApplied) throw new Error('Running service retained stale configuration.');
  // Git and gh checks use the isolated environment; gh auth failure is expected.
  record.doctor = await doctor({ home, startup, run: (file, args, options) => execute(file, args, { ...options, env: process.env }) });
  record.expectedUnauthenticatedGh = record.doctor.checks.find(check => check.name === 'GitHub authentication')?.ok === false;
  if (!record.expectedUnauthenticatedGh || record.doctor.checks.some(check => !check.ok && check.name !== 'GitHub authentication')) throw new Error('Unexpected isolated doctor result.');
  record.lanTrustSubnet = loadConfig({ home }).lanTrustSubnet;
  record.projectLinked = (await readFile(path.join(home, 'project/AGENTS.md'), 'utf8')).includes('docs/agents/orchestration.md');
  if (record.lanTrustSubnet !== false || !record.projectLinked) throw new Error('Trial configuration mismatch.');
  record.ok = true;
} finally {
  if (server) await server.stop();
  process.env = oldEnv;
  // Home was allocated by this process; it contains no user files. Preserve public record only.
  if (!installed) await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify(record, null, 2));
