import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageType, inside } from './store.mjs';
import { canManage } from './access.mjs';
import { UPLOAD_MAX_BYTES, CAMPAIGN_UPLOAD_BYTES, body, directoryBytes, input, json, summaryCors, tooLarge } from './http-util.mjs';
import {
  applyLayerPatch, loadCampaignRouting, loadCatalog, loadRouting, resolveAll, resolveRoute, routingView, setQuota, writeCatalog,
} from './routing.mjs';
import { forwardMachinePatch, pushGlobalToPeers, receiveGlobalSync } from './routing-sync.mjs';
import { publishRoutingChange, routingActor } from './routing-events.mjs';
import { kanbanView } from './kanban.mjs';

function campaignDirFor(config, store, campaignId) {
  if (!campaignId) return null;
  return store.campaign(campaignId).dir;
}

function layerSnapshot(document, { scope, machine, campaign = null }) {
  if (scope === 'global') return document?.global || {};
  if (scope === 'machine') return document?.machines?.[machine] || {};
  return campaign || {};
}

// One place for the "wake the affected orchestrators" call after a routing write.
// publishRoutingChange never throws: failures are logged and the write still succeeds.
async function reportRoutingWrite({
  config, options, req, scope, campaignId = null, machine = config.name,
  before, after, beforeCampaign = null, afterCampaign = null, actor, routingVersion,
}) {
  await publishRoutingChange({
    config,
    scope,
    campaignId,
    machine,
    beforeLayer: layerSnapshot(before, { scope, machine, campaign: beforeCampaign }),
    afterLayer: layerSnapshot(after, { scope, machine, campaign: afterCampaign }),
    routingVersion,
    changedBy: routingActor(actor, { origin: req?.headers?.origin }),
    fetchImpl: options.fetch || fetch,
    log: options.log,
  });
}

