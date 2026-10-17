import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { loadConfig, saveConfig, privateText } from './config.mjs';
import { Access, allowedAdmin, allowedLan, isLoopback, normalizeIp } from './access.mjs';
import { InboxStore, imageType, inside, mediaPath } from './store.mjs';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const mime = { '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function json(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); }
async function body(req, max = 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > max) { const error = new Error('文件超过 20MB 或请求过大'); error.status = 413; throw error; } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function input(req) { try { return JSON.parse((await body(req)).toString('utf8')); } catch (error) { if (error.status) throw error; throw new Error('请求必须是 JSON'); } }
export class ReverseTunnel {
  constructor(config, spawnProcess = spawn) { this.config = config; this.spawnProcess = spawnProcess; this.state = 'disabled'; this.attempt = 0; }
  start() {
    if (this.config.remote.type !== 'ssh-reverse' || this.stopped) return;
    const remote = this.config.remote;
    if (typeof remote.sshHost !== 'string' || remote.sshHost.startsWith('-') || !Number.isInteger(remote.remoteBindPort) || remote.remoteBindPort < 1 || remote.remoteBindPort > 65535) throw new Error('ssh-reverse 配置不完整');
    this.state = 'connecting';
    if (remote.remoteBindHost !== undefined && (typeof remote.remoteBindHost !== 'string' || /[\s\r\n]/.test(remote.remoteBindHost))) throw new Error('remoteBindHost 必须是有效监听地址');
    const bind = remote.remoteBindHost ? `${remote.remoteBindHost}:` : '';
    if (process.platform === 'win32' && !process.env.SystemRoot) throw new Error('缺少 SystemRoot，无法定位系统 OpenSSH');
    const executable = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
    this.child = this.spawnProcess(executable, ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'BatchMode=yes', '-R', `${bind}${remote.remoteBindPort}:127.0.0.1:${this.config.remotePort}`, remote.sshHost], { windowsHide: true, stdio: 'ignore' });
    this.child.once('spawn', () => { this.state = 'running'; });
    let ended = false;
    const reconnect = () => { if (ended || this.stopped) return; ended = true; this.state = 'reconnecting'; this.timer = setTimeout(() => this.start(), Math.min(60000, 1000 * 2 ** Math.min(this.attempt++, 6))); this.timer.unref(); };
    this.child.once('error', reconnect); this.child.once('exit', reconnect);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.child?.kill(); this.state = 'stopped'; }
}
export async function createInboxServer(options = {}) {
  const config = options.config || loadConfig({ home: options.home });
  const store = new InboxStore(config), access = new Access(config.privateDir);
  const tunnel = new ReverseTunnel(config, options.spawnProcess);
  let push = options.push;
  if (!push) { const { PushService } = await import('./push.mjs'); push = new PushService({ privateDir: config.privateDir, publicUrl: config.remote.publicUrl, machine: config.name, onDelivery: (items, result) => {
      for (const item of items) store.pushResult(item.campaign, item.id, result);
    } }); }
  let staleTimer;
  const inflight = new Set();
  const notificationQueues = new Map();
  function track(promise) { inflight.add(promise); promise.finally(() => inflight.delete(promise)).catch(() => {}); return promise; }
  async function deliver(campaign, ids, messageIds, snapshot) {
    const revisions = Object.fromEntries([...snapshot.items, ...snapshot.messages].filter(item => ids.includes(item.id) || messageIds.includes(item.id)).map(item => [item.id, JSON.stringify({ answer: item.answer, saved: item.times.saved, withdrawn: item.times.withdrawn, submissionId: item.submissionId })]));
    const webhook = privateText(config.privateDir, `webhooks/${campaign}.url`);
    let state = 'unconfigured';
    if (webhook) {
      try {
        const response = await (options.fetch || fetch)(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Orchestration-Inbox/1.0' }, body: JSON.stringify({ campaign, items: ids, messages: messageIds }), signal: AbortSignal.timeout(15000), redirect: 'error' });
        state = response.ok ? 'accepted' : 'failed';
        await response.body?.cancel();
      } catch { state = 'failed'; }
    }
    store.notified(campaign, ids, messageIds, state, revisions);
    options.log?.({ event: 'webhook', campaign, result: state });
    if (state === 'failed') {
      const submissions = new Map([...snapshot.items, ...snapshot.messages].filter(item => ids.includes(item.id) || messageIds.includes(item.id)).map(item => [item.submissionId, item.id]));
      for (const [submissionId, id] of submissions) if (store.claimSubmissionProblem(campaign, submissionId)) await push.problem({ campaign, id, title: '通知没送到', submissionKey: submissionId });
    }
    return state;
  }
  function notify(campaign, ids, messageIds) {
    const snapshot = store.load(campaign);
    const previous = notificationQueues.get(campaign) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => deliver(campaign, ids, messageIds, snapshot));
    notificationQueues.set(campaign, next);
    next.finally(() => { if (notificationQueues.get(campaign) === next) notificationQueues.delete(campaign); }).catch(() => {});
    return next;
  }
  function locate(data) {
    if (data.campaign) return data.campaign;
    const matches = config.campaigns.filter(c => { const state = store.load(c.id); return [...state.items, ...state.messages].some(x => x.id === data.id); });
    if (matches.length !== 1) throw new Error('请指定 campaign，条目不存在或跨 Campaign 重名');
    return matches[0].id;
  }
  async function admin(command, data) {
    if (command === 'health' || command === 'status') return health();
    if (command === 'register') {
      if (typeof data.dir !== 'string') throw new Error('dir 必须是目录');
      const dir = fs.realpathSync(data.dir), state = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
      const id = data.id || state.id || path.basename(dir);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Campaign id 只能含字母、数字、下划线和短横线');
      const campaign = { id, title: data.title || state.campaign || state.title || id, project: data.project || state.project || '', dir };
      const existing = config.campaigns.findIndex(c => c.id === id);
      if (existing >= 0) config.campaigns[existing] = campaign; else config.campaigns.push(campaign);
      saveConfig(config); return campaign;
    }
    if (command === 'unregister') { store.campaign(data.campaign || data.id); config.campaigns = config.campaigns.filter(x => x.id !== (data.campaign || data.id)); saveConfig(config); return { ok: true }; }
    if (command === 'add-device') {
      const url = new URL(config.remote.publicUrl || config.lanHttpsUrl || `http://${os.hostname()}:${health().port}/`);
      url.searchParams.set('device', access.deviceLink());
      return { url: url.href, expiresIn: 300 };
    }
    if (command === 'rotate-token') {
      const token = access.rotate();
      const url = new URL('/', config.remote.publicUrl || config.lanHttpsUrl || `http://${os.hostname()}:${health().port}/`);
      url.searchParams.set('k', token);
      return { url: url.href, configured: true };
    }
    if (command === 'set-webhook') {
      store.campaign(data.campaign);
      try { const url = new URL(data.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw new Error('webhook 必须是 HTTP(S) 地址'); }
      privateText(config.privateDir, `webhooks/${data.campaign}.url`, data.url); return { ok: true };
    }
    if (command === 'ask') { const item = store.ask(data.campaign, data.item); await push.enqueue({ campaign: data.campaign, id: item.id, title: item.title, blocking: item.blocking }); return item; }
    if (command === 'pending') return store.pending(data.campaign);
    if (['ack', 'forward', 'close'].includes(command)) return store.change(locate(data), data.id, command, data);
    throw new Error('未知管理命令');
  }
  function health() { return { ok: true, machine: config.name, port: main?.address()?.port ?? config.port, remotePort: remote?.address()?.port ?? config.remotePort, tunnel: tunnel.state }; }
  function sendFile(req, res, file, status = 200) {
    const stat = fs.statSync(file), type = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    if (req.headers.range && status === 200) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      let start = match?.[1] ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : stat.size - 1;
      if (match && !match[1] && match[2]) { start = Math.max(0, stat.size - Number(match[2])); end = stat.size - 1; }
      if (!match || start > end || start >= stat.size || end >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res); return;
    }
    res.writeHead(status, headers); if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  }
  function handler(isRemote) { return async (req, res) => {
    try {
      if (!isRemote && !allowedLan(req.socket.remoteAddress, options.interfaces)) return json(res, 403, { error: '来源不在本机子网' });
      const url = new URL(req.url, 'http://inbox.local');
      const hub = isRemote && req.headers['x-inbox-hub'] === '1';
      const requestHost = new URL(`http://${req.headers.host || ''}`).hostname.replace(/^\[|\]$/g, '');
      if (!isRemote) {
        const knownNames = ['localhost', os.hostname().toLowerCase(), config.name.toLowerCase()];
        const hostAllowed = knownNames.includes(requestHost.toLowerCase()) || (net.isIP(requestHost) && allowedLan(normalizeIp(requestHost), options.interfaces));
        if (!hostAllowed) return json(res, 403, { error: '请求主机不在本机网络' });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '不允许跨站写入' });
        if (req.headers.origin) {
          const origin = new URL(req.headers.origin);
          const expected = isRemote && config.remote.publicUrl ? new URL(config.remote.publicUrl).origin : `http://${req.headers.host}`;
          const lanHttpsOrigin = !isRemote && config.lanHttpsUrl ? new URL(config.lanHttpsUrl).origin : null;
          if (origin.origin !== expected && origin.origin !== lanHttpsOrigin) return json(res, 403, { error: '不允许跨站写入' });
        }
      }
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments[0] === 'admin') {
        if (!allowedAdmin(req, isRemote)) return json(res, 403, { error: '管理接口只允许本机访问' });
        if (req.method !== 'POST') return json(res, 405, { error: '只允许 POST' });
        return json(res, 200, await admin(segments[1], await input(req)));
      }
      const localRequest = isLoopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
      if (isRemote || (!localRequest && config.lanTrustSubnet !== true) || url.searchParams.has('device')) {
        if (['GET', 'HEAD'].includes(req.method) && ['login.js', 'i18n.js', 'style.css', 'icon.svg'].includes(url.pathname.slice(1))) {
          sendFile(req, res, mediaPath(options.webDir || webDir, url.pathname.slice(1))); return;
        }
        const auth = access.authorize(req, url);
        if (auth.status === 302) {
          url.searchParams.delete('k'); url.searchParams.delete('device');
          const prefix = isRemote && !hub && config.remote.publicUrl ? new URL(config.remote.publicUrl).pathname.replace(/\/?$/, '/') : '/';
          const location = prefix === '/' || url.pathname.startsWith(prefix) ? url.pathname : `${prefix}${url.pathname.replace(/^\//, '')}`;
          res.writeHead(302, { Location: `${location}${url.search}`, 'Set-Cookie': `inbox_session=${auth.cookie}; Max-Age=31536000; HttpOnly;${isRemote ? ' Secure;' : ''} SameSite=Lax; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
        }
        if (auth.status !== 200) {
          if (['GET', 'HEAD'].includes(req.method) && req.headers.accept?.includes('text/html')) {
            res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
            sendFile(req, res, mediaPath(options.webDir || webDir, 'login.html'), auth.status); return;
          }
          return json(res, auth.status, { error: auth.status === 429 ? '尝试过多，请稍后再试' : '请使用远程口令链接' });
        }
      }
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (segments[0] === 'health' && req.method === 'GET') return json(res, 200, health());
      if (segments[0] === 'api') {
        const route = segments[1];
        if (req.method === 'POST' && route === 'add-device') {
          if (!access.validCookie(req.headers.cookie)) return json(res, 401, { error: 'Login required / 请先登录' });
          return json(res, 200, await admin('add-device', {}));
        }
        if (req.method === 'GET' && route === 'summary') {
          const headers = !isRemote && config.lanTrustSubnet === true ? { 'Access-Control-Allow-Origin': '*' } : {};
          return json(res, 200, { machine: config.name, name: config.name, loggedIn: access.validCookie(req.headers.cookie), hub, remote: isRemote, peers: config.peers.map(p => typeof p === 'string' ? { name: p } : p), publicKey: push.publicKey, campaigns: config.campaigns.map(c => ({ id: c.id, title: c.title, project: c.project, pending: store.load(c.id).items.filter(x => x.status === 'open').length })) }, headers);
        }
        if (req.method === 'GET' && route === 'campaign') {
          const data = store.view(segments[2]);
          return json(res, 200, { ...data, campaign: { id: data.campaign.id, title: data.campaign.title, project: data.campaign.project }, remote: isRemote, publicKey: push.publicKey, publicUrl: config.remote.publicUrl || null, lanHttpsUrl: config.lanHttpsUrl || null });
        }
        if (req.method === 'POST' && route === 'submit') { const data = await input(req); const batch = store.submit(data.campaign, data.items, data.messages); const result = await track(notify(data.campaign, batch.items, batch.messages)); return json(res, 200, { ...batch, notify: result }); }
        if (req.method === 'POST' && route === 'item') {
          const data = await input(req), campaign = segments[2], id = segments[3];
          if (data.action === 'retry') { const state = store.load(campaign), item = [...state.items, ...state.messages].find(x => x.id === id); if (!item || !['saved', 'notified'].includes(item.status)) throw new Error('此状态不能重发'); return json(res, 200, { notify: await track(notify(campaign, item.kind ? [id] : [], item.kind ? [] : [id])) }); }
          if (data.action !== 'withdraw') throw new Error('未知操作');
          const item = store.change(campaign, id, 'withdraw'); await track(notify(campaign, [id], [])); return json(res, 200, item);
        }
        if (req.method === 'POST' && route === 'upload') {
          const campaign = store.campaign(segments[2]), itemId = segments[3];
          if (!itemId || !/^[A-Za-z0-9_-]+$/.test(itemId)) throw new Error('图片条目 id 无效');
          const item = store.load(campaign.id).items.find(x => x.id === itemId);
          if (itemId !== 'messages' && (!item || item.status === 'closed')) throw new Error('题目不存在或已结案');
          const bytes = await body(req, 20 * 1024 * 1024), type = imageType(bytes); if (!type) throw new Error('只接收 PNG、JPEG、WebP、GIF、HEIC 图片');
          const relative = `inbox/uploads/${itemId}/${randomUUID()}.${type.extension}`, file = path.join(campaign.dir, relative);
          const root = fs.realpathSync(campaign.dir);
          // 每层创建前先核对父目录，避免递归 mkdir 沿现有符号链接在 Campaign 外建目录。
          let directory = campaign.dir;
          for (const segment of ['inbox', 'uploads', itemId]) {
            directory = path.join(directory, segment);
            if (!fs.existsSync(directory)) fs.mkdirSync(directory);
            if (!inside(root, fs.realpathSync(directory))) throw new Error('上传目录越界');
          }
          fs.writeFileSync(file, bytes, { flag: 'wx' }); return json(res, 200, { path: relative, reference: relative, url: `media/${encodeURIComponent(campaign.id)}/${relative}` });
        }
        if (req.method === 'GET' && route === 'push-key') return json(res, 200, { publicKey: push.publicKey });
        if (req.method === 'POST' && route === 'subscribe') { if (!isRemote) return json(res, 403, { error: '请在 HTTPS 远程入口订阅' }); await push.subscribe(await input(req)); return json(res, 200, { ok: true }); }
        return json(res, 404, { error: '接口不存在' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的方法' });
      if (segments[0] === 'media') { const campaign = store.campaign(segments[1]); sendFile(req, res, mediaPath(campaign.dir, segments.slice(2).join('/'))); return; }
      const relative = segments.length ? segments.join('/') : 'index.html';
      sendFile(req, res, mediaPath(options.webDir || webDir, relative));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = !error.code && !['TypeError', 'SyntaxError'].includes(error.name);
      json(res, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: known ? error.message : '请求无法处理' });
    }
  }; }
  const main = http.createServer(handler(false)), remote = http.createServer(handler(true));
  return {
    config, store, main, remote, admin, health,
    async start() {
      const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
      try { await listen(main, config.port, options.host || '0.0.0.0'); await listen(remote, config.remotePort, '127.0.0.1'); await push.start(); tunnel.start(); }
      catch (error) { await this.stop(); throw error; }
      staleTimer = setInterval(() => {
        for (const campaign of config.campaigns) {
          const data = store.load(campaign.id);
          for (const item of [...data.items, ...data.messages]) if (item.status === 'notified' && Date.now() - Date.parse(item.times.notified) >= 900000 && store.claimSubmissionProblem(campaign.id, item.submissionId)) {
            track(Promise.resolve(push.problem({ campaign: campaign.id, id: item.id, title: '答复超过 15 分钟未读', submissionKey: item.submissionId })));
          }
        }
      }, 30000); staleTimer.unref(); return this;
    },
    async stop() { clearInterval(staleTimer); tunnel.stop(); await Promise.allSettled([...inflight]); await push.stop(); await Promise.all([main, remote].map(s => new Promise(resolve => { if (!s.listening) return resolve(); s.close(resolve); s.closeIdleConnections(); }))); }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createInboxServer({ log: event => console.log(JSON.stringify(event)) }); await server.start();
    console.log(`Inbox listening on ${server.health().port}`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await server.stop(); process.exit(0); });
  } catch { console.error('Inbox 启动失败，请检查端口和配置'); process.exitCode = 1; }
}
