import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { privateText } from './config.mjs';
import { acceptSyncedGlobal, loadRouting, persistableGlobal, saveRouting } from './routing.mjs';

export function syncSignature(key, version, updatedAt, bodyText) {
  const digest = createHash('sha256').update(bodyText).digest('hex');
  return createHmac('sha256', key).update(`${version}\n${updatedAt || ''}\n${digest}`).digest('base64url');
}

export function verifySyncSignature(key, version, updatedAt, bodyText, signature) {
  if (!key || !signature) return false;
  const expected = Buffer.from(syncSignature(key, version, updatedAt, bodyText));
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function peerBase(peer) {
  if (typeof peer === 'string') return null;
  return peer.lanUrl || peer.publicUrl || null;
}

export async function pushGlobalToPeers(config, {
  fetchImpl = fetch,
  privateDir = config.privateDir,
  routing = loadRouting(config.home),
} = {}) {
  const key = privateText(privateDir, 'cookie-key');
  if (!key) throw new Error('缺少 cookie-key，无法同步路由');
  const payload = {
    version: routing.version,
    updatedAt: routing.updatedAt,
    global: persistableGlobal(routing.global),
  };
  const bodyText = JSON.stringify(payload);
  const signature = syncSignature(key, payload.version, payload.updatedAt, bodyText);
  const peers = {};
  await Promise.all((config.peers || []).map(async peer => {
    const name = typeof peer === 'string' ? peer : peer.name;
    if (!name || name === config.name) return;
    const base = peerBase(peer);
    const at = new Date().toISOString();
    if (!base) {
      peers[name] = { status: 'unreachable', at, version: null, error: 'missing-url' };
      return;
    }
    try {
      const url = new URL('api/routing/sync', base.endsWith('/') ? base : `${base}/`);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Inbox-Routing-Sync': signature,
        },
        body: bodyText,
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      let result = null;
      try { result = await response.json(); } catch { result = null; }
      if (!response.ok) {
        peers[name] = { status: 'unreachable', at, version: result?.version ?? null, error: result?.error || `http-${response.status}` };
        return;
      }
      peers[name] = {
        status: result?.accepted === false ? 'rejected' : 'ok',
        at,
        version: result?.version ?? payload.version,
        reason: result?.reason || null,
      };
    } catch (error) {
      peers[name] = { status: 'unreachable', at, version: null, error: error.message };
    }
  }));
  routing.sync = { peers: { ...(routing.sync?.peers || {}), ...peers } };
  saveRouting(config.home, routing);
  return { version: routing.version, peers };
}

export function receiveGlobalSync(home, {
  bodyText,
  signature,
  privateDir,
}) {
  const key = privateText(privateDir, 'cookie-key');
  let payload;
  try { payload = JSON.parse(bodyText); } catch { throw Object.assign(new Error('同步负载无效'), { status: 400 }); }
  if (!verifySyncSignature(key, payload.version, payload.updatedAt, bodyText, signature)) {
    const error = new Error('同步签名无效');
    error.status = 403;
    throw error;
  }
  return acceptSyncedGlobal(home, payload);
}

export async function forwardMachinePatch(config, {
  targetMachine,
  patch,
  expectedVersion,
  cookie,
  fetchImpl = fetch,
}) {
  const peer = (config.peers || []).find(item => (typeof item === 'string' ? item : item.name) === targetMachine);
  if (!peer || typeof peer === 'string' || !peerBase(peer)) {
    const error = new Error(`找不到机器 ${targetMachine} 的同步地址`);
    error.status = 404;
    throw error;
  }
  const base = peerBase(peer);
  const url = new URL('api/routing', base.endsWith('/') ? base : `${base}/`);
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      Origin: url.origin,
    },
    body: JSON.stringify({
      layer: 'machine',
      machine: targetMachine,
      expectedVersion,
      patch,
    }),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  let result;
  try { result = await response.json(); } catch { result = { error: 'invalid peer response' }; }
  if (!response.ok) {
    const error = new Error(result.error || '转发机器层失败');
    error.status = response.status;
    throw error;
  }
  return result;
}
