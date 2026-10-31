import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { loadConfig, saveConfig, atomicJson } from '../config.mjs';
import { InboxStore } from '../store.mjs';
import { createInboxServer, ReverseTunnel, CAMPAIGN_UPLOAD_BYTES } from '../server.mjs';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-stability-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'campaign');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ campaign: '稳定', tickets: [] }));
  const config = loadConfig({ home });
  config.port = 0;
  config.remotePort = 0;
  config.campaigns = [{ id: 'demo', title: '稳定', project: '', dir }];
  saveConfig(config);
  return { home, dir, config, store: new InboxStore(config) };
}

const question = {
  kind: 'decide',
  title: '选择',
  ticket: '#1',
  askerThreadId: 'thread',
  askerLabel: '执行',
  options: [{ key: 'a', label: '甲', consequence: '选甲' }],
};

test('超时巡检对单个损坏 Campaign 单独吞错并继续其他 Campaign', async t => {
  const { config, home } = setup(t);
  const badDir = path.join(home, 'bad');
  fs.mkdirSync(badDir);
  fs.writeFileSync(path.join(badDir, 'campaign.json'), '{}');
  fs.writeFileSync(path.join(badDir, 'inbox.json'), '{not-json');
  config.campaigns.push({ id: 'bad', title: '坏', project: '', dir: badDir });
  saveConfig(config);
  const logs = [];
  let sweep;
  const original = globalThis.setInterval;
  const interval = t.mock.method(globalThis, 'setInterval', (callback, ...args) => {
    sweep = callback;
    return original(callback, ...args);
  });
  try {
    const server = await createInboxServer({
      config,
      host: '127.0.0.1',
      log: entry => logs.push(entry),
      push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} },
    });
    await server.start();
    t.after(() => server.stop());
  } finally {
    interval.mock.restore();
  }
  assert.equal(typeof sweep, 'function');
  assert.doesNotThrow(() => sweep());
  assert.ok(logs.some(entry => entry.event === 'stale-check-error' && entry.campaign === 'bad'));
});

test('start 注册 uncaughtException 日志兜底', async t => {
  const { config } = setup(t);
  const logs = [];
  const before = process.listenerCount('uncaughtException');
  const server = await createInboxServer({
    config,
    host: '127.0.0.1',
    log: entry => logs.push(entry),
    push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} },
  });
  await server.start();
  t.after(() => server.stop());
  assert.ok(process.listenerCount('uncaughtException') > before);
  const handlers = process.listeners('uncaughtException');
  const inboxHandler = handlers[handlers.length - 1];
  inboxHandler(new Error('synthetic-uncaught'));
  assert.ok(logs.some(entry => entry.event === 'uncaughtException' && /synthetic-uncaught/.test(entry.error)));
});

test('Range end 越界按 RFC 9110 钳到 size-1，返回 206', async t => {
  const { config, dir } = setup(t);
  const file = path.join(dir, 'clip.bin');
  fs.writeFileSync(file, '0123456789');
  const server = await createInboxServer({
    config,
    host: '127.0.0.1',
    push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} },
  });
  await server.start();
  t.after(() => server.stop());
  const url = `http://127.0.0.1:${server.main.address().port}/media/demo/clip.bin`;
  const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-9/10');
  assert.equal(await response.text(), '0123456789');
});

test('sendFile 在客户端中断时销毁源流，文件中途删除不让进程崩溃', async t => {
  const { config, dir } = setup(t);
  const file = path.join(dir, 'large.bin');
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 7));
  const server = await createInboxServer({
    config,
    host: '127.0.0.1',
    push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} },
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.main.address().port;
  await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/media/demo/large.bin`, res => {
      res.once('data', () => {
        req.destroy();
        setTimeout(() => {
          try {
            fs.unlinkSync(file);
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 50);
      });
    });
    req.on('error', () => {});
  });
  const missing = await fetch(`http://127.0.0.1:${port}/media/demo/large.bin`);
  assert.equal(missing.status, 404);
});

