import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const CAMPAIGN_UPLOAD_BYTES = 500 * 1024 * 1024;
export const mime = { '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.mp4': 'video/mp4', '.webm': 'video/webm' };
// same-origin keeps referrer/Origin on first-party form POSTs; still strips them on cross-site navigations.
export const SITE_HEADERS = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SITE_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

export function tooLarge(message = '文件超过 20MB 或请求过大') {
  const error = new Error(message);
  error.status = 413;
  return error;
}

export async function body(req, max = 1024 * 1024) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > max) throw tooLarge(); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function directoryBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

export async function input(req) {
  try { return JSON.parse((await body(req)).toString('utf8')); }
  catch (error) { if (error.status) throw error; throw new Error('请求必须是 JSON'); }
}

function formCredentials(raw) {
  const params = new URLSearchParams(raw);
  return { passphrase: params.get('k') ?? '', code: params.get('code') ?? '' };
}

export async function loginCredentials(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const raw = (await body(req, 64 * 1024)).toString('utf8');
  if (type === 'application/json' || (type !== 'application/x-www-form-urlencoded' && raw.trim().startsWith('{'))) {
    try {
      const parsed = JSON.parse(raw);
      return { passphrase: String(parsed.k ?? ''), code: String(parsed.code ?? '') };
    } catch { throw new Error('请求必须是 JSON'); }
  }
  return formCredentials(raw);
}

export async function loginPassphrase(req) {
  return (await loginCredentials(req)).passphrase;
}

export function peerOrigins(config) {
  const origins = new Set();
  for (const peer of config.peers) {
    if (typeof peer === 'string') continue;
    for (const key of ['lanUrl', 'publicUrl']) {
      if (!peer[key]) continue;
      try { origins.add(new URL(peer[key]).origin); } catch { /* ignore invalid peer URLs */ }
    }
  }
  return origins;
}

export function summaryCors(req, config, isRemote) {
  if (isRemote || config.lanTrustSubnet !== true) return {};
  const origin = req.headers.origin;
  if (!origin || !peerOrigins(config).has(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

export function sendFile(req, res, file, status = 200, extra = {}) {
  const stat = fs.statSync(file), type = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...SITE_HEADERS, ...extra };
  const streamFile = (start, end) => {
    if (req.method === 'HEAD') { res.end(); return; }
    const source = fs.createReadStream(file, start === undefined ? undefined : { start, end });
    const abort = () => { source.destroy(); };
    req.once('aborted', abort);
    res.once('close', abort);
    pipeline(source, res).catch(() => { if (!res.writableEnded) res.destroy(); }).finally(() => {
      req.off('aborted', abort);
      res.off('close', abort);
    });
  };
  if (req.headers.range && status === 200) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    let start = match?.[1] ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : stat.size - 1;
    if (match && !match[1] && match[2]) { start = Math.max(0, stat.size - Number(match[2])); end = stat.size - 1; }
    if (match && Number.isFinite(end)) end = Math.min(end, stat.size - 1);
    if (!match || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size || stat.size === 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, ...SITE_HEADERS }); res.end(); return;
    }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
    streamFile(start, end); return;
  }
  res.writeHead(status, headers); streamFile();
}
