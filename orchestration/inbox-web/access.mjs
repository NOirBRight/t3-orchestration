import os from 'node:os';
import net from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { privateText } from './config.mjs';

/** Interface addresses in these ranges are skipped when lanTrustSubnet uses auto detection. */
export const DEFAULT_VIRTUAL_CIDRS = [
  '100.64.0.0/10',
  '169.254.0.0/16',
  '172.16.0.0/12',
  'fd7a:115c:a1e0::/48',
  'fe80::/10',
];

export function normalizeIp(ip = '') { return ip.startsWith('::ffff:') ? ip.slice(7) : ip; }
export function isLoopback(ip) { ip = normalizeIp(ip); return ip === '127.0.0.1' || ip === '::1'; }
export function isLocalhostHost(host = '') {
  const name = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}
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
export function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const [address, bitsText] = cidr.split('/');
  const version = net.isIP(normalizeIp(address).split('%')[0]);
  const bits = Number(bitsText);
  const max = version === 4 ? 32 : version === 6 ? 128 : 0;
  if (!max || !Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const bytes = ipBytes(address);
  if (!bytes) return null;
  return { bytes, bits };
}
export function inCidr(ip, cidr) {
  const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const bytes = ipBytes(ip);
  if (!parsed || !bytes || bytes.length !== parsed.bytes.length) return false;
  let remaining = parsed.bits;
  for (let i = 0; i < bytes.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 255 : (255 << (8 - take)) & 255;
    if ((bytes[i] & mask) !== (parsed.bytes[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}
function virtualInterface(address, virtualCidrs = DEFAULT_VIRTUAL_CIDRS) {
  return virtualCidrs.some(cidr => inCidr(address, cidr));
}
export function allowedLan(ip, interfaces = os.networkInterfaces(), { cidrs, virtualCidrs = DEFAULT_VIRTUAL_CIDRS } = {}) {
  if (isLoopback(ip)) return true;
  if (cidrs?.length) return cidrs.some(cidr => inCidr(ip, cidr));
  return Object.values(interfaces).flat().filter(Boolean).some(i => !i.internal && !virtualInterface(i.address, virtualCidrs) && sameSubnet(ip, i.address, i.netmask));
}
/** Rightmost X-Forwarded-For hop when the caller trusts an overwriting reverse proxy. */
export function forwardedClient(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const parts = header.split(',').map(part => part.trim()).filter(Boolean);
  return parts.length ? normalizeIp(parts[parts.length - 1]) : null;
}
export function requestSource(req, { trustForwarded = false } = {}) {
  if (trustForwarded) {
    const forwarded = forwardedClient(req.headers['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  return normalizeIp(req.socket.remoteAddress);
}
/** When the socket is loopback but a proxy set XFF, use that client for LAN checks. */
export function lanClientIp(req) {
  const remote = normalizeIp(req.socket.remoteAddress);
  if (isLoopback(remote)) {
    const forwarded = forwardedClient(req.headers['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  return remote;
}
function equal(a, b, { allowEmpty = true } = {}) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  if (!allowEmpty && x.length === 0) return false;
  return x.length === y.length && timingSafeEqual(x, y);
}
/** Cookie login, or trusted LAN when lanTrustSubnet is on (main port only). Used for remove-campaign and routing settings writes. */
export function canManage(req, { access, config, isRemote, interfaces } = {}) {
  if (access?.validCookie(req.headers.cookie)) return true;
  if (isRemote || config?.lanTrustSubnet !== true) return false;
  return allowedLan(lanClientIp(req), interfaces, { cidrs: config.lanTrustCidrs });
}
export function allowedAdmin(req, remote, token) {
  if (remote || !isLoopback(req.socket.remoteAddress) || req.headers['x-forwarded-for']) return false;
  return equal(req.headers['x-inbox-admin'], token, { allowEmpty: false });
}

/** Crockford Base32 without checksum; 8 chars ≈ 40 bits for typed device codes. */
export const DEVICE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function normalizeDeviceCode(value = '') {
  const mapped = String(value).trim().toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (mapped.length !== 8) return null;
  for (const ch of mapped) if (!DEVICE_CODE_ALPHABET.includes(ch)) return null;
  return mapped;
}
export function formatDeviceCode(code) {
  const normalized = normalizeDeviceCode(code);
  if (!normalized) return null;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}
function mintDeviceCode() {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += DEVICE_CODE_ALPHABET[bytes[i] % 32];
  return out;
}

/** Paths a relay principal may call. Campaign must match the token's campaign. */
export function relayAllowedPath(method, segments = [], { campaign } = {}) {
  const route = segments[0];
  if (method === 'GET' && route === 'health') return true;
  if (route === 'api') {
    const kind = segments[1];
    if (method === 'POST' && kind === 'submit') return true;
    if (method === 'POST' && kind === 'item' && segments[2] === campaign) return true;
    if (method === 'POST' && kind === 'upload' && segments[2] === campaign) return true;
    if (method === 'GET' && kind === 'campaign' && segments[2] === campaign) return true;
    return false;
  }
  if (method === 'GET' && route === 'media' && segments[1] === campaign) return true;
  return false;
}

export function parseBearer(header = '') {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header).trim());
  if (!match) return null;
  const token = match[1];
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { tokenId: token.slice(0, dot), secret: token.slice(dot + 1) };
}

export class Access {
  constructor(privateDir, { now = Date.now } = {}) {
    this.privateDir = privateDir; this.now = now; this.failures = new Map(); this.deviceLinks = new Map(); this.deviceCodes = new Map();
    this.token = privateText(privateDir, 'remote-token') || privateText(privateDir, 'remote-token', randomBytes(32).toString('base64url'));
    this.key = privateText(privateDir, 'cookie-key') || privateText(privateDir, 'cookie-key', randomBytes(32).toString('base64url'));
    this.adminToken = privateText(privateDir, 'admin-token') || privateText(privateDir, 'admin-token', randomBytes(32).toString('base64url'));
  }
  rotate() { this.token = privateText(this.privateDir, 'remote-token', randomBytes(32).toString('base64url')); this.key = privateText(this.privateDir, 'cookie-key', randomBytes(32).toString('base64url')); return this.token; }
  ensureAdminToken() {
    this.adminToken = privateText(this.privateDir, 'admin-token') || privateText(this.privateDir, 'admin-token', randomBytes(32).toString('base64url'));
    return this.adminToken;
  }
  pruneDeviceGrants() {
    for (const [token, entry] of this.deviceLinks) {
      if (entry.expires <= this.now()) this.consumeDeviceGrant(entry);
    }
  }
  consumeDeviceGrant(entry) {
    if (!entry) return;
    if (entry.token) this.deviceLinks.delete(entry.token);
    if (entry.code) this.deviceCodes.delete(entry.code);
  }
  deviceGrant() {
    this.pruneDeviceGrants();
    const token = randomBytes(32).toString('base64url');
    let code = mintDeviceCode();
    while (this.deviceCodes.has(code)) code = mintDeviceCode();
    const entry = { expires: this.now() + 5 * 60000, key: this.key, token, code };
    this.deviceLinks.set(token, entry);
    this.deviceCodes.set(code, entry);
    return { token, code, displayCode: formatDeviceCode(code) };
  }
  deviceLink() { return this.deviceGrant().token; }
  sign(value) { return createHmac('sha256', this.key).update(value).digest('base64url'); }
  cookie() { const payload = String(this.now() + 365 * 86400000); return `${payload}.${this.sign(payload)}`; }
  validCookie(header = '') {
    return header.split(';').map(x => x.trim()).filter(x => x.startsWith('inbox_session=')).some(value => {
      const [expires, signature] = value.slice(14).split('.');
      return Number(expires) > this.now() && equal(signature, this.sign(expires || ''));
    });
  }
  authorize(req, url, { passphrase, code, trustForwarded = false } = {}) {
    // 同步共享文件后，下一个请求即使用新口令和签名密钥。
    this.token = privateText(this.privateDir, 'remote-token');
    this.key = privateText(this.privateDir, 'cookie-key');
    const source = requestSource(req, { trustForwarded });
    for (const [address, failure] of this.failures) if (Math.max(failure.blockedUntil || 0, failure.start + 600000) <= this.now()) this.failures.delete(address);
    if (!this.token || !this.key) return { status: 401 };
    // Valid sessions skip lockouts so one bad actor cannot freeze signed-in owners behind a shared proxy.
    if (this.validCookie(req.headers.cookie)) return { status: 200 };
    const state = this.failures.get(source);
    if (state?.blockedUntil > this.now()) return { status: 429 };
    if (url.searchParams.has('device')) {
      const token = url.searchParams.get('device'), entry = this.deviceLinks.get(token);
      this.consumeDeviceGrant(entry || { token });
      return this.acceptDeviceGrant(entry, source) || { status: 401 };
    }
    if (code !== undefined && code !== null && String(code).trim() !== '') {
      const normalized = normalizeDeviceCode(code);
      const entry = normalized ? this.deviceCodes.get(normalized) : null;
      // Constant-time match on the stored code even after map lookup.
      const codeMatch = !!(entry && normalized && equal(normalized, entry.code));
      if (entry) this.consumeDeviceGrant(entry);
      return (codeMatch && this.acceptDeviceGrant(entry, source)) || this.authFailure(source, state);
    }
    // Empty body fields are absent and must not count toward lockout.
    let provided = null;
    if (passphrase !== undefined && passphrase !== null) {
      if (String(passphrase) !== '') provided = passphrase;
    } else if (url.searchParams.has('k')) {
      provided = url.searchParams.get('k');
    }
    if (provided !== null) {
      if (equal(provided, this.token)) { this.failures.delete(source); return { status: 302, cookie: this.cookie() }; }
      return this.authFailure(source, state);
    }
    return { status: 401 };
  }
  acceptDeviceGrant(entry, source) {
    if (!(entry && entry.expires > this.now() && equal(entry.key, this.key))) return null;
    this.failures.delete(source);
    return { status: 302, cookie: this.cookie() };
  }
  authFailure(source, state) {
    this.recordAuthFailure(source, state);
    return { status: this.failures.get(source)?.blockedUntil ? 429 : 401 };
  }
  /**
   * Authenticate a chat-relay bearer token for one Campaign.
   * `match` receives (campaignId, tokenId, secret) and returns principal or null.
   */
  authorizeRelay(req, { campaign, match, trustForwarded = false } = {}) {
    const source = requestSource(req, { trustForwarded });
    for (const [address, failure] of this.failures) if (Math.max(failure.blockedUntil || 0, failure.start + 600000) <= this.now()) this.failures.delete(address);
    const state = this.failures.get(source);
    if (state?.blockedUntil > this.now()) return { status: 429 };
    const parsed = parseBearer(req.headers.authorization);
    if (!parsed || typeof match !== 'function') {
      this.recordAuthFailure(source, state);
      return { status: this.failures.get(source)?.blockedUntil ? 429 : 401 };
    }
    const principal = match(campaign, parsed.tokenId, parsed.secret);
    if (!principal) {
      this.recordAuthFailure(source, state);
      return { status: this.failures.get(source)?.blockedUntil ? 429 : 401 };
    }
    this.failures.delete(source);
    return { status: 200, principal };
  }
  recordAuthFailure(source, state) {
    const entry = !state || this.now() - state.start >= 600000 ? { start: this.now(), count: 0 } : state;
    entry.count++; if (entry.count >= 5) entry.blockedUntil = this.now() + 900000;
    this.failures.set(source, entry);
  }
}