test('反向隧道连接稳定一段时间后退避计数归零', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.kill = () => {};
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const tunnel = new ReverseTunnel(
    { remotePort: 8781, remote: { type: 'ssh-reverse', sshHost: 'alias', remoteBindPort: 1 } },
    spawn,
  );
  tunnel.start();
  await Promise.resolve();
  children[0].emit('exit', 1);
  t.mock.timers.tick(2000);
  await Promise.resolve();
  assert.ok(tunnel.attempt >= 1);
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  assert.equal(tunnel.attempt, 0);
  tunnel.stop();
});

test('单个 Campaign 损坏时 /api/summary 仍返回其他 Campaign，坏的标 error', async t => {
  const { config, home, dir } = setup(t);
  const good = path.join(home, 'good');
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, 'campaign.json'), JSON.stringify({ campaign: '好' }));
  fs.writeFileSync(path.join(good, 'inbox.json'), JSON.stringify({ items: [], messages: [] }));
  const bad = path.join(home, 'bad');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'campaign.json'), '{}');
  fs.writeFileSync(path.join(bad, 'inbox.json'), '{broken');
  config.campaigns = [
    { id: 'demo', title: '稳定', project: '', dir },
    { id: 'good', title: '好', project: '', dir: good },
    { id: 'bad', title: '坏', project: '', dir: bad },
  ];
  saveConfig(config);
  const server = await createInboxServer({
    config,
    host: '127.0.0.1',
    push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} },
  });
  await server.start();
  t.after(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.main.address().port}/api/summary`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.campaigns.find(c => c.id === 'good').pending, 0);
  assert.equal(body.campaigns.find(c => c.id === 'bad').error, true);
  assert.equal(body.campaigns.find(c => c.id === 'demo').error, undefined);
});

test('view 读损坏的 campaign.json 时仍可展示 inbox', t => {
  const { store, dir } = setup(t);
  store.ask('demo', question);
  fs.writeFileSync(path.join(dir, 'campaign.json'), '{not-json');
  const view = store.view('demo');
  assert.equal(view.items.length, 1);
});

test('atomicJson 在 rename EPERM/EBUSY 时短暂重试；最终失败清理 .tmp', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'data.json');
  let attempts = 0;
  const realRename = fs.renameSync.bind(fs);
  t.mock.method(fs, 'renameSync', (from, to) => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('busy');
      error.code = attempts === 1 ? 'EPERM' : 'EBUSY';
      throw error;
    }
    return realRename(from, to);
  });
  atomicJson(target, { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true });
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.tmp')).length, 0);

  attempts = 0;
  t.mock.method(fs, 'renameSync', () => {
    attempts += 1;
    const error = new Error('busy');
    error.code = 'EPERM';
    throw error;
  });
  assert.throws(() => atomicJson(target, { fail: true }));
  assert.ok(attempts >= 2);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.tmp')).length, 0);
});

test('自动 id 跳过已占用的手写号', t => {
  const { store } = setup(t);
  store.ask('demo', { ...question, id: 'Q1' });
  store.ask('demo', { ...question, id: 'Q3' });
  assert.equal(store.ask('demo', question).id, 'Q2');
  assert.equal(store.ask('demo', question).id, 'Q4');
  const { kind, title, ticket, askerThreadId, askerLabel } = question;
  assert.equal(store.ask('demo', { kind: 'accept', title, ticket, askerThreadId, askerLabel }).id, 'A1');
});

test('上传先按 Content-Length 拒绝超限，并限制 Campaign 上传总量', async t => {
  const { config, dir } = setup(t);
  const server = await createInboxServer({
    config,
    host: '127.0.0.1',
    push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} },
  });
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.main.address().port}`;
  const oversized = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.main.address().port,
      path: '/api/upload/demo/messages',
      method: 'POST',
      headers: { 'Content-Length': String(20 * 1024 * 1024 + 1) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end('GIF89a');
  });
  assert.equal(oversized.status, 413);

  const uploads = path.join(dir, 'inbox', 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const filler = path.join(uploads, 'pad.bin');
  const handle = fs.openSync(filler, 'w');
  try {
    fs.ftruncateSync(handle, CAMPAIGN_UPLOAD_BYTES - 10);
  } finally {
    fs.closeSync(handle);
  }
  const overCap = await fetch(`${base}/api/upload/demo/messages`, {
    method: 'POST',
    body: Buffer.from('GIF89a!!!!!!!'),
  });
  assert.equal(overCap.status, 413);
});
