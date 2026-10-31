#!/usr/bin/env node
/**
 * Worker-thread message delivery helper for orchestration.
 *
 * Owner rule (2026-10-28): messages to RUNNING worker/execution threads must
 * never use t3_thread_send mode=queue. Queued messages sit in the composer
 * until the run ends.
 *
 * Housekeeping (owner amendment to decision 46, 2026-10-28):
 *   - NEW separate matter → queue (auto if idle). Requires explicit
 *     newMatter:true / --hk-new-matter. Queue is HK-only and only for new matters.
 *   - Instruction/correction on HK's CURRENT task → steer while running, auto if idle.
 *   Workers still never queue.
 *
 * T3 MCP t3_thread_send modes (schema):
 *   auto    — start an idle thread; steer a running turn; may queue as fallback
 *   queue   — enqueue a new turn (composer queue); NOT for running workers
 *   steer   — mid-turn update into the active run
 *   restart — interrupt and restart
 *
 * This module is pure decision/verification logic. It does not call T3 MCP and
 * must not be pointed at real Campaign threads from tests. Callers of
 * ~/.agents/t3-tots/t3mcp.mjs (`t3mcp.mjs call t3_thread_send <json>`) must pass
 * the mode this helper resolves; do not edit t3mcp.mjs itself.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const T3_THREAD_SEND_MODES = Object.freeze(['auto', 'queue', 'steer', 'restart']);

/** Recipients that must never receive queue while their turn is live. */
export const WORKER_ROLES = Object.freeze(['worker', 'execution', 'execution-ticket']);

/**
 * Normalize a role label from campaign docs / caller args.
 * @param {string} role
 * @returns {'worker'|'housekeeping'|'orchestrator'|'report'|'other'}
 */
export function classifyRecipient(role) {
  const r = String(role || '').trim().toLowerCase();
  if (WORKER_ROLES.includes(r) || r === 'ticket' || r === 'exec') return 'worker';
  if (r === 'housekeeping' || r === 'hk') return 'housekeeping';
  if (r === 'orchestrator' || r === 'orch') return 'orchestrator';
  if (r === 'report' || r === 'notification' || r === 'notify') return 'report';
  return 'other';
}

/**
 * @param {unknown} state
 * @returns {'running'|'idle'|'terminal'|'unknown'}
 */
export function normalizeThreadState(state) {
  const s = String(state || '').trim().toLowerCase();
  if (['running', 'active', 'in_progress', 'working', 'busy'].includes(s)) return 'running';
  if (['idle', 'completed', 'ready', 'stopped'].includes(s)) return 'idle';
  if (['interrupted', 'failed', 'cancelled', 'canceled', 'error'].includes(s)) return 'terminal';
  return 'unknown';
}

/**
 * True when the caller marks this housekeeping send as a NEW separate matter.
 * Accepts newMatter, hkNewMatter, or stringy CLI truthy values.
 * @param {unknown} input
 */
export function isHkNewMatter(input = {}) {
  const raw = input.newMatter ?? input.hkNewMatter ?? input['hk-new-matter'];
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0 || raw == null || raw === '') return false;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Resolve the t3_thread_send mode for one outbound message.
 *
 * @param {{
 *   recipientRole?: string,
 *   threadState?: string,
 *   requestedMode?: string|null,
 *   driver?: string|null,
 *   newMatter?: boolean,
 *   hkNewMatter?: boolean,
 * }} input
 * @returns {{
 *   mode: 'auto'|'queue'|'steer'|'restart',
 *   ok: boolean,
 *   refused: boolean,
 *   reason: string,
 *   flags: string[],
 *   newMatter?: boolean,
 * }}
 */
