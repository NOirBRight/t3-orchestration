import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import { loadConfig, saveCampaigns, privateText } from './config.mjs';
import { Access, allowedAdmin, allowedLan, isLocalhostHost, isLoopback, lanClientIp, normalizeIp, parseBearer, relayAllowedPath } from './access.mjs';
import { InboxStore, mediaPath } from './store.mjs';
import { ReverseTunnel } from './tunnel.mjs';
import { createAdmin } from './admin.mjs';
import { handleApi } from './api.mjs';
import { loadRouting } from './routing.mjs';
import { pushGlobalToPeers } from './routing-sync.mjs';
import {
  SITE_HEADERS,
  json, input, loginCredentials, loginPassphrase, sendFile,
} from './http-util.mjs';

export { ReverseTunnel } from './tunnel.mjs';
export { UPLOAD_MAX_BYTES, CAMPAIGN_UPLOAD_BYTES } from './http-util.mjs';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export async function createInboxServer(options = {}) {
  const config = options.config || loadConfig({ home: options.home });
  const store = new InboxStore(config), access = new Access(config.privateDir);
  const tunnel = new ReverseTunnel(config, options.spawnProcess);
  let push = options.push;
  if (!push) {
    const { PushService } = await import('./push.mjs');
    push = new PushService({
      privateDir: config.privateDir,
      publicUrl: config.remote.publicUrl,
      machine: config.name,
      onDelivery: (items, result) => {
        for (const item of items) if (config.campaigns.some(c => c.id === item.campaign)) store.pushResult(item.campaign, item.id, result);
      },
    });
  }
  let relay = options.relay;
  if (!relay) {
    const { RelayService } = await import('./relay.mjs');
    relay = new RelayService({
      privateDir: config.privateDir,
      config,
      fetchImpl: options.fetch || fetch,
      sleep: options.relaySleep,
      log: options.log || (() => {}),
      onProblem: async item => {
        if (store.claimRelayProblem(item.campaign, item.id)) {
          await push.problem({
            campaign: item.campaign,
            id: item.id,
            type: 'relay-failed',
            title: item.title || '聊天中继没送到',
            submissionKey: item.submissionKey || `relay-failed:${item.campaign}:${item.id}`,
          });
        }
      },
    });
  }
  let staleTimer;
  const inflight = new Set();
  const notificationQueues = new Map();
  const removing = new Set();
  function writable(campaign) {
    if (removing.has(campaign)) { const error = new Error('Campaign 正在移除'); error.status = 409; throw error; }
  }
  function track(promise) { inflight.add(promise); promise.finally(() => inflight.delete(promise)).catch(() => {}); return promise; }
  async function deliver(campaign, ids, messageIds, snapshot) {
    const revisions = Object.fromEntries([...snapshot.items, ...snapshot.messages].filter(item => ids.includes(item.id) || messageIds.includes(item.id)).map(item => [item.id, JSON.stringify({ answer: item.answer, saved: item.times.saved, withdrawn: item.times.withdrawn, submissionId: item.submissionId })]));
    const state = await sendWebhook(campaign, { campaign, items: ids, messages: messageIds });
    store.notified(campaign, ids, messageIds, state, revisions);
    if (state === 'failed') {
      const submissions = new Map([...snapshot.items, ...snapshot.messages].filter(item => ids.includes(item.id) || messageIds.includes(item.id)).map(item => [item.submissionId, item.id]));
      for (const [submissionId, id] of submissions) if (store.claimSubmissionProblem(campaign, submissionId)) await push.problem({ campaign, id, type: 'notify-failed', title: '通知没送到', submissionKey: submissionId });
    }
    return state;
  }
  async function sendWebhook(campaign, payload) {
    const webhook = privateText(config.privateDir, `webhooks/${campaign}.url`);
    let state = 'unconfigured';
    if (webhook) {
      try {
        const response = await (options.fetch || fetch)(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Orchestration-Inbox/1.0' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error' });
        state = response.ok ? 'accepted' : 'failed';
        await response.body?.cancel();
      } catch { state = 'failed'; }
    }
    options.log?.({ event: 'webhook', campaign, result: state });
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
  function unregister(campaign) {
    store.campaign(campaign);
    const campaigns = config.campaigns;
    config.campaigns = campaigns.filter(x => x.id !== campaign);
    try { saveCampaigns(config); } catch (error) { config.campaigns = campaigns; throw error; }
    return { ok: true };
  }
  function removable(campaign) {
    const state = store.load(campaign);
    return [...state.items, ...state.messages].every(item => item.status === 'closed');
  }
  async function removeCampaign(campaign) {
    writable(campaign);
    if (!removable(campaign)) { const error = new Error('请先结案所有题目和留言'); error.status = 409; throw error; }
    removing.add(campaign);
    try {
      await notificationQueues.get(campaign);
      const result = unregister(campaign);
      const notifyState = await sendWebhook(campaign, { campaign, event: 'removed' });
      return { ...result, notify: notifyState };
    } finally { removing.delete(campaign); }
  }
  function health() { return { ok: true, machine: config.name, port: main?.address()?.port ?? config.port, remotePort: remote?.address()?.port ?? config.remotePort, tunnel: tunnel.state }; }
  function matchRelayToken(campaign, tokenId, secret) {
    const direct = relay.matchToken(campaign, tokenId, secret);
    if (direct) return direct;
    // Valid token for another Campaign must not look like a bad password (401); it is forbidden (403).
    for (const entry of config.campaigns) {
      if (entry.id === campaign) continue;
      if (relay.matchToken(entry.id, tokenId, secret)) {
        const error = new Error('中继无权访问此 Campaign');
        error.status = 403;
        error.reason = 'wrong-campaign';
        throw error;
      }
    }
    return null;
  }
  const admin = createAdmin({ config, store, access, push, relay, writable, locate, unregister, health });
  function setSession(res, auth, url, { isRemote, hub }) {
    url.searchParams.delete('k'); url.searchParams.delete('device'); url.searchParams.delete('login');
    const prefix = isRemote && !hub && config.remote.publicUrl ? new URL(config.remote.publicUrl).pathname.replace(/\/?$/, '/') : '/';
    const location = prefix === '/' || url.pathname.startsWith(prefix) ? url.pathname : `${prefix}${url.pathname.replace(/^\//, '')}`;
    res.writeHead(302, { Location: `${location}${url.search}`, 'Set-Cookie': `inbox_session=${auth.cookie}; Max-Age=31536000; HttpOnly;${isRemote ? ' Secure;' : ''} SameSite=Lax; Path=/`, 'Cache-Control': 'no-store', ...SITE_HEADERS });
    res.end();
  }
  // machine.json peers can change while the service runs (setup on a new machine);
  // re-read them so sync and the Sync tab do not need a restart.
  function refreshPeers() {
    if (options.config) return;
    try { config.peers = loadConfig({ home: config.home }).peers; } catch (error) { options.log?.({ event: 'peers-reload-error', error: error.message }); }
  }
  function handler(isRemote) {
    return async (req, res) => {
      try {
        refreshPeers();
        const lanOptions = { cidrs: config.lanTrustCidrs };
        if (!isRemote && !allowedLan(lanClientIp(req), options.interfaces, lanOptions)) return json(res, 403, { error: '来源不在本机子网' });
        const url = new URL(req.url, 'http://inbox.local');
        const hub = isRemote && req.headers['x-inbox-hub'] === '1';
        const requestHost = new URL(`http://${req.headers.host || ''}`).hostname.replace(/^\[|\]$/g, '');
        if (!isRemote) {
          const knownNames = ['localhost', os.hostname().toLowerCase(), config.name.toLowerCase()];
          const hostAllowed = knownNames.includes(requestHost.toLowerCase()) || (net.isIP(requestHost) && allowedLan(normalizeIp(requestHost), options.interfaces, lanOptions));
          if (!hostAllowed) return json(res, 403, { error: '请求主机不在本机网络' });
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          const fetchSite = req.headers['sec-fetch-site'];
          // Browsers under Referrer-Policy may send Origin: null on same-origin form POSTs.
          // Prefer Sec-Fetch-Site for same-origin/none; never let Origin parse throw into the 400 catch.
          if (fetchSite === 'cross-site') return json(res, 403, { error: '不允许跨站写入' });
          if (req.headers.origin && fetchSite !== 'same-origin' && fetchSite !== 'none') {
            let origin;
            try {
              origin = new URL(req.headers.origin);
            } catch {
              return json(res, 403, { error: '不允许跨站写入' });
            }
            const expected = isRemote && config.remote.publicUrl ? new URL(config.remote.publicUrl).origin : `http://${req.headers.host}`;
            const lanHttpsOrigin = !isRemote && config.lanHttpsUrl ? new URL(config.lanHttpsUrl).origin : null;
            if (origin.origin !== expected && origin.origin !== lanHttpsOrigin) return json(res, 403, { error: '不允许跨站写入' });
          }
        }
        const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (segments[0] === 'admin') {
          if (!allowedAdmin(req, isRemote, access.ensureAdminToken())) return json(res, 403, { error: '管理接口只允许本机访问' });
          if (req.method !== 'POST') return json(res, 405, { error: '只允许 POST' });
          return json(res, 200, await admin(segments[1], await input(req)));
        }
        const bearer = parseBearer(req.headers.authorization);
        let relayPrincipal = null;
        if (bearer) {
          const campaignGuess = segments[0] === 'api'
            ? (segments[1] === 'submit' ? null : segments[2])
            : (segments[0] === 'media' ? segments[1] : null);
          // submit carries campaign in the body; authorize after body parse in handleApi.
          if (segments[0] === 'api' && segments[1] === 'submit' && req.method === 'POST') {
            req._inboxRelayPending = true;
          } else {
            // Health is campaign-agnostic: any valid relay token may call it.
            if (segments[0] === 'health' && req.method === 'GET') {
              let authHealth;
              try {
                authHealth = access.authorizeRelay(req, {
                  campaign: config.campaigns[0]?.id || '',
                  trustForwarded: isRemote,
                  match: (campaign, tokenId, secret) => {
                    for (const entry of config.campaigns) {
                      const hit = relay.matchToken(entry.id, tokenId, secret);
                      if (hit) return hit;
                    }
                    return null;
                  },
                });
              } catch (error) {
                if (error.reason === 'wrong-campaign') return json(res, 403, { error: error.message, reason: error.reason });
                throw error;
              }
              if (authHealth.status !== 200) {
                return json(res, authHealth.status, { error: authHealth.status === 429 ? '尝试过多，请稍后再试' : '中继认证失败' });
              }
              relayPrincipal = authHealth.principal;
            } else {
            const pathOk = campaignGuess && relayAllowedPath(req.method, segments, { campaign: campaignGuess });
            if (!pathOk) {
              return json(res, 403, { error: '中继无权访问此接口' });
            }
            let auth;
            try {
              auth = access.authorizeRelay(req, {
                campaign: campaignGuess,
                trustForwarded: isRemote,
                match: matchRelayToken,
              });
            } catch (error) {
              if (error.reason === 'wrong-campaign') return json(res, 403, { error: error.message, reason: error.reason });
              throw error;
            }
            if (auth.status !== 200) {
              return json(res, auth.status, { error: auth.status === 429 ? '尝试过多，请稍后再试' : '中继认证失败' });
            }
            relayPrincipal = auth.principal;
            // canManage stays false for relay; trusted-LAN elevation does not apply to bearer tokens.
            }
          }
        }
        const localRequest = isLoopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && isLocalhostHost(requestHost);
        const needsAuth = !relayPrincipal && !req._inboxRelayPending && (isRemote || (!localRequest && config.lanTrustSubnet !== true) || url.searchParams.has('device') || (req.method === 'POST' && !segments[0]));
        if (needsAuth) {
          if (['GET', 'HEAD'].includes(req.method) && ['login.js', 'i18n.js', 'style.css', 'icon.svg'].includes(url.pathname.slice(1))) {
            sendFile(req, res, mediaPath(options.webDir || webDir, url.pathname.slice(1))); return;
          }
          let auth;
          if (req.method === 'POST' && !segments[0]) {
            const credentials = await loginCredentials(req);
            auth = access.authorize(req, url, { passphrase: credentials.passphrase, code: credentials.code, trustForwarded: isRemote });
          } else {
            auth = access.authorize(req, url, { trustForwarded: isRemote });
          }
          if (auth.status === 302) return setSession(res, auth, url, { isRemote, hub });
          if (auth.status !== 200) {
            if (req.method === 'POST' && !segments[0] && req.headers.accept?.includes('text/html')) {
              url.searchParams.set('login', auth.status === 429 ? 'blocked' : 'failed');
              res.writeHead(303, { Location: `${url.pathname}${url.search}`, 'Cache-Control': 'no-store', ...SITE_HEADERS }); return res.end();
            }
            if (['GET', 'HEAD'].includes(req.method) && req.headers.accept?.includes('text/html')) {
              sendFile(req, res, mediaPath(options.webDir || webDir, 'login.html'), auth.status, { 'Cache-Control': 'no-store' }); return;
            }
            return json(res, auth.status, { error: auth.status === 429 ? '尝试过多，请稍后再试' : '请使用远程口令链接' });
          }
          if (req.method === 'POST' && !segments[0]) return setSession(res, { cookie: access.cookie() }, url, { isRemote, hub });
        }
        for (const [key, value] of Object.entries(SITE_HEADERS)) res.setHeader(key, value);
        if (segments[0] === 'health' && req.method === 'GET') return json(res, 200, health());
        if (segments[0] === 'api') {
          return await handleApi(req, res, {
            segments, isRemote, hub, config, store, access, push, relay, options: { ...options, matchRelayToken }, admin, writable, track, notify, removeCampaign, relayPrincipal,
          });
        }
        if (relayPrincipal && segments[0] === 'media') {
          // fall through to media handler below
        } else if (relayPrincipal) {
          return json(res, 403, { error: '中继无权访问此接口' });
        }
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的方法' });
        if (segments[0] === 'media') {
          const campaign = store.campaign(segments[1]);
          const file = mediaPath(campaign.dir, segments.slice(2).join('/'));
          // Campaign artifacts must never execute with the Inbox's origin or permissions.
          const headers = { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Cache-Control': 'no-store' };
          if (['.html', '.htm', '.js', '.mjs', '.xml', '.xhtml'].includes(path.extname(file).toLowerCase())) headers['Content-Disposition'] = 'attachment';
          sendFile(req, res, file, 200, headers);
          return;
        }
        const relative = segments.length ? segments.join('/') : 'index.html';
        sendFile(req, res, mediaPath(options.webDir || webDir, relative));
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        const known = !error.code && !['TypeError', 'SyntaxError'].includes(error.name);
        const body = { error: known ? error.message : '请求无法处理' };
        if (error.reason) {
          body.reason = error.reason;
          if (error.itemStatus !== undefined) body.status = error.itemStatus;
          if (error.answeredVia !== undefined) body.answeredVia = error.answeredVia;
          if (error.submissionId !== undefined) body.submissionId = error.submissionId;
          if (error.replacedBy !== undefined) body.replacedBy = error.replacedBy;
        }
        const httpStatus = typeof error.status === 'number' ? error.status : (error.code === 'ENOENT' ? 404 : 400);
        json(res, httpStatus, body);
      }
    };
  }
  const main = http.createServer(handler(false)), remote = http.createServer(handler(true));
  return {
    config, store, main, remote, admin, health, relay,
    async start() {
      const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
      try { await listen(main, config.port, options.host || '0.0.0.0'); await listen(remote, config.remotePort, '127.0.0.1'); await push.start(); tunnel.start(); }
      catch (error) { await this.stop(); throw error; }
      // Catch-up push so a peer added or offline during the last global save converges (stale versions are ignored by peers).
      if (!options.config && config.peers.length) {
        track(pushGlobalToPeers(config, { fetchImpl: options.fetch || fetch, routing: loadRouting(config.home) })
          .catch(error => options.log?.({ event: 'routing-sync-startup-error', error: error.message })));
      }
      if (!this._uncaughtHandler) {
        this._uncaughtHandler = error => options.log?.({ event: 'uncaughtException', error: error?.stack || String(error) });
        process.on('uncaughtException', this._uncaughtHandler);
      }
      staleTimer = setInterval(() => {
        for (const campaign of config.campaigns) {
          try {
            const data = store.load(campaign.id);
            for (const item of [...data.items, ...data.messages]) if (item.status === 'notified' && Date.now() - Date.parse(item.times.notified) >= 900000 && store.claimSubmissionProblem(campaign.id, item.submissionId)) {
              track(Promise.resolve(push.problem({ campaign: campaign.id, id: item.id, type: 'unread-15m', title: '答复超过 15 分钟未读', submissionKey: item.submissionId })));
            }
          } catch (error) {
            options.log?.({ event: 'stale-check-error', campaign: campaign.id, error: error.message });
          }
        }
      }, 30000); staleTimer.unref(); return this;
    },
    async stop() {
      clearInterval(staleTimer);
      if (this._uncaughtHandler) { process.off('uncaughtException', this._uncaughtHandler); this._uncaughtHandler = null; }
      tunnel.stop(); await Promise.allSettled([...inflight]); await push.stop(); await relay.stop?.(); await Promise.all([main, remote].map(s => new Promise(resolve => { if (!s.listening) return resolve(); s.close(resolve); s.closeIdleConnections(); })));
    },
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
