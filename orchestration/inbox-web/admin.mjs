import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveCampaigns, privateText } from './config.mjs';

export function createAdmin({ config, store, access, push, relay, writable, locate, unregister, health }) {
  return async function admin(command, data) {
    if (command === 'health' || command === 'status') return health();
    if (command === 'register') {
      if (typeof data.dir !== 'string') throw new Error('dir 必须是目录');
      const dir = fs.realpathSync(data.dir), state = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
      const id = data.id || state.id || path.basename(dir);
      writable(id);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Campaign id 只能含字母、数字、下划线和短横线');
      const campaign = { id, title: data.title || state.campaign || state.title || id, project: data.project || state.project || '', dir };
      const existing = config.campaigns.findIndex(c => c.id === id);
      if (existing >= 0) config.campaigns[existing] = campaign; else config.campaigns.push(campaign);
      saveCampaigns(config); return campaign;
    }
    if (command === 'unregister') { writable(data.campaign || data.id); return unregister(data.campaign || data.id); }
    if (command === 'add-device') {
      const grant = access.deviceGrant();
      const url = new URL(config.remote.publicUrl || config.lanHttpsUrl || `http://${os.hostname()}:${health().port}/`);
      url.searchParams.set('device', grant.token);
      return { url: url.href, code: grant.displayCode, expiresIn: 300 };
    }
    if (command === 'rotate-token') {
      const token = access.rotate();
      const url = new URL('/', config.remote.publicUrl || config.lanHttpsUrl || `http://${os.hostname()}:${health().port}/`);
      url.searchParams.set('k', token);
      return { url: url.href, configured: true };
    }
    if (command === 'set-webhook') {
      writable(data.campaign);
      store.campaign(data.campaign);
      try { const url = new URL(data.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw new Error('webhook 必须是 HTTP(S) 地址'); }
      privateText(config.privateDir, `webhooks/${data.campaign}.url`, data.url); return { ok: true };
    }
    if (command === 'ask') {
      writable(data.campaign);
      const item = store.ask(data.campaign, data.item);
      await push.enqueue({ campaign: data.campaign, id: item.id, title: item.title, blocking: item.blocking });
      const event = item.replaces ? 'question.revised' : 'question.opened';
      // Fire-and-forget serial queue inside RelayService; failures recorded on the item.
      relay?.emit?.(event, item, { campaign: data.campaign, store });
      if (item.replaces) {
        const original = store.load(data.campaign).items.find(entry => entry.id === item.replaces);
        if (original) relay?.emit?.('question.settled', original, { campaign: data.campaign, store });
      }
      return item;
    }
    if (command === 'pending') return store.pending(data.campaign);
    if (['ack', 'forward', 'close'].includes(command)) {
      const campaign = locate(data);
      writable(campaign);
      const item = store.change(campaign, data.id, command, data);
      if (command === 'close' && item.kind) {
        relay?.emit?.('question.settled', item, { campaign, store });
      }
      return item;
    }
    if (command === 'relay-set') {
      writable(data.campaign);
      store.campaign(data.campaign);
      if (!relay) throw new Error('中继服务不可用');
      return relay.setConfig(data.campaign, {
        bridgeUrl: data.bridgeUrl || data.url,
        language: data.language,
        events: data.events,
        mediaBase: data.mediaBase,
        maxTextChars: data.maxTextChars,
        enabled: data.enabled,
      });
    }
    if (command === 'relay-status') {
      store.campaign(data.campaign);
      if (!relay) return { configured: false, enabled: false };
      const status = relay.status(data.campaign);
      const recent = store.load(data.campaign).items
        .filter(item => item.relay)
        .slice(-5)
        .map(item => ({ id: item.id, relay: item.relay }));
      return { ...status, recent };
    }
    if (command === 'relay-revoke') {
      writable(data.campaign);
      store.campaign(data.campaign);
      if (!relay) throw new Error('中继服务不可用');
      return relay.revoke(data.campaign);
    }
    if (command === 'relay-resend') {
      writable(data.campaign);
      store.campaign(data.campaign);
      if (!relay) throw new Error('中继服务不可用');
      if (!data.id) throw new Error('relay-resend 需要题号');
      return relay.resend(data.campaign, data.id, { store });
    }
    throw new Error('未知管理命令');
  };
}