export function resolveWorkerSendMode(input = {}) {
  const kind = classifyRecipient(input.recipientRole);
  const threadState = normalizeThreadState(input.threadState);
  const requested = input.requestedMode == null || input.requestedMode === ''
    ? null
    : String(input.requestedMode).trim().toLowerCase();
  const flags = [];
  const newMatter = isHkNewMatter(input);

  if (requested && !T3_THREAD_SEND_MODES.includes(requested)) {
    return {
      mode: 'steer',
      ok: false,
      refused: true,
      reason: `unknown mode ${requested}; allowed: ${T3_THREAD_SEND_MODES.join('|')}`,
      flags: ['unknown-mode'],
    };
  }

  // Reports / orchestrator notifications: always queue, never auto (decision 28/38, SKILL.md).
  if (kind === 'orchestrator' || kind === 'report') {
    if (requested && requested !== 'queue') {
      flags.push(`requested-${requested}-overridden-to-queue`);
    }
    return {
      mode: 'queue',
      ok: true,
      refused: false,
      reason: 'reports and orchestrator notifications stay queue-only (never auto)',
      flags,
    };
  }

  // Housekeeping (decision 46 owner amendment 2026-10-28):
  //   new separate matter → queue (auto if idle), only with explicit newMatter flag
  //   current-task instruction → steer while running, auto while idle
  // Queue exception is HK-only and only for new matters; workers never queue.
  if (kind === 'housekeeping') {
    if (newMatter) {
      flags.push('hk-new-matter');
      if (requested === 'steer' || requested === 'restart') {
        return {
          mode: threadState === 'idle' ? 'auto' : 'queue',
          ok: false,
          refused: true,
          reason: 'housekeeping new-matter uses queue (auto if idle); refuse steer/restart so the current plan is not interrupted',
          flags: [...flags, 'housekeeping-new-matter-no-steer'],
          newMatter: true,
        };
      }
      if (threadState === 'idle') {
        if (requested === 'queue') flags.push('idle-prefers-auto');
        return {
          mode: 'auto',
          ok: true,
          refused: false,
          reason: 'housekeeping new matter, idle → auto',
          flags,
          newMatter: true,
        };
      }
      return {
        mode: 'queue',
        ok: true,
        refused: false,
        reason: 'housekeeping new matter → queue (does not disrupt current plan)',
        flags,
        newMatter: true,
      };
    }

    // Current-task path: never queue without --hk-new-matter.
    if (requested === 'queue') {
      return {
        mode: threadState === 'running' ? 'steer' : 'auto',
        ok: false,
        refused: true,
        reason: 'housekeeping queue requires explicit newMatter/--hk-new-matter for a separate matter; current-task instructions use steer (running) or auto (idle)',
        flags: ['housekeeping-queue-needs-new-matter'],
        newMatter: false,
      };
    }

    if (threadState === 'running') {
      const mode = requested === 'restart' ? 'restart' : 'steer';
      if (requested === 'auto') flags.push('auto-on-running-hk-use-steer');
      return {
        mode,
        ok: true,
        refused: false,
        reason: 'housekeeping current-task instruction → steer while running',
        flags,
        newMatter: false,
      };
    }

    if (threadState === 'terminal') {
      const mode = requested === 'restart' ? 'restart' : 'auto';
      return {
        mode,
        ok: true,
        refused: false,
        reason: 'housekeeping terminal → auto to continue current task',
        flags,
        newMatter: false,
      };
    }

    // idle or unknown current-task
    if (requested === 'steer') {
      flags.push('steer-on-idle-hk-may-need-auto');
      return {
        mode: 'steer',
        ok: true,
        refused: false,
        reason: 'requested steer on idle/unknown housekeeping; if thread_not_sendable, retry auto',
        flags,
        newMatter: false,
      };
    }
    return {
      mode: requested === 'restart' ? 'restart' : 'auto',
      ok: true,
      refused: false,
      reason: 'housekeeping current-task, idle/unknown → auto',
      flags,
      newMatter: false,
    };
  }

  // Workers / execution tickets: never queue (owner 2026-10-28).
  if (kind === 'worker') {
    if (requested === 'queue') {
      return {
        mode: threadState === 'running' ? 'steer' : 'auto',
        ok: false,
        refused: true,
        reason: 'queue is refused for worker/execution threads; use steer while running, auto while idle',
        flags: [
          'never-queue-worker',
          threadState === 'running' ? 'would-have-queued-on-running' : 'queue-on-idle-worker',
        ],
      };
    }

    if (threadState === 'running') {
      // Prefer explicit steer. auto also steers a running turn per T3 schema, but
      // may fall back to queue; do not default workers to auto while running.
      const mode = requested === 'restart' ? 'restart' : 'steer';
      if (requested === 'auto') flags.push('auto-on-running-worker-use-steer');
      if (input.driver && /cursor/i.test(String(input.driver))) {
        flags.push('cursor-worker-steer-residual-risk');
      }
      return {
        mode,
        ok: true,
        refused: false,
        reason: 'running worker → steer (never queue); auto on a running turn steers but may queue as fallback',
        flags,
      };
    }

    if (threadState === 'terminal') {
      const mode = requested === 'restart' ? 'restart' : 'auto';
      return {
        mode,
        ok: true,
        refused: false,
        reason: 'terminal worker → auto to start a continuation turn',
        flags,
      };
    }

    // idle or unknown
    if (requested === 'steer') {
      flags.push('steer-on-idle-may-need-auto');
      return {
        mode: 'steer',
        ok: true,
        refused: false,
        reason: 'requested steer on idle/unknown worker; if thread_not_sendable, retry auto',
        flags,
      };
    }
    return {
      mode: requested === 'restart' ? 'restart' : 'auto',
      ok: true,
      refused: false,
      reason: 'idle/unknown worker → auto',
      flags,
    };
  }

  // Unclassified: if caller asks queue on a running thread, flag it.
  if (requested === 'queue' && threadState === 'running') {
    return {
      mode: 'steer',
      ok: false,
      refused: true,
      reason: 'queue refused for running thread without a queue-only role; treat as worker',
      flags: ['never-queue-running', 'unclassified-role'],
    };
  }
  if (requested) {
    return {
      mode: requested,
      ok: true,
      refused: false,
      reason: 'unclassified recipient; honoring requested mode',
      flags: ['unclassified-role'],
    };
  }
  return {
    mode: threadState === 'running' ? 'steer' : 'auto',
    ok: true,
    refused: false,
    reason: 'unclassified recipient default',
    flags: ['unclassified-role'],
  };
}

