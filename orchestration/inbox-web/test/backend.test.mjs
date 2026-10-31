import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, saveCampaigns, privateText } from '../config.mjs';
import { Access, allowedAdmin, allowedLan, inCidr, lanClientIp, normalizeDeviceCode, sameSubnet } from '../access.mjs';
import { InboxStore, validateItem, mediaPath, imageType } from '../store.mjs';
import { createInboxServer, ReverseTunnel } from '../server.mjs';
import { EventEmitter } from 'node:events';
import http from 'node:http';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-backend-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'campaign'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ campaign: '测试', tickets: [{ ticket: '#1', stage: '执行中' }, { ticket: '#2', stage: '已关闭', since: '2020-01-01' }, { ticket: '#3', stage: '已合并', since: new Date().toISOString() }] }));
  const config = loadConfig({ home }); config.port = 0; config.remotePort = 0; config.campaigns = [{ id: 'demo', title: '测试', dir }]; saveConfig(config);
  return { home, dir, config, store: new InboxStore(config) };
}
function adminHeaders(config, extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Inbox-Admin': privateText(config.privateDir, 'admin-token') || new Access(config.privateDir).adminToken, ...extra };
}
function loginPublicDir(home, name, extra = []) {
  const webDir = path.join(home, name); fs.mkdirSync(webDir);
  for (const file of ['login.html', 'login.js', 'i18n.js', 'style.css', 'icon.svg', ...extra]) fs.writeFileSync(path.join(webDir, file), file);
  return webDir;
}
const question = { kind: 'decide', title: '选择', ticket: '#1', askerThreadId: 'thread', askerLabel: '执行', blocking: true, options: [{ key: 'a', label: '甲', consequence: '选甲' }, { key: 'b', label: '乙', consequence: '选乙' }] };
test('withdrawals stay pending until handled and cannot be closed as stale answers', t => {
  const { store } = setup(t), item = store.ask('demo', question);
  store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }]);
  store.change('demo', item.id, 'ack'); store.change('demo', item.id, 'withdraw');
  const cancelled = store.pending('demo').items[0];
  assert.equal(cancelled.id, item.id); assert.equal(cancelled.withdrawalPending, true); assert.equal(cancelled.answer, null);
  for (const action of ['close', 'forward']) assert.throws(() => store.change('demo', item.id, action, { to: 'execution' }), /撤回/);
  assert.throws(() => store.change('demo', item.id, 'close', { by: 'orchestrator' }), /撤回/);
  assert.throws(() => store.change('demo', item.id, 'ack'), /--submission/);
  store.change('demo', item.id, 'ack', { submission: cancelled.submissionId }); assert.equal(store.pending('demo').items.length, 0);
  assert.equal(store.load('demo').items[0].status, 'open');
  assert.throws(() => store.change('demo', item.id, 'close'), /未答题/);
  store.submit('demo', [{ id: item.id, answer: { choices: ['b'] } }]);
  store.change('demo', item.id, 'ack'); store.change('demo', item.id, 'close');
  assert.equal(store.load('demo').items[0].status, 'closed');
});

