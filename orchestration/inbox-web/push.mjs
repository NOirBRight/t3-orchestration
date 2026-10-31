import { createECDH, createHmac, createCipheriv, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from './config.mjs';

const b64 = value => Buffer.from(value).toString('base64url');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const expand = (key, info, size) => hmac(key, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, size);

// RFC 8291 §3; privateKey and salt are injectable for the published test vector.
export function encryptPush(payload, subscription, { privateKey, salt = randomBytes(16), recordSize = 4096 } = {}) {
  const receiver = Buffer.from(subscription.keys.p256dh, 'base64url');
  const auth = Buffer.from(subscription.keys.auth, 'base64url');
  if (receiver.length !== 65 || receiver[0] !== 4 || auth.length !== 16 || salt.length !== 16) throw new Error('推送订阅密钥格式无效');
  const sender = createECDH('prime256v1');
  if (privateKey) sender.setPrivateKey(Buffer.from(privateKey, 'base64url')); else sender.generateKeys();
  const publicKey = sender.getPublicKey();
  const secret = sender.computeSecret(receiver);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, publicKey]);
  const ikm = expand(hmac(auth, secret), info, 32);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = expand(prk, 'Content-Encoding: nonce\0', 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (plain.length + 16 >= recordSize || plain.length > 3994) throw new Error('推送内容过长');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(recordSize, 16); header[20] = publicKey.length;
  return Buffer.concat([header, publicKey, ciphertext]);
}

export function generateVapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])) };
}

export function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
  const head = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const input = `${head}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(keys.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64(signature)}, k=${keys.publicKey}`;
}

const savePrivate = (file, value) => atomicJson(file, value, true);
const languageOf = value => value === 'en' ? 'en' : 'zh';
const notification = (zh, en) => ({ zh, en });

// Browser push services only: accepting arbitrary HTTPS URLs permits server-side requests to the LAN.
function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.updates.push.services.mozilla.com') || host === 'web.push.apple.com' || host.endsWith('.web.push.apple.com') || host === 'notify.windows.com' || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) throw new Error('推送订阅格式无效');
}