/**
 * Build the t3_thread_send argument object. Refuses to emit mode=queue for workers
 * and for housekeeping without an explicit new-matter flag.
 *
 * @param {{
 *   threadId: string,
 *   message: string,
 *   recipientRole?: string,
 *   threadState?: string,
 *   requestedMode?: string|null,
 *   driver?: string|null,
 *   newMatter?: boolean,
 *   hkNewMatter?: boolean,
 *   clientRequestId?: string,
 * }} input
 */
export function buildThreadSendArgs(input) {
  if (!input || typeof input.threadId !== 'string' || !input.threadId.trim()) {
    throw new Error('threadId required');
  }
  if (typeof input.message !== 'string' || !input.message.trim()) {
    throw new Error('message required');
  }
  const resolved = resolveWorkerSendMode(input);
  if (resolved.refused) {
    const err = new Error(resolved.reason);
    err.code = 'WORKER_SEND_REFUSED';
    err.resolved = resolved;
    throw err;
  }
  const kind = classifyRecipient(input.recipientRole);
  // Belt-and-suspenders: never emit mode=queue for workers (owner 2026-10-28).
  if (kind === 'worker' && resolved.mode === 'queue') {
    const err = new Error('queue is refused for worker/execution threads');
    err.code = 'WORKER_SEND_REFUSED';
    err.resolved = resolved;
    throw err;
  }
  // Housekeeping queue only when newMatter was explicit.
  if (kind === 'housekeeping' && resolved.mode === 'queue' && !isHkNewMatter(input)) {
    const err = new Error('housekeeping queue requires explicit newMatter/--hk-new-matter');
    err.code = 'WORKER_SEND_REFUSED';
    err.resolved = resolved;
    throw err;
  }
  const args = {
    threadId: input.threadId.trim(),
    message: input.message,
    mode: resolved.mode,
  };
  if (input.clientRequestId) args.clientRequestId = input.clientRequestId;
  return { args, resolved };
}

/**
 * Post-send verification: the payload must land in the active run, not the composer queue.
 *
 * Call after t3_thread_send. Pass snapshots from t3_queue (list) and t3_thread_read
 * (recent/active run messages). Never treat a bare send ACK as delivery.
 *
 * @param {{
 *   message: string,
 *   modeUsed: string,
 *   recipientRole?: string,
 *   newMatter?: boolean,
 *   hkNewMatter?: boolean,
 *   queueEntries?: Array<{ text?: string, message?: string, id?: string }>,
 *   activeRunMessages?: Array<{ text?: string, message?: string, role?: string }>,
 *   activeRunStatus?: string,
 *   sendAccepted?: boolean,
 * }} snapshot
 * @returns {{
 *   ok: boolean,
 *   inActiveRun: boolean,
 *   inQueue: boolean,
 *   reason: string,
 * }}
 */