test('Campaign media cannot execute as the Inbox origin, including range responses', async t => {
  const { config, dir } = setup(t);
  const server = await createInboxServer({ config }); await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.health().port}`;
  for (const extension of ['html', 'svg', 'js', 'png']) {
    fs.writeFileSync(path.join(dir, `artifact.${extension}`), '<script>fetch("/admin/close")</script>');
    for (const headers of [{}, { Range: 'bytes=0-7' }]) {
      const response = await fetch(`${base}/media/demo/artifact.${extension}`, { headers });
      assert.equal(response.status, headers.Range ? 206 : 200);
      assert.match(response.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (['html', 'js'].includes(extension)) assert.equal(response.headers.get('content-disposition'), 'attachment');
      await response.arrayBuffer();
    }
  }
  const app = await fetch(`${base}/app.js`); assert.doesNotMatch(app.headers.get('content-security-policy') ?? '', /sandbox/); await app.arrayBuffer();
});

test('failed removal persistence does not send a removed event or unregister in memory', async t => {
  const { config } = setup(t); let calls = 0;
  privateText(config.privateDir, 'webhooks/demo.url', 'https://webhook.invalid/test');
  const server = await createInboxServer({ config, fetch: async () => { calls++; return new Response(null, { status: 200 }); } });
  await server.start(); t.after(() => server.stop());
  const file = path.join(config.rootDir, 'machine.json');
  fs.renameSync(file, `${file}.backup`); fs.mkdirSync(file);
  const response = await fetch(`http://127.0.0.1:${server.health().port}/api/remove-campaign`, { method: 'POST', headers: { cookie: `inbox_session=${new Access(config.privateDir).cookie()}` }, body: JSON.stringify({ campaign: 'demo' }) });
  assert.equal(response.status, 400); await response.json(); assert.equal(calls, 0); assert.equal(config.campaigns.length, 1);
  fs.rmdirSync(file); fs.renameSync(`${file}.backup`, file);
});
test('题稿选项必须有 consequence，且拒绝 detail 等未显示字段', t => {
  const { dir } = setup(t);
  assert.throws(() => validateItem({ ...question, options: [{ key: 'a', label: '甲' }] }, dir), /consequence/);
  assert.throws(() => validateItem({ ...question, options: [{ key: 'a', label: '甲', consequence: '选甲', detail: '隐藏' }] }, dir), /detail|未显示/);
  assert.throws(() => validateItem({ ...question, multi: true, options: [{ key: 'a', label: '甲', consequence: '选甲' }] }, dir), /multi/);
});
test('题稿字段、选项和媒体按契约验证', t => {
  const { dir, store } = setup(t);
  for (const [field, value] of [['title', ''], ['blocking', 'yes'], ['background', [4]], ['options', [{ key: 'a', label: '甲' }, { key: 'a', label: '乙' }]]]) assert.throws(() => validateItem({ ...question, [field]: value }, dir), new RegExp(field));
  assert.throws(() => validateItem({ ...question, media: [{ path: '../outside.png' }] }, dir), /media/);
  assert.throws(() => validateItem({ ...question, options: [null] }, dir), /options\[0\]/);
  assert.throws(() => validateItem({ ...question, media: [null] }, dir), /media\[0\]/);
  assert.throws(() => validateItem({ ...question, id: 4 }, dir), /id/);
  assert.equal(store.ask('demo', question).id, 'Q1');
  const asset = path.join(dir, 'media', 'sample.gif'); fs.mkdirSync(path.dirname(asset)); fs.writeFileSync(asset, 'GIF89a');
  const media = store.ask('demo', { ...question, media: [{ path: asset, caption: '素材' }] }).media;
  assert.deepEqual(media, [{ path: 'media/sample.gif', caption: '素材' }]);
  assert.equal('progress' in store.view('demo'), false, 'progress comes from the ticket board now');
});
test('整批提交原子校验，撤回、改答、代答和结案', t => {
  const { store } = setup(t);
  const item = store.ask('demo', question);
  const acceptance = store.ask('demo', { ...question, kind: 'accept', options: [] });
  assert.throws(() => store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }, { id: acceptance.id, answer: { choices: ['rework'] } }]), /返修/);
  assert.equal(store.load('demo').items[0].status, 'open');
  store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }]);
  store.notified('demo', [item.id], [], 'accepted');
  assert.equal(store.load('demo').items[0].status, 'notified');
  store.change('demo', item.id, 'ack');
  store.change('demo', item.id, 'withdraw'); assert.equal(store.load('demo').items[0].status, 'open');
  store.submit('demo', [{ id: item.id, answer: { choices: [], note: '只留言' } }]);
  assert.deepEqual(store.load('demo').items[0].answer.choices, []);
  store.submit('demo', [{ id: item.id, answer: { choices: ['b'] } }], [{ note: '留言' }]);
  assert.throws(() => store.change('demo', item.id, 'close', { by: 'orchestrator' }), /Owner/);
  store.change('demo', item.id, 'ack'); store.change('demo', item.id, 'forward', { to: '执行' });
  store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }]);
  assert.equal(store.load('demo').items[0].redo, true);
  store.change('demo', item.id, 'ack'); store.change('demo', item.id, 'close');
  assert.throws(() => store.submit('demo', [{ id: item.id, answer: { choices: ['b'] } }]), /只读/);
  store.change('demo', acceptance.id, 'close', { by: 'orchestrator', note: '编排已定' });
  assert.equal(store.load('demo').items[1].answeredBy, 'orchestrator');
  assert.equal(store.pending('demo').messages.length, 1);
  const message = store.load('demo').messages[0];
  for (const action of ['withdraw', 'forward']) assert.throws(() => store.change('demo', message.id, action, { to: '执行' }), /留言只支持确认已读/);
  store.change('demo', message.id, 'ack'); assert.equal(store.load('demo').messages[0].status, 'read');
});
test('改题声明 replaces：原题未答则替换，已答或已结案则拒绝', t => {
  const { dir, store } = setup(t);
  assert.throws(() => validateItem({ ...question, replaces: 4 }, dir), /replaces/);
  assert.throws(() => store.ask('demo', { ...question, replaces: 'missing' }), /不存在/);
  const first = store.ask('demo', question), second = store.ask('demo', { ...question, title: '选择（改推荐）', replaces: first.id });
  assert.equal(second.replaces, first.id);
  const original = store.load('demo').items[0];
  assert.equal(original.status, 'closed'); assert.equal(original.replacedBy, second.id); assert.equal(original.answer, null);
  assert.throws(() => store.submit('demo', [{ id: first.id, answer: { choices: ['a'] } }]), new RegExp(`已换成新题 ${second.id}`));
  const upload = path.join(dir, 'inbox', 'uploads', first.id, 'draft.png'); fs.mkdirSync(path.dirname(upload), { recursive: true }); fs.writeFileSync(upload, 'png');
  store.submit('demo', [{ id: second.id, answer: { choices: ['b'], images: [`inbox/uploads/${first.id}/draft.png`] } }]);
  assert.throws(() => store.ask('demo', { ...question, replaces: second.id }), /已有 Owner 答复（saved）.*pending/);
  assert.throws(() => store.ask('demo', { ...question, replaces: first.id }), /已结案/);
  assert.equal(store.load('demo').items.length, 2);
  const other = store.ask('demo', question);
  assert.throws(() => store.submit('demo', [{ id: other.id, answer: { choices: ['a'], images: [`inbox/uploads/${first.id}/draft.png`] } }]), /本题上传/);
});
test('改答后编排没重新读，不能按旧答复转交或结案', t => {
  const { store } = setup(t), item = store.ask('demo', question);
  store.submit('demo', [{ id: item.id, answer: { choices: ['b'] } }]);
  assert.throws(() => store.change('demo', item.id, 'forward', { to: '执行' }), /还没读的新答复/);
  store.change('demo', item.id, 'ack');
  store.submit('demo', [{ id: item.id, answer: { choices: ['a'], note: '改主意了' } }]);
  store.notified('demo', [item.id], [], 'accepted');
  assert.throws(() => store.change('demo', item.id, 'forward', { to: '执行' }), /还没读的新答复.*pending/);
  assert.throws(() => store.change('demo', item.id, 'close'), /还没读的新答复/);
  store.change('demo', item.id, 'ack'); store.change('demo', item.id, 'forward', { to: '执行' });
  assert.deepEqual(store.load('demo').items[0].answer.choices, ['a']);
  store.submit('demo', [{ id: item.id, answer: { choices: ['b'] } }]);
  assert.throws(() => store.change('demo', item.id, 'close'), /还没读的新答复/);
});
test('owner answers preserve legacy attribution and overwrite protection', t => {
  const { store, dir } = setup(t), item = store.ask('demo', question);
  store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }]);
  assert.equal(store.load('demo').items[0].answeredBy, 'owner');
  const file = path.join(dir, 'inbox.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Legacy fixture: older installations used this owner attribution.
  legacy.items[0].answeredBy = 'legacy-owner';
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.equal(store.load('demo').items[0].answeredBy, 'owner');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].answeredBy, 'legacy-owner');
  assert.throws(() => store.change('demo', item.id, 'close', { by: 'orchestrator' }), /Owner/);
  store.change('demo', item.id, 'ack');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].answeredBy, 'owner');
  store.change('demo', item.id, 'forward', { to: 'execution-thread' });
  store.submit('demo', [{ id: item.id, answer: { choices: ['b'] } }]);
  assert.equal(store.load('demo').items[0].redo, true);
  assert.equal(store.load('demo').items[0].answeredBy, 'owner');
});
test('异步 webhook 不覆盖后一次改答的送达状态', t => {
  const { store } = setup(t), item = store.ask('demo', question);
  store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }]);
  const first = store.load('demo').items[0];
  const revisions = { [item.id]: JSON.stringify({ answer: first.answer, saved: first.times.saved, withdrawn: first.times.withdrawn, submissionId: first.submissionId }) };
  store.submit('demo', [{ id: item.id, answer: { choices: ['b'] } }]);
  store.notified('demo', [item.id], [], 'accepted', revisions);
  assert.equal(store.load('demo').items[0].status, 'saved');
});
test('本机、子网和管理接口判断', () => {
  const interfaces = {
    lan: [{ address: '192.168.4.10', netmask: '255.255.255.0', internal: false }],
    docker: [{ address: '172.17.0.1', netmask: '255.255.0.0', internal: false }],
    tailscale: [{ address: '100.64.1.2', netmask: '255.192.0.0', internal: false }],
  };
  assert.equal(allowedLan('::ffff:192.168.4.12', interfaces), true);
  assert.equal(allowedLan('192.168.5.12', interfaces), false);
  assert.equal(allowedLan('172.17.0.8', interfaces), false);
  assert.equal(allowedLan('100.64.1.9', interfaces), false);
  assert.equal(allowedLan('::1', interfaces), true);
  assert.equal(allowedLan('10.1.2.3', interfaces, { cidrs: ['10.1.0.0/16'] }), true);
  assert.equal(allowedLan('10.2.2.3', interfaces, { cidrs: ['10.1.0.0/16'] }), false);
  assert.equal(sameSubnet('2001:db8::5', '2001:db8::1', 'ffff:ffff:ffff:ffff::'), true);
  assert.equal(inCidr('172.18.0.5', '172.16.0.0/12'), true);
  const token = 'admin-test-token';
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-inbox-admin': token } };
  assert.equal(allowedAdmin(req, false, token), true); assert.equal(allowedAdmin(req, true, token), false);
  assert.equal(allowedAdmin(req, false, 'other'), false);
  assert.equal(allowedAdmin({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, false, ''), false);
  assert.equal(allowedAdmin({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-inbox-admin': '' } }, false, ''), false);
  req.headers['x-forwarded-for'] = '127.0.0.1'; assert.equal(allowedAdmin(req, false, token), false);
  assert.equal(allowedAdmin({ socket: { remoteAddress: '::1' }, headers: { 'x-inbox-admin': token } }, false, token), true);
});
test('口令限速、cookie、换口令失效', t => {
  const { config } = setup(t); let now = 1000000;
  const access = new Access(config.privateDir, { now: () => now });
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': 'source, proxy' } };
  const token = access.token;
  assert.equal(access.authorize(req, new URL(`https://example.test/?k=${token}`), { trustForwarded: true }).status, 302);
  const cookie = access.cookie(); assert.equal(access.validCookie(`inbox_session=${cookie}`), true);
  access.rotate(); assert.equal(access.validCookie(`inbox_session=${cookie}`), false);
  for (let n = 0; n < 4; n++) assert.equal(access.authorize(req, new URL('https://example.test/?k=bad'), { trustForwarded: true }).status, 401);
  assert.equal(access.authorize(req, new URL('https://example.test/?k=bad'), { trustForwarded: true }).status, 429);
  assert.equal(access.authorize(req, new URL(`https://example.test/?k=${access.token}`), { trustForwarded: true }).status, 429);
  req.headers.cookie = `inbox_session=${access.cookie()}`;
  assert.equal(access.authorize(req, new URL('https://example.test/'), { trustForwarded: true }).status, 200);
  delete req.headers.cookie;
  now += 900001; assert.equal(access.authorize(req, new URL(`https://example.test/?k=${access.token}`), { trustForwarded: true }).status, 302);
});
test('默认关闭子网免登录，配置只接受布尔值', t => {
  const { config, home } = setup(t);
  assert.equal(config.lanTrustSubnet, false);
  config.lanTrustSubnet = true; saveConfig(config);
  assert.equal(loadConfig({ home }).lanTrustSubnet, true);
  config.lanTrustSubnet = 'true'; saveConfig(config);
  assert.throws(() => loadConfig({ home }), /lanTrustSubnet/);
});
test('伪造转发地址不能绕过登录限速，失效和缺失密钥拒绝登录', t => {
  const { config } = setup(t); let now = 1000000;
  const access = new Access(config.privateDir, { now: () => now });
  const req = { socket: { remoteAddress: '192.168.4.20' }, headers: {} };
  const cookie = access.cookie(); now += 366 * 86400000;
  assert.equal(access.validCookie(`inbox_session=${cookie}`), false);
  assert.equal(access.validCookie(`inbox_session=${access.cookie()}tampered`), false);
  for (let n = 0; n < 5; n++) {
    req.headers['x-forwarded-for'] = `192.168.4.${n}`;
    assert.equal(access.authorize(req, new URL('http://inbox/?k=bad')).status, n === 4 ? 429 : 401);
  }
  req.headers['x-forwarded-for'] = 'fresh-source';
  assert.equal(access.authorize(req, new URL(`http://inbox/?k=${access.token}`)).status, 429);
  now += 900001;
  fs.unlinkSync(path.join(config.privateDir, 'remote-token'));
  assert.equal(access.authorize(req, new URL('http://inbox/?k=')).status, 401);
  assert.equal(access.authorize(req, new URL('http://inbox/')).status, 401);
});
test('LAN 默认口令与 cookie 保护数据、上传和提交，显式免登录恢复原行为', async t => {
  const { config, home } = setup(t);
  const webDir = path.join(home, 'login-public'); fs.mkdirSync(webDir);
  for (const file of ['login.html', 'login.js', 'i18n.js', 'style.css', 'icon.svg', 'app.js']) fs.writeFileSync(path.join(webDir, file), file);
  // macOS only binds 127.0.0.1 on lo0, so there the client and server use the machine's own LAN address.
  const lanIp = process.platform === 'darwin' ? Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address : '127.0.0.2';
  if (!lanIp) return t.skip('no LAN IPv4 address');
  const host = process.platform === 'darwin' ? lanIp : '127.0.0.1';
  const interfaces = { lan: [{ address: host, netmask: '255.0.0.0', internal: false }] };
  const push = { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} };
  const server = await createInboxServer({ config, host, interfaces, push, webDir });
  await server.start(); t.after(() => server.stop());
  const request = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host, port: server.main.address().port, localAddress: lanIp, path: route, method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  });
  for (const [route, method] of [['/api/summary', 'GET'], ['/api/campaign/demo', 'GET'], ['/media/demo/campaign.json', 'GET'], ['/api/upload/demo/messages', 'POST'], ['/api/submit', 'POST']]) {
    assert.equal((await request(route, { method, headers: { 'X-Inbox-Hub': '1' } })).status, 401, route);
  }
  assert.equal((await request('/admin/health', { method: 'POST', body: '{}' })).status, 403);
  const page = await request('/', { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 401); assert.equal(page.text, 'login.html');
  for (const file of ['login.js', 'i18n.js', 'style.css', 'icon.svg']) assert.equal((await request(`/${file}`)).status, 200);
  assert.equal((await request('/app.js')).status, 401);
  const login = await request(`/?k=${privateText(config.privateDir, 'remote-token')}&campaign=demo`);
  assert.equal(login.status, 302); assert.equal(login.headers.location, '/?campaign=demo');
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(login.headers['set-cookie'][0], /Secure/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const generated = await server.admin('rotate-token', {});
  assert.equal(new URL(generated.url).hostname, os.hostname().toLowerCase());
  assert.equal(new URL(generated.url).port, String(server.main.address().port));
  assert.ok(new URL(generated.url).searchParams.get('k'));
  // 换口令后重新登录；旧 cookie 必须失效。
  assert.equal((await request('/api/summary', { headers: { Cookie: cookie } })).status, 401);
  const renewed = await request(`/?k=${privateText(config.privateDir, 'remote-token')}`);
  const renewedCookie = renewed.headers['set-cookie'][0].split(';')[0];
  const summary = await request('/api/summary', { headers: { Cookie: renewedCookie, 'X-Inbox-Hub': '1' } });
  assert.equal(summary.status, 200); assert.equal(JSON.parse(summary.text).hub, false);
  assert.equal(summary.headers['access-control-allow-origin'], undefined);
  assert.equal((await request('/api/submit', { method: 'POST', headers: { Cookie: renewedCookie, Origin: 'https://hostile.invalid' }, body: '{}' })).status, 403);
  config.lanTrustSubnet = true;
  const trusted = await request('/api/summary');
  assert.equal(trusted.status, 200); assert.equal(trusted.headers['access-control-allow-origin'], undefined);
  config.peers = [{ name: 'peer', lanUrl: 'http://192.168.4.20:8780/' }];
  const peerOrigin = await request('/api/summary', { headers: { Origin: 'http://192.168.4.20:8780' } });
  assert.equal(peerOrigin.status, 200); assert.equal(peerOrigin.headers['access-control-allow-origin'], 'http://192.168.4.20:8780');
  assert.equal((await request('/api/summary', { headers: { Origin: 'https://evil.example' } })).headers['access-control-allow-origin'], undefined);
  assert.equal((await request('/admin/health', { method: 'POST', body: '{}' })).status, 403);
  config.lanTrustSubnet = false;
  assert.equal((await request('/api/summary')).status, 401);
});
test('上传拒绝伪造图片、20MB 超限、条目路径穿越及越界符号链接', async t => {
  const { config, dir, home } = setup(t);
  const server = await createInboxServer({ config, host: '127.0.0.1', push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} } });
  await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.main.address().port}`;
  const upload = (item, bytes) => fetch(`${base}/api/upload/demo/${item}`, { method: 'POST', body: bytes });
  const invalid = await upload('messages', Buffer.from('<svg onload="alert(1)"></svg>'));
  assert.equal(invalid.status, 400);
  assert.equal((await upload('messages', Buffer.alloc(20 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload('..%2Foutside', Buffer.from('GIF89a'))).status, 400);
  const outside = path.join(home, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(dir, 'inbox'));
  fs.symlinkSync(outside, path.join(dir, 'inbox', 'uploads'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await upload('messages', Buffer.from('GIF89a'))).status, 400);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() => mediaPath(dir, 'inbox/uploads/secret.txt'));
});
test('媒体越界、文件头类型', t => {
  const { dir } = setup(t);
  assert.throws(() => mediaPath(dir, '../machine.json'), /目录内/);
  assert.equal(imageType(Buffer.from('GIF89atest')).extension, 'gif');
  assert.equal(imageType(Buffer.from('<html>bad</html>')), null);
  assert.equal(imageType(Buffer.from([255, 216, 255, 0])).extension, 'jpg');
  assert.equal(imageType(Buffer.from('RIFFxxxxWEBPxxxx')).extension, 'webp');
  assert.equal(imageType(Buffer.from('xxxxftypheicxxxx')).extension, 'heic');
});
test('HTTP 提交一次 webhook、原图上传、Range、远程和管理隔离', async t => {
  const { config, dir } = setup(t), calls = [], problems = [];
  privateText(config.privateDir, 'webhooks/demo.url', 'https://webhook.invalid/private');
  const push = { publicKey: 'key', start() {}, stop() {}, enqueue() {}, problem(x) { problems.push(x); }, subscribe() {} };
  const server = await createInboxServer({ config, host: '127.0.0.1', push, fetch: async (...args) => { calls.push(args); return { ok: true }; } });
  await server.start(); t.after(() => server.stop());
  const url = `http://127.0.0.1:${server.main.address().port}`;
  const post = async (route, value, headers = {}) => { const response = await fetch(`${url}/${route}`, { method: 'POST', headers: { ...adminHeaders(config), ...headers }, body: JSON.stringify(value) }); return { status: response.status, data: await response.json() }; };
  assert.equal((await fetch(`${url}/admin/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const item = (await post('admin/ask', { campaign: 'demo', item: question })).data;
  const upload = await fetch(`${url}/api/upload/demo/${item.id}`, { method: 'POST', body: Buffer.from('GIF89aoriginal') });
  const reference = await upload.json(); assert.ok(reference.path.startsWith('inbox/uploads/'));
  assert.equal(fs.readFileSync(path.join(dir, reference.path), 'utf8'), 'GIF89aoriginal');
  const response = await post('api/submit', { campaign: 'demo', items: [{ id: item.id, answer: { choices: ['a'], images: [reference.path] } }], messages: [{ note: '你好' }] });
  assert.equal(response.status, 200); assert.equal(response.data.notify, 'accepted'); assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(JSON.parse(calls[0][1].body).messages.length, 1); assert.match(calls[0][1].headers['User-Agent'], /Orchestration/);
  const ranged = await fetch(`${url}/${reference.url}`, { headers: { Range: 'bytes=0-5' } }); assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'GIF89a');
  const summary = await fetch(`${url}/api/summary`); assert.equal(summary.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${url}/admin/health`, { method: 'POST', headers: adminHeaders(config), body: '{}' })).status, 200);
  const forwarded = await fetch(`${url}/admin/health`, { method: 'POST', headers: { ...adminHeaders(config), 'X-Forwarded-For': '127.0.0.1' }, body: '{}' }); assert.equal(forwarded.status, 403);
  const crossSite = await fetch(`${url}/admin/health`, { method: 'POST', headers: { ...adminHeaders(config), Origin: 'https://hostile.invalid' }, body: '{}' }); assert.equal(crossSite.status, 403);
  const rebinding = await new Promise((resolve, reject) => { const req = http.get(`${url}/api/summary`, { headers: { Host: 'hostile.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); }); assert.equal(rebinding, 403);
  const remoteUrl = `http://127.0.0.1:${server.remote.address().port}`;
  assert.equal((await fetch(`${remoteUrl}/api/summary`)).status, 401);
  assert.equal((await fetch(`${remoteUrl}/api/summary`, { headers: { 'X-Inbox-Hub': '1' } })).status, 401);
  assert.equal((await fetch(`${remoteUrl}/admin/health`, { method: 'POST', headers: adminHeaders(config) })).status, 403);
  const login = await fetch(`${remoteUrl}/?k=${privateText(config.privateDir, 'remote-token')}`, { redirect: 'manual' });
  assert.equal(login.status, 302); assert.equal(login.headers.get('location'), '/');
  assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const resource of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'sw.js']) {
    assert.equal((await fetch(`${remoteUrl}/${resource}`)).status, 401, resource);
    const response = await fetch(`${remoteUrl}/${resource}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, resource);
    assert.ok((await response.arrayBuffer()).byteLength > 0, resource);
  }
  config.remote.publicUrl = 'https://example.test/workstation-a/';
  const prefixLogin = await fetch(`${remoteUrl}/?k=${privateText(config.privateDir, 'remote-token')}`, { redirect: 'manual' });
  assert.equal(prefixLogin.headers.get('location'), '/workstation-a/'); assert.match(prefixLogin.headers.get('set-cookie'), /Path=\/$/);
  assert.equal(problems.length, 0);
});
test('反向隧道可选监听地址、平台 ssh 路径与默认 loopback', () => {
  const calls = [];
  const spawn = (...args) => { calls.push(args); const child = new EventEmitter(); child.kill = () => {}; return child; };
  const config = { remotePort: 8781, remote: { type: 'ssh-reverse', sshHost: 'test-alias', remoteBindPort: 22222 } };
  const tunnel = new ReverseTunnel(config, spawn); tunnel.start(); tunnel.stop();
  assert.equal(calls[0][1].at(-2), '22222:127.0.0.1:8781');
  assert.equal(calls[0][2].windowsHide, true);
  if (process.platform === 'win32') assert.equal(calls[0][0], path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe'));
  const withBind = new ReverseTunnel({ ...config, remote: { ...config.remote, remoteBindHost: '0.0.0.0' } }, spawn); withBind.start(); withBind.stop();
  assert.equal(calls[1][1].at(-2), '0.0.0.0:22222:127.0.0.1:8781');
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    try { delete process.env.SystemRoot; assert.throws(() => new ReverseTunnel(config, spawn).start(), /缺少 SystemRoot/); }
    finally { process.env.SystemRoot = systemRoot; }
  }
});
test('挡票和其他未答题排在已答题之前', t => {
  const { store, dir } = setup(t);
  const answered = store.ask('demo', { ...question, blocking: false });
  store.submit('demo', [{ id: answered.id, answer: { choices: ['a'] } }]);
  const open = store.ask('demo', { ...question, blocking: false });
  const blocking = store.ask('demo', question);
  const view = store.view('demo');
  assert.deepEqual(view.items.map(item => item.id), [blocking.id, open.id, answered.id]);
});
test('register/unregister 写回前重读磁盘，只合并 campaigns，保留手改 peers', async t => {
  const { home, dir, config } = setup(t);
  config.peers = [{ name: 'stale' }];
  saveConfig(config);
  const server = await createInboxServer({ config, host: '127.0.0.1', push: { publicKey: '', start() {}, stop() {}, enqueue() {} } });
  await server.start();
  t.after(() => server.stop());
  const onDisk = loadConfig({ home });
  onDisk.peers = [{ name: 'hand-edited', lanUrl: 'http://other:8780/' }];
  saveConfig(onDisk);
  await server.admin('unregister', { campaign: 'demo' });
  assert.deepEqual(loadConfig({ home }).peers, onDisk.peers);
  assert.deepEqual(loadConfig({ home }).campaigns, []);
  await server.admin('register', { dir, id: 'demo' });
  const after = loadConfig({ home });
  assert.deepEqual(after.peers, onDisk.peers);
  assert.equal(after.campaigns.length, 1);
  assert.equal(after.campaigns[0].id, 'demo');
  config.campaigns = [{ id: 'memory-only' }];
  saveCampaigns(config);
  assert.deepEqual(loadConfig({ home }).peers, onDisk.peers);
  assert.deepEqual(loadConfig({ home }).campaigns.map(c => c.id), ['memory-only']);
});
test('同批失败、重发成功、超时和重启合计只提醒一次，新提交可重新提醒', async t => {
  const { config } = setup(t), problems = []; let accepted = false, sweep;
  const create = async () => {
    const original = globalThis.setInterval;
    const interval = t.mock.method(globalThis, 'setInterval', (callback, ...args) => { sweep = callback; return original(callback, ...args); });
    try {
      const server = await createInboxServer({ config, host: '127.0.0.1', push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem(item) { problems.push(item); } }, fetch: async () => ({ ok: accepted }) });
      await server.start(); return server;
    } finally { interval.mock.restore(); }
  };
  privateText(config.privateDir, 'webhooks/demo.url', 'https://webhook.invalid/private');
  let server = await create(); t.after(() => server.stop());
  const first = await server.admin('ask', { campaign: 'demo', item: question });
  const second = await server.admin('ask', { campaign: 'demo', item: { ...question, blocking: false } });
  const post = async (route, value) => fetch(`http://127.0.0.1:${server.main.address().port}/${route}`, { method: 'POST', body: JSON.stringify(value) }).then(response => response.json());
  const batch = await post('api/submit', { campaign: 'demo', items: [first, second].map(item => ({ id: item.id, answer: { choices: ['a'] } })), messages: [{ note: '同一批留言' }] });
  assert.equal(batch.notify, 'failed'); assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'notify-failed');
  const data = server.store.load('demo');
  assert.equal(new Set([...data.items, ...data.messages].map(item => item.submissionId)).size, 1);
  assert.ok([...data.items, ...data.messages].every(item => item.problemSent));
  accepted = true;
  for (const id of [first.id, second.id, batch.messages[0]]) await post(`api/item/demo/${id}`, { action: 'retry' });
  const stale = server.store.load('demo'); for (const item of [...stale.items, ...stale.messages]) item.times.notified = '2020-01-01'; server.store.save('demo', stale);
  sweep(); assert.equal(problems.length, 1);
  await server.stop(); server = await create(); sweep(); assert.equal(problems.length, 1);
  await post('api/submit', { campaign: 'demo', items: [{ id: first.id, answer: { choices: ['b'] } }] });
  const newer = server.store.load('demo'); newer.items[0].times.notified = '2020-01-01'; server.store.save('demo', newer);
  sweep(); sweep(); assert.equal(problems.length, 2);
  assert.notEqual(problems[0].submissionKey, problems[1].submissionKey);
});
test('webhook 失败仍保存，未配置明确返回，重发不泄漏地址', async t => {
  const { config } = setup(t), problems = [], logs = [];
  const server = await createInboxServer({ config, host: '127.0.0.1', log: entry => logs.push(entry), push: { publicKey: '', start() {}, stop() {}, enqueue() {}, problem(x) { problems.push(x); } }, fetch: async () => { throw new Error('secret URL'); } });
  await server.start(); t.after(() => server.stop());
  const item = await server.admin('ask', { campaign: 'demo', item: question });
  const base = `http://127.0.0.1:${server.main.address().port}`;
  const submit = () => fetch(`${base}/api/submit`, { method: 'POST', body: JSON.stringify({ campaign: 'demo', items: [{ id: item.id, answer: { choices: ['a'] } }] }) }).then(r => r.json());
  assert.equal((await submit()).notify, 'unconfigured');
  privateText(config.privateDir, 'webhooks/demo.url', 'https://secret.invalid/url');
  const response = await submit(); assert.equal(response.notify, 'failed');
  assert.equal(server.store.load('demo').items[0].status, 'saved'); assert.equal(problems.length, 1);
  assert.equal(JSON.stringify(server.store.load('demo')).includes('secret'), false);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
  assert.deepEqual(logs, [{ event: 'webhook', campaign: 'demo', result: 'unconfigured' }, { event: 'webhook', campaign: 'demo', result: 'failed' }]);
});
test('Linux 私密目录和文件权限收紧为 0700/0600', { skip: process.platform === 'win32' }, t => {
  const { config, home } = setup(t);
  privateText(config.privateDir, 'remote-token', 'temporary-test-value');
  const file = path.join(config.privateDir, 'remote-token');
  fs.chmodSync(file, 0o644); fs.chmodSync(config.privateDir, 0o755);
  loadConfig({ home }); privateText(config.privateDir, 'remote-token');
  assert.equal(fs.statSync(config.privateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('device links are single-use, short-lived, memory-only and preserve existing login', t => {
  const { config } = setup(t); let now = Date.now();
  const access = new Access(config.privateDir, { now: () => now });
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  const cookie = access.cookie(), token = access.token, key = access.key;
  const link = access.deviceLink();
  const auth = () => access.authorize(req, new URL(`http://localhost/?device=${link}`));
  assert.equal(auth().status, 302); assert.equal(auth().status, 401);
  assert.equal(access.token, token); assert.equal(access.key, key);
  assert.ok(access.validCookie(`inbox_session=${cookie}`));
  const expired = access.deviceLink(); now += 300000;
  assert.equal(access.authorize(req, new URL(`http://localhost/?device=${expired}`)).status, 401);
  const lost = access.deviceLink(), restarted = new Access(config.privateDir);
  assert.equal(restarted.authorize(req, new URL(`http://localhost/?device=${lost}`)).status, 401);
  const rotated = access.deviceLink(); access.rotate();
  assert.equal(access.authorize(req, new URL(`http://localhost/?device=${rotated}`)).status, 401);
});

test('device codes are short, single-use, twin to QR grant, rate-limited, and preserve sessions', t => {
  const { config } = setup(t); let now = 2_000_000;
  const access = new Access(config.privateDir, { now: () => now });
  const req = { socket: { remoteAddress: '203.0.113.50' }, headers: {} };
  const session = access.cookie(), remoteToken = access.token, key = access.key;
  const grant = access.deviceGrant();
  assert.match(grant.displayCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeDeviceCode(grant.displayCode), grant.code);
  assert.equal(normalizeDeviceCode(grant.displayCode.toLowerCase().replace('-', ' ')), grant.code);
  assert.equal(access.authorize(req, new URL('http://localhost/'), { code: grant.displayCode }).status, 302);
  assert.equal(access.authorize(req, new URL('http://localhost/'), { code: grant.displayCode }).status, 401);
  assert.equal(access.authorize(req, new URL(`http://localhost/?device=${grant.token}`)).status, 401);
  assert.equal(access.token, remoteToken); assert.equal(access.key, key);
  assert.ok(access.validCookie(`inbox_session=${session}`));

  const twin = access.deviceGrant();
  assert.equal(access.authorize(req, new URL(`http://localhost/?device=${twin.token}`)).status, 302);
  assert.equal(access.authorize(req, new URL('http://localhost/'), { code: twin.displayCode }).status, 401);

  const expired = access.deviceGrant(); now += 300000;
  assert.equal(access.authorize(req, new URL('http://localhost/'), { code: expired.code }).status, 401);
  const lost = access.deviceGrant(), restarted = new Access(config.privateDir, { now: () => now });
  assert.equal(restarted.authorize(req, new URL('http://localhost/'), { code: lost.displayCode }).status, 401);
  const rotated = access.deviceGrant(); access.rotate();
  assert.equal(access.authorize(req, new URL('http://localhost/'), { code: rotated.displayCode }).status, 401);

  const limited = { socket: { remoteAddress: '198.51.100.9' }, headers: {} };
  for (let n = 0; n < 4; n++) assert.equal(access.authorize(limited, new URL('http://localhost/'), { code: 'AAAA-AAAA' }).status, 401);
  assert.equal(access.authorize(limited, new URL('http://localhost/'), { code: 'BBBB-BBBB' }).status, 429);
  limited.headers.cookie = `inbox_session=${access.cookie()}`;
  assert.equal(access.authorize(limited, new URL('http://localhost/')).status, 200);

  const empty = { socket: { remoteAddress: '198.51.100.40' }, headers: {} };
  for (let n = 0; n < 6; n++) assert.equal(access.authorize(empty, new URL('http://localhost/'), { passphrase: '', code: '' }).status, 401);
  const fresh = access.deviceGrant();
  assert.equal(access.authorize(empty, new URL('http://localhost/'), { code: fresh.displayCode }).status, 302);
});

test('add-device web entry needs a cookie even on trusted LAN; redemption sets normal cookie', async t => {
  const { config } = setup(t); config.lanTrustSubnet = true;
  const server = await createInboxServer({ config }); await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.health().port}`;
  assert.equal((await fetch(`${base}/api/add-device`, { method: 'POST' })).status, 401);
  assert.equal((await (await fetch(`${base}/api/summary`)).json()).loggedIn, false);
  const first = await server.admin('add-device', {});
  assert.match(first.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(first.expiresIn, 300);
  const redeem = await fetch(`${base}/?device=${new URL(first.url).searchParams.get('device')}`, { redirect: 'manual' });
  assert.equal(redeem.status, 302); assert.equal(redeem.headers.get('location'), '/');
  const cookie = redeem.headers.get('set-cookie').split(';')[0];
  assert.match(redeem.headers.get('set-cookie'), /HttpOnly/);
  assert.match(redeem.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await (await fetch(`${base}/api/summary`, { headers: { cookie } })).json()).loggedIn, true);
  const next = await fetch(`${base}/api/add-device`, { method: 'POST', headers: { cookie } });
  assert.equal(next.status, 200);
  const nextBody = await next.json();
  assert.equal(nextBody.expiresIn, 300);
  assert.equal(nextBody.code, undefined);
  assert.match(nextBody.url, /[?&]device=/);
  assert.equal((await fetch(`${base}/api/add-device`, { method: 'POST', headers: { cookie, origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/?device=${new URL(first.url).searchParams.get('device')}`, { redirect: 'manual' })).status, 401);
});

test('POST login accepts one-time device code and rejects reuse', async t => {
  const { config, home } = setup(t);
  const webDir = path.join(home, 'code-login-public'); fs.mkdirSync(webDir);
  for (const file of ['login.html', 'login.js', 'i18n.js', 'style.css', 'icon.svg']) fs.writeFileSync(path.join(webDir, file), file);
  const server = await createInboxServer({ config, host: '127.0.0.1', webDir });
  await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.main.address().port}`;
  const remote = `http://127.0.0.1:${server.remote.address().port}`;
  const grant = await server.admin('add-device', {});
  const ok = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code: grant.code }),
    redirect: 'manual',
  });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('set-cookie'), /inbox_session=/);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(`${remote}/api/summary`, { headers: { cookie } })).json()).loggedIn, true);
  const reuse = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: `code=${encodeURIComponent(grant.code)}`,
    redirect: 'manual',
  });
  assert.equal(reuse.status, 303);
  assert.match(reuse.headers.get('location'), /login=failed/);
  assert.equal((await fetch(`${base}/?device=${new URL(grant.url).searchParams.get('device')}`, { redirect: 'manual' })).status, 401);
});