export class PushService {
  constructor({ privateDir, publicUrl, machine, fetchImpl = fetch, batchMs = 120000, onError = () => {}, onDelivery = () => {} }) {
    this.privateDir = privateDir; this.publicUrl = publicUrl; this.machine = machine; this.fetch = fetchImpl; this.batchMs = batchMs; this.onError = onError; this.onDelivery = onDelivery;
    mkdirSync(privateDir, { recursive: true, mode: 0o700 }); chmodSync(privateDir, 0o700);
    this.keyFile = path.join(privateDir, 'vapid.json'); this.subscriptionFile = path.join(privateDir, 'push-subscriptions.json');
    if (!existsSync(this.keyFile)) savePrivate(this.keyFile, generateVapidKeys());
    chmodSync(this.keyFile, 0o600);
    this.keys = JSON.parse(readFileSync(this.keyFile, 'utf8'));
    this.subscriptions = existsSync(this.subscriptionFile) ? JSON.parse(readFileSync(this.subscriptionFile, 'utf8')) : [];
    if (existsSync(this.subscriptionFile)) chmodSync(this.subscriptionFile, 0o600);
    this.queueFile = path.join(privateDir, 'push-queue.json');
    this.queue = existsSync(this.queueFile) ? JSON.parse(readFileSync(this.queueFile, 'utf8')) : [];
    this.problems = new Set(); this.jobs = new Set(); this.timer = null; this.stopped = false; this.flushing = null;
  }
  get publicKey() { return this.keys.publicKey; }
  start() { this.stopped = false; this.schedule(); return this; }
  schedule() { if (this.queue.length && !this.timer && !this.stopped) { this.timer = setTimeout(() => this.flush(), this.batchMs); this.timer.unref?.(); } }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; await Promise.allSettled([...this.jobs]); }
  subscribe(subscription) {
    try {
      validateEndpoint(subscription.endpoint);
      // computeSecret validates that the supplied point belongs to P-256.
      encryptPush('', subscription);
    } catch { throw new Error('推送订阅格式无效'); }
    this.subscriptions = this.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
    this.subscriptions.push({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, language: languageOf(subscription.language) });
    savePrivate(this.subscriptionFile, this.subscriptions);
    return { subscribed: true };
  }
  enqueue(item) {
    if (item.blocking) return this.dispatch({ title: notification('有挡票的问题等你决定', 'A blocking question needs your decision'), body: item.title, ...this.location(item) }, 'high', [item]);
    this.queue.push(item);
    savePrivate(this.queueFile, this.queue);
    this.schedule();
  }
  location(item) {
    const url = new URL(this.machine ? '/' : './', this.publicUrl || 'https://localhost/');
    if (this.machine) url.searchParams.set('machine', this.machine);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.searchParams.set('campaign', item.campaign); if (item.id) url.hash = item.id;
    return { url: url.href, tag: `${this.machine || ''}:${item.campaign}:${item.id || 'inbox'}` };
  }
  async flush() {
    if (this.flushing) return this.flushing;
    clearTimeout(this.timer); this.timer = null;
    const items = [...this.queue]; if (!items.length) return;
    // Keep the batch on disk until delivery bookkeeping completes. A crash after
    // sending may repeat a notification; its stable tag replaces the old one.
    const job = this.send({ title: notification(`${items.length} 条新题与验收等你处理`, `${items.length} new ${items.length === 1 ? 'question or review needs' : 'questions and reviews need'} your attention`), body: items.slice(0, 3).map(i => i.title).join(' · '), ...this.location(items[0]) }, 'normal').then(async result => {
      await this.onDelivery(items, result);
      this.queue = this.queue.filter(item => !items.includes(item));
      savePrivate(this.queueFile, this.queue);
    }).catch(() => this.onError('网页推送发送失败'));
    this.flushing = job; this.jobs.add(job);
    try { await job; } finally { this.jobs.delete(job); this.flushing = null; this.schedule(); }
  }
  problem(item) {
    const key = item.submissionKey || `${item.campaign}:${item.id}:${item.submittedAt || ''}`;
    if (this.problems.has(key)) return;
    this.problems.add(key);
    const systemBody = {
      'notify-failed': notification('通知没送到', 'Notification failed'),
      'unread-15m': notification('答复超过 15 分钟未读', 'Answer unread for over 15 minutes'),
      'relay-failed': notification('聊天中继没送到', 'Chat relay delivery failed'),
    }[item.type];
    return this.dispatch({ title: notification('Inbox 送达出了问题', 'Inbox delivery failed'), body: systemBody || item.title || notification('请打开页面查看并重发通知', 'Open Inbox to review and resend the notification'), ...this.location(item) }, 'high');
  }
  dispatch(payload, urgency = 'normal', items = []) {
    const job = this.send(payload, urgency).then(result => this.onDelivery(items, result)).catch(() => this.onError('网页推送发送失败'));
    this.jobs.add(job); job.finally(() => this.jobs.delete(job)); return job;
  }
  async send(payload, urgency) {
    const result = { sent: false, at: new Date().toISOString(), endpoints: 0 };
    if (!this.publicUrl) return result;
    const expired = new Set();
    await Promise.all(this.subscriptions.map(async subscription => {
      try {
        validateEndpoint(subscription.endpoint);
        const language = languageOf(subscription.language);
        const localized = { ...payload, language, title: typeof payload.title === 'object' ? payload.title[language] : payload.title, body: typeof payload.body === 'object' ? payload.body[language] : payload.body };
        const response = await this.fetch(subscription.endpoint, {
          method: 'POST', headers: { Authorization: vapidAuthorization(subscription.endpoint, this.keys, new URL(this.publicUrl).origin), TTL: '86400', Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
          body: encryptPush(JSON.stringify(localized), subscription), signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        if (response.ok) result.endpoints++;
        if (response.status === 404 || response.status === 410) expired.add(subscription.endpoint);
        else if (!response.ok) this.onError(`网页推送失败（HTTP ${response.status}）`);
        await response.body?.cancel();
      } catch { this.onError('网页推送发送失败'); }
    }));
    result.sent = result.endpoints > 0;
    if (expired.size) { this.subscriptions = this.subscriptions.filter(s => !expired.has(s.endpoint)); savePrivate(this.subscriptionFile, this.subscriptions); }
    return result;
  }
}