export function verifyWorkerDelivery(snapshot = {}) {
  const needle = normalizeMessage(snapshot.message || '');
  const modeUsed = String(snapshot.modeUsed || '').toLowerCase();
  const kind = classifyRecipient(snapshot.recipientRole || 'worker');
  const queueEntries = Array.isArray(snapshot.queueEntries) ? snapshot.queueEntries : [];
  const activeMessages = Array.isArray(snapshot.activeRunMessages) ? snapshot.activeRunMessages : [];

  const inQueue = queueEntries.some(entry => messageMatches(entry?.text || entry?.message || '', needle));
  const inActiveRun = activeMessages.some(entry => messageMatches(entry?.text || entry?.message || '', needle));

  // Orchestrator/report: always queue-only.
  if (kind === 'orchestrator' || kind === 'report') {
    if (modeUsed !== 'queue' && modeUsed !== 'auto') {
      return {
        ok: false,
        inActiveRun,
        inQueue,
        reason: `queue-only recipient used mode=${modeUsed}`,
      };
    }
    if (inQueue || snapshot.sendAccepted === true) {
      return { ok: true, inActiveRun, inQueue, reason: 'queue-only delivery accepted' };
    }
    return { ok: false, inActiveRun, inQueue, reason: 'queue-only message not observed in queue' };
  }

  // Housekeeping: new-matter uses queue path; current-task uses active-run path (like workers).
  // newMatter flag is required for the queue success path (same explicit rule as resolve/build).
  if (kind === 'housekeeping') {
    const newMatter = isHkNewMatter(snapshot);
    if (modeUsed === 'queue' && !newMatter) {
      return {
        ok: false,
        inActiveRun,
        inQueue,
        reason: 'housekeeping mode=queue without newMatter/--hk-new-matter; refuse verify (pass newMatter for a separate matter, or use steer/auto for current-task)',
      };
    }
    if (newMatter) {
      if (modeUsed !== 'queue' && modeUsed !== 'auto') {
        return {
          ok: false,
          inActiveRun,
          inQueue,
          reason: `housekeeping new-matter expected queue/auto, got mode=${modeUsed}`,
        };
      }
      if (inQueue || snapshot.sendAccepted === true) {
        return { ok: true, inActiveRun, inQueue, reason: 'housekeeping new-matter queue delivery accepted' };
      }
      return { ok: false, inActiveRun, inQueue, reason: 'housekeeping new-matter message not observed in queue' };
    }
    // Current-task: same never-queue / active-run rules as workers.
    if (inQueue || modeUsed === 'queue') {
      return {
        ok: false,
        inActiveRun,
        inQueue: Boolean(inQueue),
        reason: 'housekeeping current-task message must not use queue; re-send with steer (running) or auto (idle), or pass newMatter for a separate matter',
      };
    }
    if (inActiveRun) {
      return { ok: true, inActiveRun: true, inQueue: false, reason: 'housekeeping current-task message observed in active run' };
    }
    const notQueued = !inQueue && modeUsed !== 'queue';
    const acceptedNonQueue = snapshot.sendAccepted === true
      && (modeUsed === 'steer' || modeUsed === 'auto' || modeUsed === 'restart');
    if (notQueued && acceptedNonQueue) {
      return {
        ok: false,
        inActiveRun: false,
        inQueue: false,
        reason: 'echo pending: housekeeping current-task send accepted and not in queue, but not yet in active run; re-read and verify again',
        provisional: true,
      };
    }
    return {
      ok: false,
      inActiveRun: false,
      inQueue: false,
      reason: 'could not confirm housekeeping current-task message entered the active run',
    };
  }

  // Workers: queue presence is failure (never-queue rule).
  if (inQueue) {
    return {
      ok: false,
      inActiveRun,
      inQueue: true,
      reason: 'worker message landed in composer queue; re-send with steer (running) or auto (idle), never queue',
    };
  }

  if (modeUsed === 'queue') {
    return {
      ok: false,
      inActiveRun,
      inQueue,
      reason: 'worker send used mode=queue',
    };
  }

  if (inActiveRun) {
    return { ok: true, inActiveRun: true, inQueue: false, reason: 'message observed in active run' };
  }

  // Fail closed: ticket requires the payload in the active run, not merely "not in queue".
  // Callers must re-read t3_thread_read / queue and call verify again until inActiveRun.
  const notQueued = !inQueue && modeUsed !== 'queue';
  const acceptedNonQueue = snapshot.sendAccepted === true
    && (modeUsed === 'steer' || modeUsed === 'auto' || modeUsed === 'restart');
  if (notQueued && acceptedNonQueue) {
    return {
      ok: false,
      inActiveRun: false,
      inQueue: false,
      reason: 'echo pending: send accepted and not in queue, but message not yet observed in active run; re-read and verify again',
      provisional: true,
    };
  }

  return {
    ok: false,
    inActiveRun: false,
    inQueue: false,
    reason: 'could not confirm worker message entered the active run; re-read thread and queue',
  };
}