test('push result persists only public dispatch aggregates per question', t => {
  const { store } = setup(t); const item = store.ask('demo', question);
  store.pushResult('demo', item.id, { sent: true, at: '2026-10-17T00:00:00Z', endpoints: 2, endpoint: 'must-not-store', subscription: {} });
  assert.deepEqual(store.load('demo').items[0].push, { sent: true, at: '2026-10-17T00:00:00Z', endpoints: 2 });
});

test('default server writes dispatch outcome to inbox.json for a blocking question', async t => {
  const { config } = setup(t);
  const server = await createInboxServer({ config }); t.after(() => server.stop());
  const item = await server.admin('ask', { campaign: 'demo', item: question });
  const recorded = server.store.load('demo').items.find(entry => entry.id === item.id).push;
  assert.equal(recorded.sent, false); assert.equal(recorded.endpoints, 0);
  assert.ok(Number.isFinite(Date.parse(recorded.at)));
});

test('remove Campaign requires login and closed questions/messages; keeps data and supports register', async t => {
  const { config, dir, home } = setup(t); config.lanTrustSubnet = true;
  const events = []; let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { started = resolve; });
  const server = await createInboxServer({ config, host: '127.0.0.1', fetch: async (url, options) => {
    events.push(JSON.parse(options.body));
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.equal(loadConfig({ home }).campaigns.length, 0);
    started(); await gate; return { ok: true };
  } });
  await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.health().port}`;
  const cookie = `inbox_session=${new Access(config.privateDir).cookie()}`;
  const post = (value = { campaign: 'demo' }, headers = { cookie }) => fetch(`${base}/api/remove-campaign`, { method: 'POST', headers, body: JSON.stringify(value) });
  const summary = async () => (await (await fetch(`${base}/api/summary`)).json()).campaigns[0];
  assert.equal((await post(undefined, { cookie, Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await post(undefined, { cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const item = await server.admin('ask', { campaign: 'demo', item: question });
  assert.equal((await summary()).removable, false); assert.equal((await post()).status, 409);
  server.store.submit('demo', [{ id: item.id, answer: { choices: ['a'] } }]);
  assert.equal((await summary()).pending, 0); assert.equal((await summary()).removable, false);
  assert.equal((await post()).status, 409);
  server.store.change('demo', item.id, 'ack'); server.store.change('demo', item.id, 'close');
  const batch = server.store.submit('demo', [], [{ note: 'still open' }]);
  assert.equal((await summary()).removable, false); assert.equal((await post()).status, 409);
  server.store.change('demo', batch.messages[0], 'close');
  assert.equal((await summary()).removable, true);
  fs.mkdirSync(path.join(dir, 'media')); fs.writeFileSync(path.join(dir, 'media', 'kept.txt'), 'kept');
  const before = Object.fromEntries(['campaign.json', 'inbox.json', 'media/kept.txt'].map(file => [file, fs.readFileSync(path.join(dir, file))]));
  privateText(config.privateDir, 'webhooks/demo.url', 'https://webhook.invalid/test');
  const removal = post(); await sending;
  assert.equal((await post()).status, 409);
  await assert.rejects(server.admin('ask', { campaign: 'demo', item: question }), /正在移除/);
  const submit = await fetch(`${base}/api/submit`, { method: 'POST', body: JSON.stringify({ campaign: 'demo', messages: [{ note: 'race' }] }) });
  assert.equal(submit.status, 409);
  release(); const response = await removal;
  assert.equal(response.status, 200); assert.equal((await response.json()).notify, 'accepted');
  assert.deepEqual(events, [{ campaign: 'demo', event: 'removed' }]);
  assert.deepEqual(loadConfig({ home }).campaigns, []);
  for (const [file, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
  assert.ok(fs.existsSync(path.join(config.privateDir, 'webhooks/demo.url')));
  await server.admin('register', { dir, id: 'demo' });
  assert.equal((await summary()).removable, true);
});

test('trusted LAN canManage removes Campaign; untrusted/remote need cookie; cross-site still blocked', async t => {
  const { config, dir, home } = setup(t);
  const server = await createInboxServer({ config, host: '127.0.0.1' });
  await server.start(); t.after(() => server.stop());
  const lan = `http://127.0.0.1:${server.health().port}`;
  const remote = `http://127.0.0.1:${server.health().remotePort}`;
  const remove = (base, headers = {}) => fetch(`${base}/api/remove-campaign`, { method: 'POST', headers, body: JSON.stringify({ campaign: 'demo' }) });

  config.lanTrustSubnet = false;
  let body = await (await fetch(`${lan}/api/summary`)).json();
  assert.equal(body.loggedIn, false);
  assert.equal(body.canManage, false);
  assert.equal((await remove(lan)).status, 401);

  config.lanTrustSubnet = true;
  body = await (await fetch(`${lan}/api/summary`)).json();
  assert.equal(body.loggedIn, false);
  assert.equal(body.canManage, true);
  assert.equal((await remove(lan)).status, 200);
  assert.deepEqual(loadConfig({ home }).campaigns, []);

  await server.admin('register', { dir, id: 'demo' });
  assert.equal((await remove(remote)).status, 401);
  const cookie = `inbox_session=${new Access(config.privateDir).cookie()}`;
  body = await (await fetch(`${lan}/api/summary`, { headers: { cookie } })).json();
  assert.equal(body.loggedIn, true);
  assert.equal(body.canManage, true);
  assert.equal((await remove(lan, { Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await remove(lan, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await remove(remote, { cookie })).status, 200);
});

test('remove Campaign reports absent or failed webhook without losing retained data', async t => {
  const { config, dir } = setup(t);
  const server = await createInboxServer({ config, fetch: async () => { throw Error('private failure'); } });
  await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.health().port}`;
  const remove = () => fetch(`${base}/api/remove-campaign`, { method: 'POST', headers: { cookie: `inbox_session=${new Access(config.privateDir).cookie()}` }, body: JSON.stringify({ campaign: 'demo' }) }).then(r => r.json());
  assert.equal((await remove()).notify, 'unconfigured');
  await server.admin('register', { dir, id: 'demo' });
  privateText(config.privateDir, 'webhooks/demo.url', 'https://webhook.invalid/test');
  assert.deepEqual(await remove(), { ok: true, notify: 'failed' });
  assert.ok(fs.existsSync(path.join(dir, 'campaign.json')));
});

test('remote rate limit uses overwritten XFF; valid cookie bypasses lockout', async t => {
  const { config } = setup(t); let now = 1_000_000;
  const access = new Access(config.privateDir, { now: () => now });
  const proxy = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  for (let n = 0; n < 5; n++) {
    proxy.headers['x-forwarded-for'] = '203.0.113.10';
    assert.equal(access.authorize(proxy, new URL('https://example.test/?k=bad'), { trustForwarded: true }).status, n === 4 ? 429 : 401);
  }
  proxy.headers['x-forwarded-for'] = '198.51.100.20';
  assert.equal(access.authorize(proxy, new URL(`https://example.test/?k=${access.token}`), { trustForwarded: true }).status, 302);
  proxy.headers['x-forwarded-for'] = '203.0.113.10';
  proxy.headers.cookie = `inbox_session=${access.cookie()}`;
  assert.equal(access.authorize(proxy, new URL('https://example.test/api/summary'), { trustForwarded: true }).status, 200);
});

