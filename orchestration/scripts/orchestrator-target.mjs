import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicJson, readJson } from '../inbox-web/config.mjs';
import { assertReportTicketTitle } from './ticket-ref.mjs';

/** Reject reports whose timestamp skew exceeds this many seconds (send and verify). */
export const REPORT_TIMESTAMP_SKEW_SEC = 300;

export function loadCampaignMeta(campaignDir) {
  const file = path.join(campaignDir, 'campaign.json');
  const data = readJson(file, null);
  if (!data || typeof data !== 'object') throw new Error('campaign.json 不可读');
  const kind = data.orchestratorKind === 'external' ? 'external' : 't3-thread';
  if (kind === 't3-thread') {
    return {
      kind,
      threadId: typeof data.orchestrator === 'string' ? data.orchestrator : null,
      ref: null,
    };
  }
  const ref = typeof data.orchestratorRef === 'string' ? data.orchestratorRef.trim() : '';
  if (!ref || !/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error('external 模式需要合法 orchestratorRef');
  if (data.orchestrator && typeof data.orchestrator === 'string' && data.orchestrator.includes('://')) {
    throw new Error('campaign.json 不得存放 endpoint URL');
  }
  return { kind, threadId: null, ref };
}

export function privateOrchestratorPath(home, ref) {
  return path.join(home, '.agents', 'orchestration', 'private', 'orchestrators', `${ref}.json`);
}

export function seenStorePath(home, ref) {
  return path.join(home, '.agents', 'orchestration', 'private', 'orchestrators', `${ref}.seen.json`);
}

export function loadPrivateOrchestrator(home, ref) {
  const file = privateOrchestratorPath(home, ref);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('外部编排私有配置不存在');
    throw new Error('无法读取外部编排私有配置');
  }
  if (!raw || raw.type !== 'webhook' || typeof raw.url !== 'string' || typeof raw.signingSecret !== 'string') {
    throw new Error('外部编排私有配置无效');
  }
  if (raw.queueOnly !== true) throw new Error('外部编排只允许 queueOnly: true');
  try {
    const url = new URL(raw.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('外部编排 URL 无效');
  }
  return { url: raw.url, signingSecret: raw.signingSecret, queueOnly: true };
}

/** Canonical signed material: timestamp.requestId.body (UTF-8). */
export function reportSignedMaterial(timestamp, requestId, body) {
  return `${String(timestamp)}.${String(requestId)}.${String(body)}`;
}

export function signReport(secret, timestamp, requestId, body) {
  return createHmac('sha256', secret).update(reportSignedMaterial(timestamp, requestId, body)).digest('hex');
}

export function verifyReportSignature(secret, timestamp, requestId, body, header) {
  const expected = `sha256=${signReport(secret, timestamp, requestId, body)}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertPublicReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('报告必须是对象');
  if (report.schema !== 'orch-report/1') throw new Error('schema 必须是 orch-report/1');
  for (const field of ['campaign', 'summary']) {
    if (typeof report[field] !== 'string' || !report[field].trim()) throw new Error(`${field} 必须是非空字符串`);
  }
  // Ticket mentions must carry a non-empty title (DISPATCH.md id：short title).
  assertReportTicketTitle(report);
  const text = JSON.stringify(report);
  if (/Authorization|signingSecret|inboundToken|webhooks\//i.test(text)) {
    throw new Error('报告疑似含秘密字段');
  }
  return report;
}

function normalizeHeaders(headers = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    map.set(String(key).toLowerCase(), Array.isArray(value) ? String(value[0]) : String(value));
  }
  return {
    signature: map.get('x-orch-signature') || '',
    timestamp: map.get('x-orch-timestamp') || '',
    id: map.get('x-orch-id') || '',
    queue: map.get('x-orch-queue') || '',
  };
}

function pruneSeen(entries, nowSec, skewSec) {
  const cutoff = nowSec - skewSec * 2;
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    const ts = Number(entry?.ts);
    return entry?.id && Number.isFinite(ts) && ts >= cutoff;
  });
}

export function claimRequestId(home, ref, requestId, timestampSec, { now = Date.now, skewSec = REPORT_TIMESTAMP_SKEW_SEC } = {}) {
  const file = seenStorePath(home, ref);
  const nowSec = Math.floor(now() / 1000);
  let data = { ids: [] };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取重放记录');
  }
  const ids = pruneSeen(data.ids, nowSec, skewSec);
  if (ids.some(entry => entry.id === requestId)) return false;
  ids.push({ id: requestId, ts: timestampSec });
  atomicJson(file, { ids }, true);
  return true;
}

/**
 * Verify an inbound external report. Never throws secrets; returns { ok, reason? }.
 * On success, records request id for replay rejection.
 */
export function verifyInboundReport({
  home = process.env.INBOX_HOME || os.homedir(),
  campaignDir,
  bodyText,
  headers,
  now = Date.now,
  skewSec = REPORT_TIMESTAMP_SKEW_SEC,
  recordReplay = true,
} = {}) {
  try {
    const meta = loadCampaignMeta(campaignDir);
    if (meta.kind !== 'external') return { ok: false, reason: 'not-external' };
    const privateCfg = loadPrivateOrchestrator(home, meta.ref);
    const hdr = normalizeHeaders(headers);
    if (!hdr.signature || !hdr.timestamp || !hdr.id) return { ok: false, reason: 'missing-headers' };
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(hdr.id)) return { ok: false, reason: 'bad-id' };
    const ts = Number(hdr.timestamp);
    if (!Number.isFinite(ts) || !/^\d+$/.test(hdr.timestamp)) return { ok: false, reason: 'bad-timestamp' };
    const nowSec = Math.floor(now() / 1000);
    if (Math.abs(nowSec - ts) > skewSec) return { ok: false, reason: 'expired' };
    const body = typeof bodyText === 'string' ? bodyText : String(bodyText ?? '');
    if (!verifyReportSignature(privateCfg.signingSecret, hdr.timestamp, hdr.id, body, hdr.signature)) {
      return { ok: false, reason: 'bad-signature' };
    }
    try {
      assertPublicReport(JSON.parse(body));
    } catch {
      return { ok: false, reason: 'bad-body' };
    }
    if (recordReplay && !claimRequestId(home, meta.ref, hdr.id, ts, { now, skewSec })) {
      return { ok: false, reason: 'replay' };
    }
    return { ok: true };
  } catch {
    // Never leak configuration errors as secrets; map to generic failure reasons.
    return { ok: false, reason: 'verify-error' };
  }
}

export async function deliverExternalReport({
  home = process.env.INBOX_HOME || os.homedir(),
  campaignDir,
  report,
  fetchImpl = fetch,
  now = Date.now,
  requestId = randomUUID().replace(/-/g, ''),
} = {}) {
  const meta = loadCampaignMeta(campaignDir);
  if (meta.kind !== 'external') {
    return { skipped: true, reason: 't3-thread', threadId: meta.threadId };
  }
  const privateCfg = loadPrivateOrchestrator(home, meta.ref);
  const payload = assertPublicReport({
    ...report,
    schema: report.schema || 'orch-report/1',
    at: report.at || new Date(now()).toISOString(),
    orchestratorRef: meta.ref,
  });
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1000));
  const id = String(requestId);
  const signature = `sha256=${signReport(privateCfg.signingSecret, timestamp, id, body)}`;
  const response = await fetchImpl(privateCfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'Orchestration-Report/1.0',
      'X-Orch-Signature': signature,
      'X-Orch-Timestamp': timestamp,
      'X-Orch-Id': id,
      'X-Orch-Queue': '1',
    },
    body,
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  await response.body?.cancel?.();
  if (!response.ok) throw new Error(`外部汇报失败（HTTP ${response.status}）`);
  return { ok: true, status: response.status, requestId: id };
}