function normalizeMessage(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function messageMatches(haystack, needle) {
  if (!needle) return false;
  const h = normalizeMessage(haystack);
  if (!h) return false;
  if (h === needle) return true;
  // Allow prefix/contains for truncated queue previews.
  if (needle.length >= 24 && h.includes(needle.slice(0, Math.min(needle.length, 120)))) return true;
  if (h.length >= 24 && needle.includes(h.slice(0, Math.min(h.length, 120)))) return true;
  return false;
}

/**
 * CLI: resolve or verify without contacting T3.
 *
 *   worker-send.mjs resolve --role worker --state running [--mode queue]
 *   worker-send.mjs build --thread-id ID --message TEXT --role worker --state running
 *   worker-send.mjs verify --fixture <json-file>
 */
export async function main(argv = process.argv.slice(2), { output = process.stdout, input } = {}) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    output.write(
      [
        'usage:',
        '  worker-send.mjs resolve --role <worker|housekeeping|orchestrator|report> --state <running|idle|terminal> [--mode <mode>] [--driver <name>] [--hk-new-matter]',
        '  worker-send.mjs build --thread-id <id> --message <text> --role <role> --state <state> [--mode <mode>] [--hk-new-matter]',
        '  worker-send.mjs verify --fixture <file.json>   # or pass JSON on stdin',
        '',
        'Never use mode=queue for running worker/execution threads.',
        'Housekeeping: --hk-new-matter for a NEW separate matter (queue / auto if idle);',
        '  omit it for current-task instructions (steer while running, auto if idle).',
        't3mcp callers: resolve mode here, then `t3mcp.mjs call t3_thread_send <json>` with that mode.',
        'Do not edit ~/.agents/t3-tots/t3mcp.mjs.',
        '',
      ].join('\n'),
    );
    return { ok: true, help: true };
  }

  const flags = parseFlags(argv.slice(1));
  const newMatter = isHkNewMatter({
    newMatter: flags['hk-new-matter'] ?? flags['new-matter'] ?? flags.newMatter,
  });

  if (cmd === 'resolve') {
    const resolved = resolveWorkerSendMode({
      recipientRole: flags.role || 'worker',
      threadState: flags.state || 'unknown',
      requestedMode: flags.mode,
      driver: flags.driver,
      newMatter,
    });
    output.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return resolved;
  }

  if (cmd === 'build') {
    try {
      const result = buildThreadSendArgs({
        threadId: flags['thread-id'] || flags.threadId,
        message: flags.message,
        recipientRole: flags.role || 'worker',
        threadState: flags.state || 'unknown',
        requestedMode: flags.mode,
        driver: flags.driver,
        newMatter,
        clientRequestId: flags['client-request-id'],
      });
      output.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return { ok: true, ...result };
    } catch (error) {
      const body = {
        ok: false,
        refused: error.code === 'WORKER_SEND_REFUSED',
        reason: error.message,
        resolved: error.resolved || null,
      };
      output.write(`${JSON.stringify(body, null, 2)}\n`);
      return body;
    }
  }

  if (cmd === 'verify') {
    let snapshot;
    if (flags.fixture) {
      const { readFile } = await import('node:fs/promises');
      snapshot = JSON.parse(await readFile(flags.fixture, 'utf8'));
    } else {
      const raw = input != null ? input : await readStdin();
      snapshot = JSON.parse(String(raw));
    }
    const result = verifyWorkerDelivery(snapshot);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  throw new Error(`unknown command ${cmd}`);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected arg ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i++;
  }
  return flags;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().then(result => {
    if (result && result.ok === false) process.exitCode = 1;
    if (result && result.refused) process.exitCode = 2;
  }).catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