test('POST login sets cookie; GET ?k= still works for device links; Host gates loopback trust', async t => {
  const { config, home } = setup(t);
  const webDir = path.join(home, 'login-public'); fs.mkdirSync(webDir);
  for (const file of ['login.html', 'login.js', 'i18n.js', 'style.css', 'icon.svg']) fs.writeFileSync(path.join(webDir, file), file);
  fs.mkdirSync(path.join(config.campaigns[0].dir, 'media')); fs.writeFileSync(path.join(config.campaigns[0].dir, 'media', 'note.html'), '<script>window.pwned=1</script>');
  const push = { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} };
  const server = await createInboxServer({ config, host: '127.0.0.1', push, webDir });
  await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.main.address().port}`;
  const remote = `http://127.0.0.1:${server.remote.address().port}`;
  const token = privateText(config.privateDir, 'remote-token');
  const postLogin = await fetch(base + '/', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ k: token }), redirect: 'manual' });
  assert.equal(postLogin.status, 302);
  assert.match(postLogin.headers.get('set-cookie'), /inbox_session=/);
  assert.match(postLogin.headers.get('content-security-policy'), /frame-ancestors/);
  const formFail = await fetch(base + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'k=wrong', redirect: 'manual' });
  assert.equal(formFail.status, 303);
  assert.match(formFail.headers.get('location'), /login=failed/);
  const link = await fetch(`${remote}/?k=${token}`, { redirect: 'manual' });
  assert.equal(link.status, 302);
  const cookie = link.headers.get('set-cookie').split(';')[0];
  const media = await fetch(`${remote}/media/demo/media/note.html`, { headers: { cookie } });
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-security-policy'), /sandbox/);
  assert.match(media.headers.get('content-security-policy'), /frame-ancestors/);
  const byHostname = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.main.address().port, path: '/api/summary', headers: { Host: os.hostname() } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(byHostname.status, 401);
  const localhost = await fetch(`${base}/api/summary`);
  assert.equal(localhost.status, 200);
});

