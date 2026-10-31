#!/usr/bin/env node
/**
 * Checked writer for Campaign campaign.json.
 *
 * Requires tickets[].title (DISPATCH id：title), validates stage against STATE.md
 * (including legacy readable prefixes), housekeeping.countsTowardLimits === false
 * when set, refuses URL/token-like secret fields (same spirit as
 * loadCampaignMeta / EXTERNAL-ORCHESTRATOR.md), backs up, atomic write.
 *
 * Does not call T3, Inbox network APIs, or touch real Campaign dirs from tests.
 * Orchestrator owns campaign.json (STATE.md); this is the safe mutation helper.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, readJson } from '../inbox-web/config.mjs';
import { parseFlags } from './cli-args.mjs';
import { normalizeTicketTitle } from './ticket-ref.mjs';

/** Fixed stage enum from STATE.md (new writes). */
export const STAGE_EXACT = Object.freeze([
  '未开始',
  '执行中',
  '返修',
  '已交付',
  '等你来讨论',
  '已合并',
  '已关闭',
  '移出范围',
]);

/** Prefix forms still written today. */
const STAGE_PREFIXES = Object.freeze([
  '卡住：', // blocked: reason
  '等你决定 ', // awaiting owner decision + question id
]);

/**
 * Legacy stored stages the Inbox progress board still treats as completed
 * (store.mjs view()). Must round-trip so title backfill is not blocked.
 */
const STAGE_LEGACY_DONE = Object.freeze([
  '已合入',
  '已合主线',
]);

/**
 * Keys that must never hold secrets/endpoints in campaign.json.
 * Union of P9 key-shaped refusals and P33 narrow list (signingSecret, inboundToken, …).
 * `url` is handled via value shape + allowlist instead of a bare key ban.
 */
const SECRET_KEY_RE = /^(webhookUrl|webhookURL|endpoint|reportUrl|token|secret|signingSecret|inboundToken|password|authorization|apiKey|api_key|vapid|privateKey)$/i;
const URL_VALUE_RE = /^(https?:\/\/|wss?:\/\/)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+=\/]{8,}\b/i;

/**
 * @param {unknown} stage
 * @returns {boolean}
 */
export function isValidStage(stage) {
  if (typeof stage !== 'string' || !stage.trim()) return false;
  const s = stage.trim();
  if (STAGE_EXACT.includes(s)) return true;
  if (STAGE_PREFIXES.some(prefix => s.startsWith(prefix) && s.length > prefix.length)) return true;
  // Legacy done: bare prefix or prefix + trailing text (store.mjs).
  if (STAGE_LEGACY_DONE.some(prefix => s === prefix || s.startsWith(prefix))) return true;
  // Legacy "已交付" + more text is done; bare 已交付 is already in STAGE_EXACT.
  if (/^已交付./.test(s)) return true;
  return false;
}

/**
 * Walk object tree; collect paths that look like secrets or absolute endpoint URLs
 * that must not live in campaign.json (STATE.md / EXTERNAL-ORCHESTRATOR.md).
 * Allowlist: ticket.url (tracker link), inboxUrl (machine entry, not a secret),
 * root source (tracker map). Ordinary https inside note text is not a bare URL value.
 *
 * Also refuses orchestrator string values that embed :// (loadCampaignMeta spirit)
 * and reportEndpoint when it is a raw URL (label:<ref> only).
 *
 * @param {unknown} value
 * @param {string[]} pathParts
 * @param {string[]} hits
 * @returns {string[]}
 */
