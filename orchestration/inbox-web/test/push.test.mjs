import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify, createECDH, randomBytes, createHmac, createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { encryptPush, generateVapidKeys, vapidAuthorization, PushService } from '../push.mjs';

test('RFC 8291 §5 的公开示例产生完全相同的密文', () => {
  const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  const subscription = { keys: { auth: 'BTBZMqHH6r4Tts7J_aSIgg', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4' } };
  const encrypted = encryptPush('When I grow up, I want to be a watermelon', subscription, { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: Buffer.from(expected, 'base64url').subarray(0, 16) });
  assert.equal(encrypted.toString('base64url'), expected);
});

test('VAPID 使用 ES256、接收端 origin 和十二小时有效期', () => {
  const keys = generateVapidKeys(); const now = 1700000000000;
  const authorization = vapidAuthorization('https://push.example.test/send/abc', keys, 'https://inbox.example.test', now);
  const token = authorization.match(/^vapid t=(.*), k=/)[1]; const [header, claims, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { aud: 'https://push.example.test', exp: now / 1000 + 43200, sub: 'https://inbox.example.test' });
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey(keys.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

function subscription() { const key = createECDH('prime256v1'); key.generateKeys(); return { endpoint: 'https://fcm.googleapis.com/endpoint', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, receiver: key }; }

function decryptPayload(body, subscription) {
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
  const expand = (key, info, size) => hmac(key, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, size);
  const sender = body.subarray(21, 86), receiver = Buffer.from(subscription.keys.p256dh, 'base64url');
  const ikm = expand(hmac(Buffer.from(subscription.keys.auth, 'base64url'), subscription.receiver.computeSecret(sender)), Buffer.concat([Buffer.from('WebPush: info\0'), receiver, sender]), 32);
  const prk = hmac(body.subarray(0, 16), ikm);
  const decipher = createDecipheriv('aes-128-gcm', expand(prk, 'Content-Encoding: aes128gcm\0', 16), expand(prk, 'Content-Encoding: nonce\0', 12));
  decipher.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, -1));
}

test('普通题合并，挡票题立即推，送达失败每次提交只推一次', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inbox-push-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = []; const service = new PushService({ privateDir: dir, publicUrl: 'https://inbox.example.test/workstation-a/', fetchImpl: async (url, options) => { sent.push(options); return new Response(null, { status: 201 }); } });
  t.after(() => service.stop()); service.subscribe(subscription());
  service.enqueue({ campaign: 'c', id: 'q1', title: '题一' }); service.enqueue({ campaign: 'c', id: 'q2', title: '验收' }); assert.equal(sent.length, 0);
  await service.enqueue({ campaign: 'c', id: 'q3', title: '挡票', blocking: true }); assert.equal(sent.length, 1); assert.equal(sent[0].headers.Urgency, 'high');
  await service.flush(); assert.equal(sent.length, 2);
  await service.problem({ campaign: 'c', id: 'q1', submissionKey: 'submission-1' }); await service.problem({ campaign: 'c', id: 'q1', submissionKey: 'submission-1' }); assert.equal(sent.length, 3);
  await service.problem({ campaign: 'c', id: 'q1', submissionKey: 'submission-2' }); assert.equal(sent.length, 4);
  assert.equal(service.location({ campaign: 'c', id: 'q1' }).url, 'https://inbox.example.test/workstation-a/?campaign=c#q1');
  if (process.platform !== 'win32') { assert.equal((await stat(dir)).mode & 0o777, 0o700); assert.equal((await stat(path.join(dir, 'vapid.json'))).mode & 0o777, 0o600); }
});

test('404/410 订阅从私有存储删除，无效订阅不泄露密钥', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inbox-push-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const service = new PushService({ privateDir: dir, publicUrl: 'https://inbox.example.test/', fetchImpl: async () => new Response(null, { status: 410 }) });
  service.subscribe(subscription()); await service.enqueue({ campaign: 'c', id: 'q', blocking: true, title: '题' });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'push-subscriptions.json'))), []);
  assert.throws(() => service.subscribe({ endpoint: 'http://example.test', keys: {} }), /^Error: 推送订阅格式无效$/);
});

