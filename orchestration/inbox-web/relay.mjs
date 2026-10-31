import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicJson, readJson } from './config.mjs';

const DEFAULT_EVENTS = ['question.opened', 'question.revised', 'answer.withdrawn', 'question.settled'];
const RETRY_DELAYS_MS = [0, 30_000, 300_000];

export function relayConfigPath(privateDir, campaignId) {
  return path.join(privateDir, 'relays', `${campaignId}.json`);
}

export function hashRelayToken(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

export function generateRelaySecrets() {
  const signingSecret = randomBytes(32).toString('base64url');
  const tokenId = `r${randomBytes(3).toString('hex')}`;
  const inboundToken = randomBytes(32).toString('base64url');
  return {
    signingSecret,
    tokenId,
    inboundToken,
    inboundTokenHash: hashRelayToken(inboundToken),
  };
}

export function signRelayBody(signingSecret, timestamp, body) {
  return createHmac('sha256', signingSecret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyRelaySignature(signingSecret, timestamp, body, signatureHeader) {
  const expected = `sha256=${signRelayBody(signingSecret, timestamp, body)}`;
  const provided = String(signatureHeader || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function languageOf(value) {
  return value === 'en' ? 'en' : 'zh';
}

function truncate(text, max) {
  const value = String(text || '');
  if (!Number.isInteger(max) || max <= 0 || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function optionLine(option, index, language) {
  const mark = option.recommended
    ? (language === 'en' ? ' (recommended)' : '（推荐）')
    : '';
  const consequence = option.consequence ? ` — ${option.consequence}` : '';
  return `${index + 1}. ${option.label || option.key}${mark}${consequence}`;
}

export function renderRelayText(item, { language = 'zh', maxTextChars = 1500, pageUrl = '' } = {}) {
  const lines = [];
  const title = item.title || item.id;
  lines.push(title);
  if (item.ticket != null && item.ticket !== '') lines.push(language === 'en' ? `Ticket: ${item.ticket}` : `票：${item.ticket}`);
  if (item.askerLabel) lines.push(language === 'en' ? `From: ${item.askerLabel}` : `来自：${item.askerLabel}`);
  for (const paragraph of item.background || []) {
    if (paragraph) lines.push(paragraph);
  }
  if (item.kind === 'accept') {
    lines.push(language === 'en'
      ? 'Reply with pass or rework. Rework requires an explanation.'
      : '请选择通过 / 返修（返修必须写说明）。');
  } else {
    for (const [index, option] of (item.options || []).entries()) {
      lines.push(optionLine(option, index, language));
    }
  }
  if (item.recommendation) {
    lines.push(language === 'en' ? `Recommendation: ${item.recommendation}` : `推荐：${item.recommendation}`);
  }
  if (pageUrl) {
    lines.push(language === 'en' ? `Open in Inbox: ${pageUrl}` : `在 Inbox 打开：${pageUrl}`);
  }
  return truncate(lines.filter(Boolean).join('\n\n'), maxTextChars);
}

function mediaBaseUrl(config, mediaBase) {
  const mode = mediaBase || 'lan';
  if (mode === 'remote' && config.remote?.publicUrl) {
    return String(config.remote.publicUrl).replace(/\/?$/, '');
  }
  if (mode === 'loopback') {
    const port = config.port || 8780;
    return `http://127.0.0.1:${port}`;
  }
  const port = config.port || 8780;
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (net.isIP(entry.address) === 4) return `http://${entry.address}:${port}`;
    }
  }
  return `http://127.0.0.1:${port}`;
}

function pageLink(config, campaignId, itemId, mediaBase) {
  const base = mediaBaseUrl(config, mediaBase);
  const url = new URL('/', base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('campaign', campaignId);
  if (itemId) url.hash = itemId;
  return url.href;
}

function mediaEntries(item, campaignId, config, mediaBase) {
  const base = mediaBaseUrl(config, mediaBase);
  return (item.media || []).map(media => {
    const relative = String(media.path || '').replace(/\\/g, '/');
    let bytes;
    try {
      const campaign = config.campaigns?.find(c => c.id === campaignId);
      if (campaign?.dir) bytes = fs.statSync(path.join(campaign.dir, relative)).size;
    } catch { /* size is optional */ }
    const ext = path.extname(relative).toLowerCase();
    const mime = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
    }[ext] || 'application/octet-stream';
    return {
      path: relative,
      caption: media.caption || '',
      mime,
      bytes: bytes ?? null,
      url: `${base}/media/${encodeURIComponent(campaignId)}/${relative.split('/').map(encodeURIComponent).join('/')}`,
    };
  });
}

function questionPayload(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ticket: item.ticket,
    askerLabel: item.askerLabel,
    blocking: !!item.blocking,
    multi: !!item.multi,
    replaces: item.replaces || null,
    status: item.status,
    submissionId: item.submissionId || null,
    background: item.background || [],
    options: item.kind === 'decide' ? (item.options || []) : undefined,
    recommendation: item.recommendation || '',
  };
}

export function buildRelayEvent({ event, item, campaignId, config, relayConfig, eventId, at }) {
  const language = languageOf(relayConfig.language);
  const page = pageLink(config, campaignId, item.id, relayConfig.mediaBase);
  const body = {
    schema: 'inbox-relay/1',
    eventId: eventId || randomUUID().replace(/-/g, ''),
    event,
    at: at || new Date().toISOString(),
    machine: config.name,
    campaign: campaignId,
    question: questionPayload(item),
    text: renderRelayText(item, {
      language,
      maxTextChars: relayConfig.maxTextChars ?? 1500,
      pageUrl: page,
    }),
    media: mediaEntries(item, campaignId, config, relayConfig.mediaBase),
    links: { page },
    answerWith: {
      submit: '/api/submit',
      item: `/api/item/${encodeURIComponent(campaignId)}/${encodeURIComponent(item.id)}`,
      upload: `/api/upload/${encodeURIComponent(campaignId)}/${encodeURIComponent(item.id)}`,
    },
  };
  if (event === 'question.settled') {
    body.settled = {
      via: item.answeredVia || (item.answeredBy === 'orchestrator' ? 'orchestrator' : item.replacedBy ? 'replaced' : 'web'),
      status: item.status,
      replacedBy: item.replacedBy || null,
      submissionId: item.submissionId || null,
    };
  }
  return body;
}

function normalizeRelayConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    enabled: raw.enabled === true,
    bridgeUrl: typeof raw.bridgeUrl === 'string' ? raw.bridgeUrl : '',
    signingSecret: typeof raw.signingSecret === 'string' ? raw.signingSecret : '',
    inboundTokenHash: typeof raw.inboundTokenHash === 'string' ? raw.inboundTokenHash : '',
    tokenId: typeof raw.tokenId === 'string' ? raw.tokenId : 'r1',
    language: languageOf(raw.language),
    events: Array.isArray(raw.events) && raw.events.length ? raw.events.map(String) : [...DEFAULT_EVENTS],
    mediaBase: ['lan', 'remote', 'loopback'].includes(raw.mediaBase) ? raw.mediaBase : 'lan',
    maxTextChars: Number.isInteger(raw.maxTextChars) && raw.maxTextChars > 0 ? raw.maxTextChars : 1500,
  };
}

export class RelayService {
  constructor({
    privateDir,
    config,
    fetchImpl = fetch,
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    onProblem = async () => {},
    log = () => {},
  } = {}) {
    this.privateDir = privateDir;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.onProblem = onProblem;
    this.log = log;
    this.cache = new Map();
    this.queues = new Map();
    this.jobs = new Set();
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    return Promise.allSettled([...this.jobs]);
  }

  readConfig(campaignId, { force = false } = {}) {
    const file = relayConfigPath(this.privateDir, campaignId);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (error) {
      if (error.code === 'ENOENT') {
        this.cache.delete(campaignId);
        return null;
      }
      throw error;
    }
    const cached = this.cache.get(campaignId);
    if (!force && cached && cached.mtimeMs === mtimeMs) return cached.value;
    const value = normalizeRelayConfig(readJson(file, null));
    this.cache.set(campaignId, { mtimeMs, value });
    return value;
  }

  status(campaignId) {
    const cfg = this.readConfig(campaignId);
    if (!cfg) return { configured: false, enabled: false };
    return {
      configured: true,
      enabled: cfg.enabled === true && !!cfg.bridgeUrl && !!cfg.signingSecret,
      tokenId: cfg.tokenId || null,
      events: cfg.events,
      language: cfg.language,
      mediaBase: cfg.mediaBase,
    };
  }

  setConfig(campaignId, { bridgeUrl, language, events, mediaBase, maxTextChars, enabled = true } = {}) {
    try {
      const url = new URL(bridgeUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error('bridgeUrl 必须是 HTTP(S) 地址');
    }
    const secrets = generateRelaySecrets();
    const file = relayConfigPath(this.privateDir, campaignId);
    const value = {
      enabled: enabled !== false,
      bridgeUrl,
      signingSecret: secrets.signingSecret,
      inboundTokenHash: secrets.inboundTokenHash,
      tokenId: secrets.tokenId,
      language: languageOf(language),
      events: Array.isArray(events) && events.length ? events.map(String) : [...DEFAULT_EVENTS],
      mediaBase: ['lan', 'remote', 'loopback'].includes(mediaBase) ? mediaBase : 'lan',
      maxTextChars: Number.isInteger(maxTextChars) && maxTextChars > 0 ? maxTextChars : 1500,
    };
    atomicJson(file, value, true);
    this.cache.delete(campaignId);
    return {
      ok: true,
      tokenId: secrets.tokenId,
      inboundToken: secrets.inboundToken,
      signingSecret: secrets.signingSecret,
      enabled: value.enabled,
    };
  }

  revoke(campaignId) {
    const file = relayConfigPath(this.privateDir, campaignId);
    try { fs.unlinkSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.cache.delete(campaignId);
    return { ok: true };
  }

  matchToken(campaignId, tokenId, secret) {
    const cfg = this.readConfig(campaignId);
    if (!cfg?.enabled || !cfg.inboundTokenHash || !cfg.tokenId) return null;
    if (tokenId !== cfg.tokenId) return null;
    const expected = Buffer.from(cfg.inboundTokenHash, 'hex');
    const actual = Buffer.from(hashRelayToken(secret), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { principal: 'relay', campaign: campaignId, tokenId: cfg.tokenId };
  }

  emit(event, item, context = {}) {
    if (this.stopped) return Promise.resolve({ skipped: true, reason: 'stopped' });
    const campaignId = context.campaign;
    if (!campaignId || !item) return Promise.resolve({ skipped: true, reason: 'missing' });
    const cfg = this.readConfig(campaignId);
    if (!cfg?.enabled || !cfg.bridgeUrl || !cfg.signingSecret) {
      return Promise.resolve({ skipped: true, reason: 'disabled' });
    }
    if (!cfg.events.includes(event)) {
      return Promise.resolve({ skipped: true, reason: 'event-filtered' });
    }
    const previous = this.queues.get(campaignId) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.deliver(event, item, context, cfg));
    this.queues.set(campaignId, job);
    this.jobs.add(job);
    job.finally(() => {
      this.jobs.delete(job);
      if (this.queues.get(campaignId) === job) this.queues.delete(campaignId);
    }).catch(() => {});
    return job;
  }

  async deliver(event, item, context, cfg, { attempts = RETRY_DELAYS_MS.length, record = true } = {}) {
    const campaignId = context.campaign;
    const payload = buildRelayEvent({
      event,
      item,
      campaignId,
      config: this.config,
      relayConfig: cfg,
    });
    const body = JSON.stringify(payload);
    let lastError = 'failed';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await this.sleep(RETRY_DELAYS_MS[attempt] || 0);
      if (this.stopped) return { skipped: true, reason: 'stopped' };
      const timestamp = String(Math.floor(this.now() / 1000));
      const signature = `sha256=${signRelayBody(cfg.signingSecret, timestamp, body)}`;
      try {
        const response = await this.fetch(cfg.bridgeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'Orchestration-Inbox/1.0',
            'X-Inbox-Relay-Signature': signature,
            'X-Inbox-Relay-Timestamp': timestamp,
            'X-Inbox-Relay-Id': payload.eventId,
          },
          body,
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        await response.body?.cancel?.();
        if (response.ok) {
          const result = { state: 'accepted', at: new Date(this.now()).toISOString(), event, attempts: attempt + 1, eventId: payload.eventId };
          if (record && context.store) context.store.relayResult(campaignId, item.id, result);
          this.log({ event: 'relay', campaign: campaignId, result: 'accepted' });
          return result;
        }
        lastError = `http-${response.status}`;
      } catch {
        lastError = 'network';
      }
    }
    const result = { state: 'failed', at: new Date(this.now()).toISOString(), event, attempts, eventId: payload.eventId, error: lastError };
    if (record && context.store) context.store.relayResult(campaignId, item.id, result);
    this.log({ event: 'relay', campaign: campaignId, result: 'failed' });
    if (record) {
      await this.onProblem({
        campaign: campaignId,
        id: item.id,
        type: 'relay-failed',
        title: '聊天中继没送到',
        submissionKey: `relay-failed:${campaignId}:${item.id}`,
      });
    }
    return result;
  }

  async resend(campaignId, itemId, { store } = {}) {
    if (!store) throw new Error('resend 需要 store');
    const cfg = this.readConfig(campaignId, { force: true });
    if (!cfg?.enabled || !cfg.bridgeUrl || !cfg.signingSecret) throw new Error('中继未配置或未启用');
    const data = store.load(campaignId);
    const item = data.items.find(x => x.id === itemId);
    if (!item) throw new Error('条目不存在');
    let event = 'question.opened';
    if (item.replaces) event = 'question.revised';
    if (item.status === 'closed' || (item.status !== 'open' && item.answer)) event = 'question.settled';
    if (item.withdrawalPending || item.times?.withdrawn) {
      // Prefer settled/opened based on current state; withdrawn only when open after withdraw.
      if (item.status === 'open' && !item.answer) event = item.replaces ? 'question.revised' : 'question.opened';
    }
    return this.deliver(event, item, { campaign: campaignId, store }, cfg, { attempts: 1, record: true });
  }
}