test('form login with Origin:null and Sec-Fetch-Site same-origin still checks credentials', async t => {
  const { config, home } = setup(t);
  const webDir = loginPublicDir(home, 'origin-null-public');
  const server = await createInboxServer({ config, host: '127.0.0.1', webDir });
  await server.start(); t.after(() => server.stop());
  const remote = `http://127.0.0.1:${server.remote.address().port}`;
  const browserSameOrigin = { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };

  const wrongForm = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { ...browserSameOrigin, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: 'code=WRONG-CODE',
    redirect: 'manual',
  });
  assert.equal(wrongForm.status, 303);
  assert.match(wrongForm.headers.get('location'), /login=failed/);
  assert.equal(wrongForm.headers.get('set-cookie'), null);

  const wrongJson = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { ...browserSameOrigin, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code: 'WRONG-CODE' }),
    redirect: 'manual',
  });
  assert.equal(wrongJson.status, 401);
  assert.equal(wrongJson.headers.get('set-cookie'), null);
  assert.match(await wrongJson.text(), /请使用远程口令链接|远程口令/);

  const grant = await server.admin('add-device', {});
  const ok = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { ...browserSameOrigin, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: `code=${encodeURIComponent(grant.code)}`,
    redirect: 'manual',
  });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('set-cookie'), /inbox_session=/);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(`${remote}/api/summary`, { headers: { cookie } })).json()).loggedIn, true);

  const token = privateText(config.privateDir, 'remote-token');
  const passphraseOk = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { ...browserSameOrigin, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ k: token }),
    redirect: 'manual',
  });
  assert.equal(passphraseOk.status, 302);
  assert.match(passphraseOk.headers.get('set-cookie'), /inbox_session=/);
});

