import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export function atomicJson(file, value, privateFile = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: privateFile ? 0o700 : 0o755 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: privateFile ? 0o600 : 0o644 });
  fs.renameSync(temporary, file);
  if (privateFile) fs.chmodSync(file, 0o600);
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`无法读取 ${path.basename(file)}`); }
}
export function loadConfig({ home = process.env.INBOX_HOME || os.homedir() } = {}) {
  const rootDir = path.join(home, '.agents', 'orchestration');
  const privateDir = path.join(rootDir, 'private');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateDir, 0o700);
  const config = { name: os.hostname(), port: 8780, remotePort: 8781, lanTrustSubnet: false, remote: { type: 'none' }, peers: [], campaigns: [], ...readJson(path.join(rootDir, 'machine.json'), {}) };
  if (typeof config.lanTrustSubnet !== 'boolean') throw new Error('lanTrustSubnet 必须是布尔值');
  for (const key of ['port', 'remotePort']) if (!Number.isInteger(config[key]) || config[key] < 0 || config[key] > 65535) throw new Error(`${key} 必须是端口号`);
  if (!Array.isArray(config.campaigns) || !Array.isArray(config.peers)) throw new Error('campaigns 和 peers 必须是数组');
  if (!config.remote || !['none', 'tailscale', 'cloudflared', 'url', 'ssh-reverse'].includes(config.remote.type)) throw new Error('remote.type must be none, tailscale, cloudflared, url, or ssh-reverse');
  if (config.remote.type !== 'none') {
    let publicUrl;
    try { publicUrl = new URL(config.remote.publicUrl); } catch { throw new Error('remote.publicUrl must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('remote.publicUrl must be an absolute HTTP(S) URL');
  }
  return { ...config, rootDir, privateDir };
}
export function saveConfig(config) {
  const { rootDir, privateDir, ...data } = config;
  atomicJson(path.join(rootDir, 'machine.json'), data);
}
export function privateText(privateDir, name, value) {
  const file = path.join(privateDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (value !== undefined) { fs.writeFileSync(file, value, { mode: 0o600 }); fs.chmodSync(file, 0o600); }
  try { fs.chmodSync(file, 0o600); return fs.readFileSync(file, 'utf8').trim(); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('无法读取私有配置'); }
}