test('每个订阅保留语言，重启后发对应语言，老订阅默认中文', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inbox-push-language-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const zh = subscription(), en = { ...subscription(), endpoint: 'https://fcm.googleapis.com/english', language: 'en' };
  const service = new PushService({ privateDir: dir, publicUrl: 'https://inbox.example.test/' });
  service.subscribe(zh); service.subscribe(en);
  const saved = JSON.parse(await readFile(service.subscriptionFile));
  assert.equal(saved[1].language, 'en'); delete saved[0].language;
  await writeFile(service.subscriptionFile, JSON.stringify(saved));
  const sent = [];
  const restarted = new PushService({ privateDir: dir, publicUrl: 'https://inbox.example.test/', fetchImpl: async (url, options) => { sent.push(decryptPayload(options.body, url === zh.endpoint ? zh : en)); return new Response(null, { status: 201 }); } });
  t.after(() => restarted.stop());
  await restarted.enqueue({ campaign: 'c', id: 'q', blocking: true, title: 'User content' });
  assert.deepEqual(sent.map(p => p.title), ['有挡票的问题等你决定', 'A blocking question needs your decision']);
  assert.deepEqual(sent.map(p => p.language), ['zh', 'en']);
  assert.equal(sent[1].body, 'User content');
  restarted.enqueue({ campaign: 'c', id: 'q', title: 'User content' }); await restarted.flush();
  assert.deepEqual(sent.slice(2).map(p => p.title), ['1 条新题与验收等你处理', '1 new question or review needs your attention']);
  await restarted.problem({ campaign: 'c', id: 'q' });
  assert.deepEqual(sent.slice(4).map(p => p.title), ['Inbox 送达出了问题', 'Inbox delivery failed']);
  assert.deepEqual(sent.slice(4).map(p => p.body), ['请打开页面查看并重发通知', 'Open Inbox to review and resend the notification']);
  restarted.subscribe({ ...en, language: 'zh' });
  assert.equal(restarted.subscriptions.length, 2); assert.equal(restarted.subscriptions[1].language, 'zh');
});

test('送达异常的系统正文双语，用户题目不翻译', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inbox-push-problem-language-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const zh = subscription(), en = { ...subscription(), endpoint: 'https://fcm.googleapis.com/english', language: 'en' };
  const sent = [];
  const service = new PushService({ privateDir: dir, publicUrl: 'https://inbox.example.test/', fetchImpl: async (url, options) => { sent.push(decryptPayload(options.body, url === zh.endpoint ? zh : en)); return new Response(null, { status: 201 }); } });
  t.after(() => service.stop()); service.subscribe(zh); service.subscribe(en);
  for (const [title, english] of [['通知没送到', 'Notification failed'], ['答复超过 15 分钟未读', 'Answer unread for over 15 minutes']]) {
    await service.problem({ campaign: 'c', id: title, title });
    assert.deepEqual(sent.splice(0).map(payload => payload.body), [title, english]);
    await service.enqueue({ campaign: 'c', id: title, title, blocking: true });
    assert.deepEqual(sent.splice(0).map(payload => payload.body), [title, title]);
  }
  const title = '通知没送到：这是用户自写的正文';
  await service.problem({ campaign: 'c', id: 'custom', title });
  assert.deepEqual(sent.map(payload => payload.body), [title, title]);
});