function collectSecretHits(value, pathParts = [], hits = []) {
  if (value == null) return hits;
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectSecretHits(item, pathParts.concat(String(i)), hits));
    return hits;
  }
  if (typeof value !== 'object') {
    if (typeof value === 'string') {
      const key = pathParts[pathParts.length - 1] || '';
      const joined = pathParts.join('.') || '(root)';
      const keyNorm = key.toLowerCase();
      // Secret-shaped keys are already recorded at the object-entry step.
      if (keyNorm === 'orchestrator' && value.includes('://')) {
        // loadCampaignMeta: orchestrator must not hold an endpoint URL.
        hits.push(joined);
      } else if (keyNorm === 'reportendpoint' && URL_VALUE_RE.test(value.trim())) {
        // reportEndpoint is label:<ref> only, never a raw URL.
        hits.push(joined);
      } else if (URL_VALUE_RE.test(value.trim()) && !isAllowedUrlField(pathParts)) {
        hits.push(joined);
      } else if (BEARER_RE.test(value)) {
        hits.push(joined);
      }
    }
    return hits;
  }
  for (const [k, v] of Object.entries(value)) {
    const childPath = pathParts.concat(k);
    // P33 key ban: refuse known secret/endpoint field names regardless of value type.
    if (SECRET_KEY_RE.test(k)) {
      hits.push(childPath.join('.'));
      continue;
    }
    collectSecretHits(v, childPath, hits);
  }
  return hits;
}

function isAllowedUrlField(pathParts) {
  const key = pathParts[pathParts.length - 1];
  if (key === 'inboxUrl' && pathParts.length === 1) return true;
  // Exact tickets[<index>].url tracker links only (not nested tickets[i].*.url).
  if (
    pathParts.length === 3
    && pathParts[0] === 'tickets'
    && /^\d+$/.test(pathParts[1])
    && pathParts[2] === 'url'
  ) return true;
  // source may be a tracker map link
  if (key === 'source' && pathParts.length === 1) return true;
  return false;
}

/**
 * Validate a campaign.json document before write.
 * @param {unknown} data
 * @returns {{ ok: true, data: object } | { ok: false, errors: string[] }}
 */
export function validateCampaign(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['campaign.json root must be an object'] };
  }

  if (data.housekeeping != null) {
    if (typeof data.housekeeping !== 'object' || Array.isArray(data.housekeeping)) {
      errors.push('housekeeping must be an object');
    } else if ('countsTowardLimits' in data.housekeeping) {
      if (data.housekeeping.countsTowardLimits !== false) {
        errors.push('housekeeping.countsTowardLimits must be false when present (decision 46)');
      }
    }
  }

  if (data.tickets != null) {
    if (!Array.isArray(data.tickets)) {
      errors.push('tickets must be an array');
    } else {
      data.tickets.forEach((ticket, i) => {
        if (!ticket || typeof ticket !== 'object') {
          errors.push(`tickets[${i}] must be an object`);
          return;
        }
        if (!normalizeTicketTitle(ticket.title)) {
          errors.push(`tickets[${i}].title required (non-empty short description for id：title mentions)`);
        }
        if ('stage' in ticket && !isValidStage(ticket.stage)) {
          errors.push(`tickets[${i}].stage invalid: ${JSON.stringify(ticket.stage)}`);
        }
      });
    }
  }

  if (data.orchestratorKind != null
    && data.orchestratorKind !== 't3-thread'
    && data.orchestratorKind !== 'external') {
    errors.push('orchestratorKind must be t3-thread or external');
  }

  const secretHits = collectSecretHits(data);
  for (const hit of secretHits) {
    errors.push(`refuses URL/token field at ${hit}`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, data };
}

/**
 * Write campaign.json with backup + atomic rename.
 *
 * @param {{
 *   campaignDir: string,
 *   data: object,
 *   backupSuffix?: string,
 *   now?: Date,
 * }} opts
 * @returns {{
 *   ok: true,
 *   path: string,
 *   backupPath: string|null,
 * } | {
 *   ok: false,
 *   errors: string[],
 * }}
 */
export function writeCampaign(opts) {
  const campaignDir = opts?.campaignDir;
  if (typeof campaignDir !== 'string' || !campaignDir.trim()) {
    return { ok: false, errors: ['campaignDir required'] };
  }
  const dir = path.resolve(campaignDir.trim());
  const file = path.join(dir, 'campaign.json');
  const validated = validateCampaign(opts.data);
  if (!validated.ok) return validated;

  let backupPath = null;
  if (fs.existsSync(file)) {
    const stamp = (opts.now || new Date()).toISOString().replace(/[:.]/g, '-');
    const suffix = opts.backupSuffix ? String(opts.backupSuffix) : stamp;
    backupPath = path.join(dir, `campaign.json.bak-${suffix}`);
    fs.copyFileSync(file, backupPath);
  }

  const payload = { ...validated.data };
  if (!payload.updatedAt) {
    payload.updatedAt = (opts.now || new Date()).toISOString();
  }
  atomicJson(file, payload);
  return { ok: true, path: file, backupPath };
}