export async function handleApi(req, res, {
  segments, isRemote, hub, config, store, access, push, relay, options, admin, writable, track, notify, removeCampaign, relayPrincipal = null,
}) {
  const route = segments[1];
  if (relayPrincipal && !['submit', 'item', 'upload', 'campaign'].includes(route)) {
    return json(res, 403, { error: '中继无权访问此接口' });
  }
  if (req.method === 'POST' && route === 'remove-campaign') {
    if (relayPrincipal) return json(res, 403, { error: '中继无权访问此接口' });
    if (!canManage(req, { access, config, isRemote, interfaces: options.interfaces })) return json(res, 401, { error: 'Login required / 请先登录' });
    const data = await input(req);
    return json(res, 200, await track(removeCampaign(data.campaign)));
  }
  if (req.method === 'POST' && route === 'add-device') {
    if (relayPrincipal) return json(res, 403, { error: '中继无权访问此接口' });
    if (!access.validCookie(req.headers.cookie)) return json(res, 401, { error: 'Login required / 请先登录' });
    // Web clients copy the link only; typed codes stay on the loopback admin/CLI path.
    const grant = await admin('add-device', {});
    return json(res, 200, { url: grant.url, expiresIn: grant.expiresIn });
  }
  if (req.method === 'GET' && route === 'summary') {
    if (relayPrincipal) return json(res, 403, { error: '中继无权访问此接口' });
    const campaigns = config.campaigns.map(c => {
      try {
        const state = store.load(c.id);
        return { id: c.id, title: c.title, project: c.project, removable: [...state.items, ...state.messages].every(item => item.status === 'closed'), pending: state.items.filter(x => x.status === 'open').length };
      } catch (error) {
        options.log?.({ event: 'summary-campaign-error', campaign: c.id, error: error.message });
        return { id: c.id, title: c.title, project: c.project, error: true, removable: false, pending: 0 };
      }
    });
    const loggedIn = access.validCookie(req.headers.cookie);
    const routing = loadRouting(config.home);
    const routingSync = {
      version: routing.version,
      updatedAt: routing.updatedAt,
      peers: Object.fromEntries(Object.entries(routing.sync?.peers || {}).map(([name, peer]) => [name, {
        status: peer.status,
        at: peer.at || null,
        version: peer.version ?? null,
        unsynced: peer.status !== 'ok',
      }])),
    };
    return json(res, 200, {
      machine: config.name,
      name: config.name,
      loggedIn,
      canManage: canManage(req, { access, config, isRemote, interfaces: options.interfaces }),
      hub,
      remote: isRemote,
      peers: config.peers.map(p => typeof p === 'string' ? { name: p } : p),
      publicKey: push.publicKey,
      campaigns,
      routingSync,
    }, summaryCors(req, config, isRemote));
  }
  if (route === 'routing' && segments[2] === 'sync' && req.method === 'POST') {
    const bodyText = (await body(req)).toString('utf8');
    const before = loadRouting(config.home);
    const result = receiveGlobalSync(config.home, {
      bodyText,
      signature: req.headers['x-inbox-routing-sync'],
      privateDir: config.privateDir,
    });
    // A peer's accepted global snapshot changes this machine's routes too; wake its Campaigns once.
    if (result.accepted && result.reason === 'updated') {
      const after = loadRouting(config.home);
      await reportRoutingWrite({
        config, options,
        scope: 'global',
        before,
        after,
        actor: 'sync',
        routingVersion: after.version,
      });
    }
    return json(res, 200, result);
  }
  if (route === 'routing' && req.method === 'GET') {
    const campaignId = new URL(req.url, 'http://inbox.local').searchParams.get('campaign');
    const machine = new URL(req.url, 'http://inbox.local').searchParams.get('machine') || config.name;
    const campaignDir = campaignId ? campaignDirFor(config, store, campaignId) : null;
    return json(res, 200, routingView({ home: config.home, machine, campaignDir }));
  }
  if (route === 'routing' && req.method === 'PUT') {
    if (!canManage(req, { access, config, isRemote, interfaces: options.interfaces })) {
      return json(res, 401, { error: 'Login required / 请先登录' });
    }
    const data = await input(req);
    const layer = data.layer;
    if (layer === 'machine' && data.machine && data.machine !== config.name) {
      return json(res, 200, await forwardMachinePatch(config, {
        targetMachine: data.machine,
        patch: data.patch,
        expectedVersion: data.expectedVersion,
        cookie: req.headers.cookie,
        fetchImpl: options.fetch || fetch,
      }));
    }
    if (layer === 'campaign' && !data.campaign) {
      return json(res, 400, { error: 'campaign 无效' });
    }
    const machine = data.machine || config.name;
    const campaignDir = data.campaign ? campaignDirFor(config, store, data.campaign) : null;
    const before = loadRouting(config.home);
    const beforeCampaign = campaignDir ? loadCampaignRouting(campaignDir) : {};
    const result = applyLayerPatch(config.home, {
      layer,
      machine,
      campaignDir,
      patch: data.patch,
      expectedVersion: data.expectedVersion,
    });
    if (layer === 'global') {
      const sync = await pushGlobalToPeers(config, {
        fetchImpl: options.fetch || fetch,
        routing: result.routing || loadRouting(config.home),
      });
      result.sync = sync;
    }
    // Model/routing changes wake the Campaign orchestrators through their existing transports.
    // Delivery problems are logged inside publishRoutingChange and never fail the save.
    const afterDoc = result.routing || loadRouting(config.home);
    await reportRoutingWrite({
      config, options, req,
      scope: layer,
      campaignId: data.campaign || null,
      machine,
      before,
      after: afterDoc,
      beforeCampaign,
      afterCampaign: result.campaign,
      actor: data.changedBy,
      routingVersion: afterDoc.version,
    });
    return json(res, 200, result);
  }
  if (route === 'quota' && req.method === 'POST') {
    if (!canManage(req, { access, config, isRemote, interfaces: options.interfaces })) {
      return json(res, 401, { error: 'Login required / 请先登录' });
    }
    const data = await input(req);
    if (!Number.isInteger(data.expectedVersion)) {
      return json(res, 400, { error: '写入 routing.json 需要 expectedVersion' });
    }
    const before = loadRouting(config.home);
    const result = setQuota(config.home, {
      key: data.key,
      exhausted: data.exhausted !== false && data.action !== 'clear',
      resumeAt: data.resumeAt ?? null,
      markedBy: data.markedBy || 'owner',
      expectedVersion: data.expectedVersion,
    });
    const after = loadRouting(config.home);
    const sync = await pushGlobalToPeers(config, {
      fetchImpl: options.fetch || fetch,
      routing: after,
    });
    await reportRoutingWrite({
      config, options, req,
      scope: 'global',
      before,
      after,
      actor: data.changedBy,
      routingVersion: after.version,
    });
    return json(res, 200, { ...result, sync });
  }
  if (route === 'catalog' && req.method === 'GET') {
    const catalog = loadCatalog(config.home);
    return json(res, 200, catalog || { capturedAt: null, capabilities: null, present: false });
  }
  if (route === 'catalog' && req.method === 'POST') {
    if (!canManage(req, { access, config, isRemote, interfaces: options.interfaces })) {
      return json(res, 401, { error: 'Login required / 请先登录' });
    }
    const data = await input(req);
    const capabilities = data.capabilities || data;
    try {
      return json(res, 200, writeCatalog(config.home, capabilities, { capturedAt: data.capturedAt, campaignDirs: (config.campaigns || []).map(c => c.dir), allowMissing: data.allowMissing === true, allowOptionRemoval: data.allowOptionRemoval === true }));
    } catch (error) {
      if (error.missing) return json(res, 409, { error: error.message, missing: error.missing });
      if (error.incomplete) return json(res, 409, { error: error.message, incomplete: error.incomplete });
      throw error;
    }
  }
  if (route === 'route' && req.method === 'GET') {
    const url = new URL(req.url, 'http://inbox.local');
    const type = segments[2] || url.searchParams.get('type');
    const campaignId = url.searchParams.get('campaign');
    const machine = url.searchParams.get('machine') || config.name;
    if (!type) return json(res, 400, { error: '缺少 type' });
    const campaignDir = campaignId ? campaignDirFor(config, store, campaignId) : null;
    if (url.searchParams.get('all') === '1' || type === 'all') {
      return json(res, 200, resolveAll({ home: config.home, machine, campaignDir }));
    }
    return json(res, 200, resolveRoute({ home: config.home, machine, campaignDir, type }));
  }
  if (route === 'kanban') {
    // 只读看板：任何写方法都不接受。
    if (req.method !== 'GET') return json(res, 405, { error: '只允许 GET' }, { Allow: 'GET' });
    if (!config.campaigns.some(c => c.id === segments[2])) return json(res, 404, { error: 'Campaign 不存在' });
    return json(res, 200, await kanbanView({ config, campaignId: segments[2], run: options.kanbanGh }));
  }
  if (req.method === 'GET' && route === 'campaign') {
    if (relayPrincipal && relayPrincipal.campaign !== segments[2]) return json(res, 403, { error: '中继无权访问此 Campaign' });
    const data = store.view(segments[2]);
    return json(res, 200, { ...data, campaign: { id: data.campaign.id, title: data.campaign.title, project: data.campaign.project }, remote: isRemote, publicKey: push.publicKey, publicUrl: config.remote.publicUrl || null, lanHttpsUrl: config.lanHttpsUrl || null });
  }
  if (req.method === 'POST' && route === 'submit') {
    const data = await input(req);
    let principal = relayPrincipal;
    if (req._inboxRelayPending || (!principal && /^Bearer\s+/i.test(String(req.headers.authorization || '')))) {
      let auth;
      try {
        auth = access.authorizeRelay(req, {
          campaign: data.campaign,
          trustForwarded: isRemote,
          // Prefer server-provided matcher when present so submit matches other routes (wrong-campaign → 403).
          match: options.matchRelayToken || ((campaign, tokenId, secret) => relay.matchToken(campaign, tokenId, secret)),
        });
      } catch (error) {
        if (error.reason === 'wrong-campaign') return json(res, 403, { error: error.message, reason: error.reason });
        throw error;
      }
      if (auth.status !== 200) return json(res, auth.status, { error: auth.status === 429 ? '尝试过多，请稍后再试' : '中继认证失败' });
      principal = auth.principal;
    }
    if (principal && principal.campaign !== data.campaign) return json(res, 403, { error: '中继无权访问此 Campaign' });
    if (principal && Array.isArray(data.messages) && data.messages.length) return json(res, 403, { error: '中继不能提交留言' });
    writable(data.campaign);
    const submitOptions = principal
      ? { via: 'relay', tokenId: principal.tokenId, actor: data.actor }
      : { via: 'web', actor: data.actor };
    const batch = store.submit(data.campaign, data.items, data.messages || [], submitOptions);
    const result = await track(notify(data.campaign, batch.items, batch.messages));
    const settled = batch.items.map(id => store.load(data.campaign).items.find(item => item.id === id)).filter(Boolean);
    for (const item of settled) {
      track(Promise.resolve(relay?.emit?.('question.settled', item, { campaign: data.campaign, store })));
    }
    return json(res, 200, { ...batch, notify: result });
  }
  if (req.method === 'POST' && route === 'item') {
    const data = await input(req), campaign = segments[2], id = segments[3];
    if (relayPrincipal && relayPrincipal.campaign !== campaign) return json(res, 403, { error: '中继无权访问此 Campaign' });
    writable(campaign);
    if (data.action === 'retry') {
      const state = store.load(campaign), item = [...state.items, ...state.messages].find(x => x.id === id);
      if (!item || !['saved', 'notified'].includes(item.status)) throw new Error('此状态不能重发');
      if (relayPrincipal) {
        const tokenVia = `relay:${relayPrincipal.tokenId}`;
        if (item.answeredVia !== tokenVia) return json(res, 409, { error: '中继只能重发本令牌的答复', reason: 'answered' });
      }
      return json(res, 200, { notify: await track(notify(campaign, item.kind ? [id] : [], item.kind ? [] : [id])) });
    }
    if (data.action !== 'withdraw') throw new Error('未知操作');
    const changeOptions = relayPrincipal
      ? { via: 'relay', tokenId: relayPrincipal.tokenId, expect: data.expect, actor: data.actor }
      : { via: 'web', expect: data.expect, actor: data.actor };
    const item = store.change(campaign, id, 'withdraw', changeOptions);
    await track(notify(campaign, [id], []));
    track(Promise.resolve(relay?.emit?.('answer.withdrawn', item, { campaign, store })));
    return json(res, 200, item);
  }
  if (req.method === 'POST' && route === 'upload') {
    const campaign = store.campaign(segments[2]), itemId = segments[3];
    if (relayPrincipal && relayPrincipal.campaign !== campaign.id) return json(res, 403, { error: '中继无权访问此 Campaign' });
    if (!itemId || !/^[A-Za-z0-9_-]+$/.test(itemId)) throw new Error('图片条目 id 无效');
    if (relayPrincipal && itemId === 'messages') return json(res, 403, { error: '中继不能上传留言图片' });
    const item = store.load(campaign.id).items.find(x => x.id === itemId);
    if (itemId !== 'messages' && (!item || item.status === 'closed')) throw new Error('题目不存在或已结案');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) throw tooLarge();
    const uploadRoot = path.join(campaign.dir, 'inbox', 'uploads');
    const used = directoryBytes(uploadRoot);
    if (used >= CAMPAIGN_UPLOAD_BYTES) throw tooLarge('Campaign 上传总量已达上限');
    if (Number.isFinite(declared) && used + declared > CAMPAIGN_UPLOAD_BYTES) throw tooLarge('Campaign 上传总量已达上限');
    const bytes = await body(req, UPLOAD_MAX_BYTES), type = imageType(bytes);
    if (!type) throw new Error('只接收 PNG、JPEG、WebP、GIF、HEIC 图片');
    if (used + bytes.length > CAMPAIGN_UPLOAD_BYTES) throw tooLarge('Campaign 上传总量已达上限');
    writable(campaign.id); store.campaign(campaign.id);
    const relative = `inbox/uploads/${itemId}/${randomUUID()}.${type.extension}`, file = path.join(campaign.dir, relative);
    const root = fs.realpathSync(campaign.dir);
    // 每层创建前先核对父目录，避免递归 mkdir 沿现有符号链接在 Campaign 外建目录。
    let directory = campaign.dir;
    for (const segment of ['inbox', 'uploads', itemId]) {
      directory = path.join(directory, segment);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory);
      if (!inside(root, fs.realpathSync(directory))) throw new Error('上传目录越界');
    }
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return json(res, 200, { path: relative, reference: relative, url: `media/${encodeURIComponent(campaign.id)}/${relative}` });
  }
  if (req.method === 'GET' && route === 'push-key') {
    if (relayPrincipal) return json(res, 403, { error: '中继无权访问此接口' });
    return json(res, 200, { publicKey: push.publicKey });
  }
  if (req.method === 'POST' && route === 'subscribe') {
    if (relayPrincipal) return json(res, 403, { error: '中继无权访问此接口' });
    if (!isRemote) return json(res, 403, { error: '请在 HTTPS 远程入口订阅' });
    await push.subscribe(await input(req));
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: '接口不存在' });
}