test('订阅拒绝内网、伪推送域名、凭据、额外端口；旧危险订阅也不会发送', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inbox-push-endpoint-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const service = new PushService({ privateDir: dir, publicUrl: 'https://inbox.example.test/', fetchImpl: async () => { calls++; return new Response(null, { status: 201 }); } });
  for (const endpoint of ['https://127.0.0.1/', 'https://[::1]/', 'https://192.168.1.1/', 'https://fcm.googleapis.com.evil.test/', 'https://evil.test/?fcm.googleapis.com', 'https://user:secret@fcm.googleapis.com/', 'https://fcm.googleapis.com:8443/']) {
    assert.throws(() => service.subscribe({ ...subscription(), endpoint }), /^Error: 推送订阅格式无效$/);
  }
  for (const endpoint of ['https://fcm.googleapis.com/a', 'https://updates.push.services.mozilla.com/a', 'https://server.updates.push.services.mozilla.com/a', 'https://web.push.apple.com/a', 'https://wns.notify.windows.com/a']) {
    assert.doesNotThrow(() => service.subscribe({ ...subscription(), endpoint }));
  }
  service.subscriptions = [{ ...subscription(), endpoint: 'https://127.0.0.1/' }];
  await service.problem({ campaign: 'c', id: 'q' }); assert.equal(calls, 0);
});

test('worker 持久化手选语言，push 语言优先，英文 fallback 完整', async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const stored = new Map(), shown = [];
  function worker() {
    const handlers = {};
    vm.runInNewContext(source, { URL, Response, caches: { open: async () => ({ match: async key => stored.get(key)?.clone(), put: async (key, value) => stored.set(key, value) }) }, self: { navigator: { language: 'zh-CN' }, location: { origin: 'https://example.test' }, registration: { scope: 'https://example.test/', showNotification: async (title, options) => shown.push({ title, ...options }) }, addEventListener: (type, fn) => handlers[type] = fn } });
    return async (type, data) => { let work; handlers[type]({ data: type === 'push' ? { json: () => data } : data, waitUntil: value => { work = value; } }); await work; };
  }
  await worker()('message', { type: 'language', language: 'en' });
  const restarted = worker(); await restarted('push', {});
  assert.equal(shown.at(-1).title, 'New items in Inbox'); assert.equal(shown.at(-1).body, 'Open Inbox to view');
  await restarted('push', { language: 'zh' });
  assert.equal(shown.at(-1).title, 'Inbox 有新事项'); assert.equal(shown.at(-1).body, '打开 Inbox 查看');
  await restarted('push', { language: 'en', url: 'http://[' }); assert.equal(shown.at(-1).data.url, 'https://example.test/');
  stored.clear(); await worker()('push', {}); assert.equal(shown.at(-1).title, 'Inbox 有新事项');
});

test('dispatch reports partial successes, failures, expired and no-subscription batches without addresses', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inbox-push-result-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const records = [];
  const service = new PushService({ privateDir: dir, publicUrl: 'https://example.test/', onDelivery: (items, result) => records.push({ items, result }), fetchImpl: async url => {
    if (url.endsWith('/failed')) throw new Error('synthetic network error');
    return new Response(null, { status: url.endsWith('/expired') ? 410 : 201 });
  } }); t.after(() => service.stop());
  for (const suffix of ['ok', 'failed', 'expired']) service.subscribe({ ...subscription(), endpoint: `https://fcm.googleapis.com/${suffix}` });
  for (const id of ['q1', 'q2']) service.enqueue({ campaign: 'c', id, title: id });
  await service.flush();
  assert.deepEqual(records[0].items.map(i => i.id), ['q1', 'q2']);
  assert.equal(records[0].result.endpoints, 1); assert.equal(records[0].result.sent, true);
  assert.ok(Number.isFinite(Date.parse(records[0].result.at)));
  assert.doesNotMatch(JSON.stringify(records), /fcm|endpoint\//);
  service.subscriptions = [];
  await service.enqueue({ campaign: 'c', id: 'q3', title: 'q3', blocking: true });
  assert.equal(records[1].result.sent, false); assert.equal(records[1].result.endpoints, 0);
  service.publicUrl = undefined;
  await service.enqueue({ campaign: 'c', id: 'q4', title: 'q4', blocking: true });
  assert.equal(records[2].result.sent, false);
});
