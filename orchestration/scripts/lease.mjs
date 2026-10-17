#!/usr/bin/env node
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir, userInfo } from 'node:os';

// Named pipes and Linux abstract sockets belong to the process, not the filesystem.
// Other Unix systems (macOS) have no abstract namespace, so they use a socket file in the per-user temp directory;
// a file left behind by a killed holder refuses connections and is replaced on the next acquire.
// Replacement happens under a mkdir guard so two acquirers cannot each remove the other's fresh socket.
function endpoint(namespace, pool, lane) {
  const hash = createHash('sha256').update(JSON.stringify([userInfo().username, namespace, pool, lane])).digest('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\orch-lease-${hash}`;
  if (process.platform === 'linux') return `\0orch-lease-${hash}`;
  return path.join(tmpdir(), `orch-lease-${hash.slice(0, 32)}.sock`);
}
const isSocketFile = address => process.platform !== 'win32' && !address.startsWith('\0');
function stale(address) {
  return new Promise(resolve => {
    const socket = net.createConnection(address);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(['ECONNREFUSED', 'ENOENT'].includes(error.code)));
  });
}
function listen(server, address) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
}
const busy = () => Object.assign(new Error('lane busy'), { code: 'EADDRINUSE' });
async function reclaim(server, address) {
  const guard = `${address}.reclaim`;
  try { await mkdir(guard); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Recovery takes milliseconds; an older guard was left by an acquirer killed mid-recovery.
    const age = await stat(guard).then(x => Date.now() - x.mtimeMs, () => 0);
    if (age < 10000) throw busy();
    await rm(guard, { recursive: true, force: true });
    await mkdir(guard).catch(error => { throw error.code === 'EEXIST' ? busy() : error; });
  }
  try {
    if (!await stale(address)) throw busy();
    await unlink(address).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await listen(server, address);
  } finally { await rm(guard, { recursive: true, force: true }); }
}

export async function loadPools(file) {
  const markdown = await readFile(file, 'utf8');
  for (const match of markdown.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    const config = JSON.parse(match[1]);
    if (!config.resourcePools) continue;
    if (!config.resourceNamespace || typeof config.resourceNamespace !== 'string') throw new Error('需要 resourceNamespace');
    for (const lanes of Object.values(config.resourcePools)) {
      if (!Array.isArray(lanes) || !lanes.length || lanes.some(x => !x || typeof x.name !== 'string' || !x.name)) throw new Error('资源池需要非空的道列表和 name');
      if (new Set(lanes.map(x => x.name)).size !== lanes.length) throw new Error('同池道名不能重复');
      if (lanes.some(x => x.directory !== undefined && (typeof x.directory !== 'string' || !path.isAbsolute(x.directory)))) throw new Error('directory 必须是本机绝对路径');
      const dirs = lanes.filter(x => x.directory).map(x => path.normalize(x.directory));
      if (new Set(dirs.map(x => process.platform === 'win32' ? x.toLowerCase() : x)).size !== dirs.length) throw new Error('每道需要不同的 directory');
    }
    return config;
  }
  throw new Error('项目设定缺少 resourcePools JSON');
}

export async function acquire(config, pool) {
  const lanes = config.resourcePools[pool];
  if (!lanes) throw new Error(`资源池不存在：${pool}`);
  for (const lane of lanes) {
    const info = { pool, lane: lane.name, pid: process.pid, startedAt: new Date().toISOString(), directory: lane.directory || null };
    const server = net.createServer(socket => socket.end(JSON.stringify(info)));
    const address = endpoint(config.resourceNamespace, pool, lane.name);
    try {
      try { await listen(server, address); }
      catch (error) {
        if (error.code !== 'EADDRINUSE' || !isSocketFile(address)) throw error;
        await reclaim(server, address);
      }
      return { info, release: () => new Promise(resolve => server.close(resolve)) };
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error(`资源池 ${pool} 已满；稍后重试`);
}

export async function status(config) {
  return Promise.all(Object.entries(config.resourcePools).flatMap(([pool, lanes]) => lanes.map(lane => new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint(config.resourceNamespace, pool, lane.name));
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('读取资源占用超时')));
    socket.on('data', chunk => { data += chunk; });
    socket.once('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    socket.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve({ pool, lane: lane.name, pid: null, startedAt: null, directory: lane.directory || null });
      else reject(error);
    });
  }))));
}

export async function main(argv = process.argv.slice(2)) {
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) throw new Error('Resource leases support Windows, Linux, and macOS only');
  let project = path.resolve('docs/agents/orchestration.md');
  if (argv[0] === '--project') { project = path.resolve(argv[1]); argv = argv.slice(2); }
  const [command, pool, separator, ...args] = argv;
  const config = await loadPools(project);
  if (command === 'status' && argv.length === 1) { console.log(JSON.stringify(await status(config), null, 2)); return 0; }
  if (command !== 'run' || separator !== '--' || !args.length) throw new Error('lease.mjs [--project <设定.md>] run <池> -- <命令…> | status');
  const lease = await acquire(config, pool);
  try {
    const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: { ...process.env, ORCH_LEASE_POOL: pool, ORCH_LEASE_LANE: lease.info.lane, ORCH_LEASE_DIR: lease.info.directory || '' } });
    const signals = ['SIGINT', 'SIGTERM'];
    const forward = signal => child.kill(signal);
    const handlers = signals.map(signal => { const handler = () => forward(signal); process.on(signal, handler); return handler; });
    try {
      return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
    } finally { signals.forEach((signal, i) => process.off(signal, handlers[i])); }
  } finally { await lease.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
