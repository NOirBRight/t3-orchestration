import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquire, status, loadPools } from '../lease.mjs';

const script = fileURLToPath(new URL('../lease.mjs', import.meta.url));
function config(lanes = 1) {
  return { resourceNamespace: randomUUID(), resourcePools: { build: Array.from({ length: lanes }, (_, i) => ({ name: `lane-${i}`, directory: path.join(tmpdir(), `build-${i}`) })) } };
}

test('互斥、多道选空闲、status 与正常释放', async () => {
  const pools = config(2), first = await acquire(pools, 'build');
  let second;
  try {
    second = await acquire(pools, 'build');
    assert.notEqual(first.info.lane, second.info.lane);
    await assert.rejects(acquire(pools, 'build'), /已满/);
    const rows = await status(pools);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(x => x.pid === process.pid && !Number.isNaN(Date.parse(x.startedAt))));
  } finally { await first.release(); await second?.release(); }
  assert.ok((await status(pools)).every(x => x.pid === null));
});

test('run 传环境变量、退出码、持有者强杀后可重新领取', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orch-lease-'));
  const file = path.join(dir, 'project.md'), pools = config();
  await writeFile(file, '```json\n' + JSON.stringify(pools) + '\n```\n');
  assert.deepEqual(await loadPools(file), pools);
  const children = [];
  t.after(async () => { for (const child of children) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } } await rm(dir, { recursive: true, force: true }); });
  function run(code) {
    const child = spawn(process.execPath, [script, '--project', file, 'run', 'build', '--', process.execPath, '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); return child;
  }
  const normal = run('console.log(JSON.stringify({lane:process.env.ORCH_LEASE_LANE,dir:process.env.ORCH_LEASE_DIR,pool:process.env.ORCH_LEASE_POOL}));process.exitCode=7');
  let output = ''; normal.stdout.on('data', chunk => { output += chunk; });
  assert.equal((await once(normal, 'exit'))[0], 7);
  assert.deepEqual(JSON.parse(output), { lane: 'lane-0', dir: pools.resourcePools.build[0].directory, pool: 'build' });
  // The command reports its PID so cleanup also stops the orphan after wrapper SIGKILL.
  const holder = run('console.log(process.pid);setTimeout(()=>{},15000)');
  const [chunk] = await once(holder.stdout, 'data');
  const commandPid = Number(chunk.toString().trim());
  t.after(() => { try { process.kill(commandPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  assert.equal((await status(pools))[0].pid, holder.pid);
  const blocked = run('process.exit(0)');
  assert.equal((await once(blocked, 'exit'))[0], 1);
  holder.kill('SIGKILL'); await once(holder, 'exit');
  const replacement = await acquire(pools, 'build');
  await replacement.release();
  assert.equal((await status(pools))[0].pid, null);
});

test('CLI status 列所有池与空道，启动失败归还资源', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orch-lease-status-')), file = path.join(dir, 'project.md'), pools = config();
  pools.resourcePools.device = [{ name: 'phone' }];
  await writeFile(file, '```json\n' + JSON.stringify(pools) + '\n```');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [script, '--project', file, 'status']);
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  assert.equal((await once(child, 'exit'))[0], 0);
  assert.deepEqual(JSON.parse(output).map(x => [x.pool, x.lane, x.pid]), [['build', 'lane-0', null], ['device', 'phone', null]]);
  const failed = spawn(process.execPath, [script, '--project', file, 'run', 'build', '--', `missing-command-${randomUUID()}`], { stdio: 'ignore' });
  assert.equal((await once(failed, 'exit'))[0], 1);
  const lease = await acquire(pools, 'build'); await lease.release();
});

test('macOS 遗留 socket 文件并发回收只交给一个领取者', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orch-lease-'));
  const file = path.join(dir, 'project.md'), pools = config();
  await writeFile(file, '```json\n' + JSON.stringify(pools) + '\n```\n');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const holder = spawn(process.execPath, [script, '--project', file, 'run', 'build', '--', process.execPath, '-e', 'console.log(process.pid);setTimeout(()=>{},15000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const commandPid = Number((await once(holder.stdout, 'data'))[0].toString().trim());
  holder.kill('SIGKILL'); await once(holder, 'exit'); process.kill(commandPid, 'SIGKILL');
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => acquire(pools, 'build')));
  const held = results.filter(x => x.status === 'fulfilled');
  await Promise.all(held.map(x => x.value.release()));
  assert.equal(held.length, 1);
});
