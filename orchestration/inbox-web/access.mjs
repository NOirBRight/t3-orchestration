import os from 'node:os';
import net from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { privateText } from './config.mjs';

export function normalizeIp(ip = '') { return ip.startsWith('::ffff:') ? ip.slice(7) : ip; }
export function isLoopback(ip) { ip = normalizeIp(ip); return ip === '127.0.0.1' || ip === '::1'; }
function ipBytes(ip) {
  ip = normalizeIp(ip).split('%')[0];
  if (net.isIP(ip) === 4) return ip.split('.').map(Number);
  if (net.isIP(ip) !== 6) return null;
  const halves = ip.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.flatMap(x => [parseInt(x, 16) >> 8, parseInt(x, 16) & 255]);
}
export function sameSubnet(ip, address, mask) {
  const a = ipBytes(ip), b = ipBytes(address), m = ipBytes(mask);
  return !!a && !!b && !!m && a.length === b.length && a.length === m.length && a.every((x, i) => (x & m[i]) === (b[i] & m[i]));
}
export function allowedLan(ip, interfaces = os.networkInterfaces()) {
  return isLoopback(ip) || Object.values(interfaces).flat().filter(Boolean).some(i => !i.internal && sameSubnet(ip, i.address, i.netmask));
}
export function allowedAdmin(req, remote) { return !remote && isLoopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for']; }
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }
export class Access {
  constructor(privateDir, { now = Date.now } = {}) {
    this.privateDir = privateDir; this.now = now; this.failures = new Map(); this.deviceLinks = new Map();
    this.token = privateText(privateDir, 'remote-token') || privateText(privateDir, 'remote-token', randomBytes(32).toString('base64url'));
    this.key = privateText(privateDir, 'cookie-key') || privateText(privateDir, 'cookie-key', randomBytes(32).toString('base64url'));
  }
  rotate() { this.token = privateText(this.privateDir, 'remote-token', randomBytes(32).toString('base64url')); this.key = privateText(this.privateDir, 'cookie-key', randomBytes(32).toString('base64url')); return this.token; }
  deviceLink() {
    for (const [token, entry] of this.deviceLinks) if (entry.expires <= this.now()) this.deviceLinks.delete(token);
    const token = randomBytes(32).toString('base64url');
    this.deviceLinks.set(token, { expires: this.now() + 5 * 60000, key: this.key });
    return token;
  }
  sign(value) { return createHmac('sha256', this.key).update(value).digest('base64url'); }
  cookie() { const payload = String(this.now() + 365 * 86400000); return `${payload}.${this.sign(payload)}`; }
  validCookie(header = '') {
    return header.split(';').map(x => x.trim()).filter(x => x.startsWith('inbox_session=')).some(value => {
      const [expires, signature] = value.slice(14).split('.');
      return Number(expires) > this.now() && equal(signature, this.sign(expires || ''));
    });
  }
  authorize(req, url) {
    // 同步共享文件后，下一个请求即使用新口令和签名密钥。
    this.token = privateText(this.privateDir, 'remote-token');
    this.key = privateText(this.privateDir, 'cookie-key');
    // 没有可信代理边界，不能让调用者用 X-Forwarded-For 切换限速身份。
    const source = normalizeIp(req.socket.remoteAddress);
    for (const [address, failure] of this.failures) if (Math.max(failure.blockedUntil || 0, failure.start + 600000) <= this.now()) this.failures.delete(address);
    const state = this.failures.get(source);
    if (state?.blockedUntil > this.now()) return { status: 429 };
    if (!this.token || !this.key) return { status: 401 };
    if (url.searchParams.has('device')) {
      const token = url.searchParams.get('device'), entry = this.deviceLinks.get(token);
      this.deviceLinks.delete(token);
      if (entry && entry.expires > this.now() && equal(entry.key, this.key)) {
        this.failures.delete(source); return { status: 302, cookie: this.cookie() };
      }
      return { status: 401 };
    }
    if (url.searchParams.has('k')) {
      if (equal(url.searchParams.get('k'), this.token)) { this.failures.delete(source); return { status: 302, cookie: this.cookie() }; }
      const entry = !state || this.now() - state.start >= 600000 ? { start: this.now(), count: 0 } : state;
      entry.count++; if (entry.count >= 5) entry.blockedUntil = this.now() + 900000;
      this.failures.set(source, entry); return { status: entry.blockedUntil ? 429 : 401 };
    }
    return { status: this.validCookie(req.headers.cookie) ? 200 : 401 };
  }
}