test('form login Origin:null cross-site and malformed Origin stay 403', async t => {
  const { config, home } = setup(t);
  const webDir = loginPublicDir(home, 'origin-reject-public');
  const server = await createInboxServer({ config, host: '127.0.0.1', webDir });
  await server.start(); t.after(() => server.stop());
  const remote = `http://127.0.0.1:${server.remote.address().port}`;
  const grant = await server.admin('add-device', {});
  const body = `code=${encodeURIComponent(grant.code)}`;
  const form = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' };

  const crossSite = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { ...form, Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
    body,
    redirect: 'manual',
  });
  assert.equal(crossSite.status, 403);
  assert.match(await crossSite.text(), /不允许跨站写入/);
  assert.equal(crossSite.headers.get('set-cookie'), null);

  const malformed = await fetch(`${remote}/`, {
    method: 'POST',
    headers: { ...form, Origin: 'not a url' },
    body,
    redirect: 'manual',
  });
  assert.equal(malformed.status, 403);
  assert.match(await malformed.text(), /不允许跨站写入/);
  assert.equal(malformed.headers.get('set-cookie'), null);

  // Valid code must still work without Origin so the previous rejects were the gate, not auth.
  const ok = await fetch(`${remote}/`, {
    method: 'POST',
    headers: form,
    body,
    redirect: 'manual',
  });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('set-cookie'), /inbox_session=/);
});