/**
 * Load, merge shallow patch onto root (and optional ticket patch), validate, write.
 *
 * @param {{
 *   campaignDir: string,
 *   patch?: object,
 *   ticket?: string,
 *   ticketPatch?: object,
 *   backupSuffix?: string,
 * }} opts
 */
export function patchCampaign(opts) {
  const dir = path.resolve(String(opts.campaignDir || ''));
  const file = path.join(dir, 'campaign.json');
  const current = readJson(file, null);
  if (!current || typeof current !== 'object') {
    return { ok: false, errors: ['campaign.json missing or unreadable'] };
  }
  const next = { ...current, ...(opts.patch && typeof opts.patch === 'object' ? opts.patch : {}) };
  if (opts.ticket != null) {
    if (!Array.isArray(next.tickets)) {
      return { ok: false, errors: ['tickets missing; cannot patch ticket'] };
    }
    const id = String(opts.ticket);
    const idx = next.tickets.findIndex(t => t && String(t.ticket) === id);
    if (idx < 0) return { ok: false, errors: [`ticket ${id} not found`] };
    next.tickets = next.tickets.slice();
    next.tickets[idx] = {
      ...next.tickets[idx],
      ...(opts.ticketPatch && typeof opts.ticketPatch === 'object' ? opts.ticketPatch : {}),
    };
  }
  next.updatedAt = new Date().toISOString();
  return writeCampaign({
    campaignDir: dir,
    data: next,
    backupSuffix: opts.backupSuffix,
  });
}

/**
 * CLI:
 *   campaign-write.mjs validate --file <campaign.json>
 *   campaign-write.mjs write --campaign-dir <dir> --file <next.json>
 *   campaign-write.mjs patch --campaign-dir <dir> --patch <patch.json> [--ticket '#1' --ticket-patch <json>]
 */
export async function main(argv = process.argv.slice(2), { output = process.stdout } = {}) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    output.write(
      [
        'usage:',
        '  campaign-write.mjs validate --file <campaign.json>',
        '  campaign-write.mjs write --campaign-dir <dir> --file <next.json> [--backup-suffix <tag>]',
        '  campaign-write.mjs patch --campaign-dir <dir> --patch <patch.json> [--ticket <id> --ticket-patch <json>]',
        '',
        'Validates tickets[].title non-empty, stage (STATE + legacy), housekeeping.countsTowardLimits false, no URL/token secrets.',
        'write/patch: backup campaign.json.bak-<suffix>, then atomic write.',
        '',
      ].join('\n'),
    );
    return { ok: true, help: true };
  }

  const flags = parseFlags(argv.slice(1));

  if (cmd === 'validate') {
    const file = flags.file;
    if (!file) throw new Error('--file required');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = validateCampaign(data);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  if (cmd === 'write') {
    const dir = flags['campaign-dir'] || flags.campaignDir;
    const file = flags.file;
    if (!dir || !file) throw new Error('--campaign-dir and --file required');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = writeCampaign({
      campaignDir: dir,
      data,
      backupSuffix: flags['backup-suffix'],
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  if (cmd === 'patch') {
    const dir = flags['campaign-dir'] || flags.campaignDir;
    if (!dir) throw new Error('--campaign-dir required');
    const patch = flags.patch
      ? JSON.parse(fs.readFileSync(flags.patch, 'utf8'))
      : {};
    const ticketPatch = flags['ticket-patch']
      ? JSON.parse(fs.readFileSync(flags['ticket-patch'], 'utf8'))
      : undefined;
    const result = patchCampaign({
      campaignDir: dir,
      patch,
      ticket: flags.ticket,
      ticketPatch,
      backupSuffix: flags['backup-suffix'],
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  throw new Error(`unknown command ${cmd}`);
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().then(result => {
    if (result && result.ok === false) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