test('lanTrustCidrs config validates; loopback+XFF uses rightmost hop for subnet', async t => {
  const { config, home } = setup(t);
  assert.equal(config.lanTrustCidrs, undefined);
  config.lanTrustCidrs = ['192.168.10.0/24']; saveConfig(config);
  assert.deepEqual(loadConfig({ home }).lanTrustCidrs, ['192.168.10.0/24']);
  config.lanTrustCidrs = ['not-a-cidr']; saveConfig(config);
  assert.throws(() => loadConfig({ home }), /lanTrustCidrs/);
  const interfaces = { eth: [{ address: '192.168.10.1', netmask: '255.255.255.0', internal: false }] };
  assert.equal(allowedLan('192.168.10.9', interfaces, { cidrs: ['192.168.10.0/24'] }), true);
  assert.equal(allowedLan('192.168.11.9', interfaces, { cidrs: ['192.168.10.0/24'] }), false);
  assert.equal(lanClientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), '127.0.0.1');
  assert.equal(lanClientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.1' } }), '203.0.113.1');
  config.lanTrustCidrs = ['192.168.10.0/24']; config.lanTrustSubnet = true; saveConfig(config);
  const loaded = loadConfig({ home }); loaded.port = 0; loaded.remotePort = 0; loaded.campaigns = config.campaigns;
  const push = { publicKey: '', start() {}, stop() {}, enqueue() {}, problem() {} };
  const server = await createInboxServer({ config: loaded, host: '127.0.0.1', interfaces, push });
  await server.start(); t.after(() => server.stop());
  const port = server.main.address().port;
  const ask = (xff) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/summary', headers: { Host: '127.0.0.1', ...(xff ? { 'X-Forwarded-For': xff } : {}) } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(await ask(), 200);
  assert.equal(await ask('192.168.10.9'), 200);
  assert.equal(await ask('198.51.100.9'), 403);
});
