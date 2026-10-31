#!/usr/bin/env node
/**
 * Sanctioned mid-Campaign orchestrator handoff.
 *
 * Usage:
 *   node handoff.mjs plan  <campaignId> --to <target> [options]
 *   node handoff.mjs apply <campaignId> --to <target> [options]
 *   node handoff.mjs revert <campaignId> [--handoff-id <id>] [options]
 *
 * Target forms:
 *   external:<label>          → orchestratorKind external, orchestratorRef <label>
 *   t3-thread:<threadId>      → orchestratorKind t3-thread, orchestrator <threadId>
 *   thread:<threadId>         → same as t3-thread
 *
 * plan is dry-run (default intent). apply mutates. revert restores the prior record.
 * Never prints webhook URLs, signing secrets, or private file contents.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicJson, readJson, loadConfig } from '../inbox-web/config.mjs';
import { loadCampaignMeta, privateOrchestratorPath } from './orchestrator-target.mjs';
import { loadPools, status as leaseStatusAll } from './lease.mjs';

const USAGE = `handoff.mjs plan|apply|revert <campaignId> --to <external:label|t3-thread:threadId> [--campaign-dir <dir>] [--home <dir>] [--forwarder-port <n>] [--handoff-id <id>] [--scheduled-tasks-file <json>] [--leases-file <json>] [--project <orchestration.md>] [--allow-owner-blocked] [--carry-over-pending]`;

const PENDING_INBOX_STATUSES = new Set(['saved', 'notified', 'read']);
const DEFAULT_FORWARDER_PORT = 8793;

export function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('--to 需要 external:<label> 或 t3-thread:<threadId>');
  const value = raw.trim();
  const external = /^external:(.+)$/i.exec(value);
  if (external) {
    const ref = external[1].trim();
    if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error('external 标签不合法');
    return { kind: 'external', ref, threadId: null, label: `external:${ref}` };
  }
  const thread = /^(?:t3-thread|thread):(.+)$/i.exec(value);
  if (thread) {
    const threadId = thread[1].trim();
    if (!threadId || /\s/.test(threadId)) throw new Error('t3-thread 目标需要非空 threadId');
    if (/^https?:\/\//i.test(threadId)) throw new Error('threadId 不得是 URL');
    return { kind: 't3-thread', ref: null, threadId, label: `t3-thread:${threadId}` };
  }
  throw new Error('--to 需要 external:<label> 或 t3-thread:<threadId>');
}

export function parseArgv(argv) {
  const [command, ...rest] = argv;
  if (!['plan', 'apply', 'revert'].includes(command)) throw new Error(USAGE);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'carry-over-pending') {
        if (command === 'revert') throw new Error('--carry-over-pending is only for plan/apply');
        flags.carryOverPending = true;
        continue;
      }
      if (key === 'allow-owner-blocked' || key === 'allow-running') {
        // allow-running kept as deprecated alias of allow-owner-blocked
        flags.allowOwnerBlocked = true;
        continue;
      }
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`参数 --${key} 缺值`);
      flags[key] = rest[++i];
    } else positionals.push(arg);
  }
  if (command === 'revert') {
    if (positionals.length !== 1) throw new Error(USAGE);
    return { command, campaignId: positionals[0], flags };
  }
  if (positionals.length !== 1 || !flags.to) throw new Error(USAGE);
  return { command, campaignId: positionals[0], flags };
}

function stamp(now = Date.now) {
  return new Date(now()).toISOString();
}

function handoffId(now = Date.now) {
  const t = new Date(now()).toISOString().replace(/[:.]/g, '').replace('T', '-');
  return `${t}-${randomBytes(3).toString('hex')}`;
}

export function resolveCampaignDir({ home, campaignId, campaignDir }) {
  if (campaignDir) {
    const dir = path.resolve(campaignDir);
    if (!fs.existsSync(path.join(dir, 'campaign.json'))) throw new Error('campaign-dir 缺少 campaign.json');
    return dir;
  }
  const config = loadConfig({ home });
  const entry = (config.campaigns || []).find(c => c.id === campaignId);
  if (!entry?.dir) throw new Error(`未注册的 Campaign：${campaignId}`);
  return path.resolve(entry.dir);
}

export function isCampaignRegistered(home, campaignId) {
  const config = loadConfig({ home });
  return (config.campaigns || []).some(c => c.id === campaignId && c.dir);
}

export function privateOrchestratorPresent(home, ref) {
  try {
    return fs.statSync(privateOrchestratorPath(home, ref)).isFile();
  } catch {
    return false;
  }
}

/** Load lease occupancy for safety checks. Prefer --leases-file; else --project → lease.mjs status. */
export async function resolveLeaseStatus({
  leasesFile = null,
  projectFile = null,
  leaseStatus = null,
} = {}) {
  if (Array.isArray(leaseStatus)) return leaseStatus;
  if (leasesFile) {
    const data = JSON.parse(fs.readFileSync(path.resolve(leasesFile), 'utf8'));
    if (!Array.isArray(data)) throw new Error('leases-file 必须是数组（lease.mjs status 形）');
    return data;
  }
  if (projectFile) {
    const config = await loadPools(path.resolve(projectFile));
    return leaseStatusAll(config);
  }
  return null;
}

/** Same acceptance gate the t3tots-forward loopback uses (skill-side mirror; do not edit the forwarder). */
export function forwarderAcceptance({ home, campaignId, campaignDir }) {
  const reasons = [];
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(campaignId)) reasons.push('invalid-campaign-id');
  const registered = isCampaignRegistered(home, campaignId);
  if (!registered) reasons.push('not-registered');
  let meta = null;
  try {
    meta = readJson(path.join(campaignDir, 'campaign.json'), null);
  } catch {
    reasons.push('campaign-json-unreadable');
  }
  if (!meta) reasons.push('campaign-json-missing');
  else if (meta.orchestratorKind !== 'external') reasons.push('orchestratorKind-not-external');
  const ok = reasons.length === 0;
  return {
    ok,
    reasons,
    check: 'registered in machine.json AND campaign.json orchestratorKind === "external"',
    note: 't3tots-forward rejects with campaign-not-allowed / "not an external registered campaign" when this gate fails. Handoff apply must leave the Campaign registered and kind=external; private orchestrator secrets stay out of campaign.json.',
  };
}

export function readInboxState(campaignDir) {
  const file = path.join(campaignDir, 'inbox.json');
  if (!fs.existsSync(file)) return { items: [], messages: [] };
  const data = readJson(file, { items: [], messages: [] });
  return {
    items: Array.isArray(data.items) ? data.items : [],
    messages: Array.isArray(data.messages) ? data.messages : [],
  };
}

export function collectSafetyBlocks(campaign, campaignDir, { allowOwnerBlocked = false, allowRunning = false, leaseStatus = null, carryOverPending = false } = {}) {
  const allowBlocked = allowOwnerBlocked || allowRunning;
  const blocks = [];
  const awaiting = Array.isArray(campaign.awaitingReports) ? campaign.awaitingReports.filter(Boolean) : [];
  if (awaiting.length && !carryOverPending) blocks.push({ code: 'awaiting-reports', detail: awaiting.slice(0, 8) });

  const openTasks = (Array.isArray(campaign.tasks) ? campaign.tasks : []).filter(t => t && t.processed !== true);
  if (openTasks.length) {
    blocks.push({
      code: 'unprocessed-tasks',
      detail: openTasks.slice(0, 8).map(t => t.taskId || t.purpose || 'task'),
    });
  }

  if (campaign.housekeeping?.disk?.pending) {
    blocks.push({ code: 'housekeeping-disk-pending', detail: true });
  }

  const inbox = readInboxState(campaignDir);
  const pendingItems = inbox.items.filter(item => {
    if (!item || item.status === 'closed' || item.status === 'open') return false;
    if (item.withdrawalPending) return true;
    return PENDING_INBOX_STATUSES.has(item.status);
  });
  const pendingMessages = inbox.messages.filter(m => m && m.status && m.status !== 'read' && m.status !== 'closed');
  const blockingItems = carryOverPending ? pendingItems.filter(i => i.withdrawalPending) : pendingItems;
  if (blockingItems.length || pendingMessages.length) {
    blocks.push({
      code: 'pending-inbox',
      detail: {
        items: blockingItems.map(i => i.id).slice(0, 12),
        messages: pendingMessages.length,
      },
    });
  }

  if (Array.isArray(leaseStatus)) {
    const held = leaseStatus.filter(row => row && row.pid);
    if (held.length) {
      blocks.push({
        code: 'active-leases',
        detail: held.slice(0, 12).map(row => ({ pool: row.pool, lane: row.lane, pid: row.pid })),
      });
    }
  }

  if (!allowBlocked) {
    // Live 执行中/返修 tickets are OK (report-to updates). Refuse owner-blocked stages unless flagged.
    const ownerBlocked = (Array.isArray(campaign.tickets) ? campaign.tickets : []).filter(t => {
      if (!t || typeof t.stage !== 'string') return false;
      return t.stage.startsWith('等你决定') || t.stage === '等你来讨论' || t.stage.startsWith('卡住');
    });
    if (ownerBlocked.length) {
      blocks.push({
        code: 'owner-blocked-tickets',
        detail: ownerBlocked.slice(0, 8).map(t => t.ticket),
      });
    }
  }

  const lock = path.join(campaignDir, 'handoffs', '.apply.lock');
  if (fs.existsSync(lock)) {
    blocks.push({ code: 'handoff-lock-held', detail: lock });
  }

  return blocks;
}

function currentOrchestratorState(campaign) {
  const kind = campaign.orchestratorKind === 'external' ? 'external' : 't3-thread';
  if (kind === 'external') {
    return {
      kind,
      ref: typeof campaign.orchestratorRef === 'string' ? campaign.orchestratorRef : null,
      threadId: null,
      reportEndpoint: typeof campaign.reportEndpoint === 'string' ? campaign.reportEndpoint : null,
      webhookTask: campaign.webhookTask ?? null,
      patrolTask: campaign.patrolTask ?? null,
    };
  }
  return {
    kind: 't3-thread',
    ref: null,
    threadId: typeof campaign.orchestrator === 'string' ? campaign.orchestrator : null,
    reportEndpoint: null,
    webhookTask: campaign.webhookTask ?? null,
    patrolTask: campaign.patrolTask ?? null,
  };
}

function sameTarget(from, to) {
  if (from.kind !== to.kind) return false;
  if (to.kind === 'external') return from.ref === to.ref;
  return from.threadId === to.threadId;
}

function webhookLabelFor(target, campaignId) {
  if (target.kind === 'external') {
    return `external:t3tots-forward (loopback /inbox/${campaignId})`;
  }
  return null; // filled after operator creates T3 webhook task
}

export function forwarderInboxUrl(campaignId, port = DEFAULT_FORWARDER_PORT) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(campaignId)) throw new Error('campaign id 不合法');
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('forwarder-port 无效');
  return `http://127.0.0.1:${p}/inbox/${campaignId}`;
}

function loadExtraScheduledTasks(file) {
  if (!file) return [];
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!Array.isArray(data)) throw new Error('scheduled-tasks-file 必须是数组');
  return data.map(row => {
    if (typeof row === 'string') return { taskId: row, role: 'unknown' };
    if (row && typeof row.taskId === 'string') {
      return { taskId: row.taskId, role: row.role || 'unknown', title: row.title || null };
    }
    throw new Error('scheduled-tasks-file 项需要 taskId');
  });
}

function enumerateAutomations(campaign, campaignId, extraTasks = []) {
  const list = [];
  const seen = new Set();
  const push = (taskId, role, note) => {
    if (!taskId || typeof taskId !== 'string') return;
    // Labels like external:… are not T3 scheduled task IDs.
    if (taskId.startsWith('external:')) {
      list.push({ taskId, role, kind: 'label', action: 'none', note: note || 'label only; not a T3 scheduled task' });
      return;
    }
    if (seen.has(taskId)) return;
    seen.add(taskId);
    list.push({
      taskId,
      role,
      kind: 't3-scheduled-task',
      action: 'delete_scheduled_task',
      note: note || null,
    });
  };

  push(campaign.webhookTask, 'webhook', 'Inbox webhook wakeup bound to old orchestrator');
  push(campaign.patrolTask, 'patrol', '60-minute patrol bound to old orchestrator');

  for (const row of extraTasks) push(row.taskId, row.role || 'extra', row.title || null);

  // Hint patterns operators often use (e.g. pm-v3-orch-<threadPrefix>-*-date).
  const oldThread = typeof campaign.orchestrator === 'string' ? campaign.orchestrator : '';
  const threadHint = oldThread.includes(':') ? oldThread.split(':').pop().slice(0, 8) : oldThread.slice(0, 8);
  const enumerateInstructions = [
    'Call list_scheduled_tasks for this project (omit projectId for the current project).',
    'Disable/delete every task whose prompt mentions this campaign id or is bound to the old orchestrator thread.',
    threadHint
      ? `Also match title/prompt patterns containing the old thread fragment "${threadHint}" or campaign id "${campaignId}" (e.g. daily pm-*-orch-*-YYYYMMDD).`
      : `Also match title/prompt patterns containing campaign id "${campaignId}".`,
    'Use delete_scheduled_task for each stale taskId. Do not leave old webhook/patrol tasks waking the previous orchestrator.',
  ];

  return { known: list, enumerateInstructions };
}

function reportToInstructions(campaign, target, { carryOverPending = false } = {}) {
  const awaiting = new Set(carryOverPending && Array.isArray(campaign.awaitingReports) ? campaign.awaitingReports : []);
  const tickets = (Array.isArray(campaign.tickets) ? campaign.tickets : []).filter(t => {
    if (!t?.thread) return false;
    if (awaiting.has(t.ticket)) return true;
    if (typeof t.stage !== 'string') return true;
    if (t.stage.startsWith('已合并') || t.stage.startsWith('已关闭') || t.stage.startsWith('移出范围') || t.stage.startsWith('已合入') || t.stage.startsWith('已合主线')) return false;
    if (t.stage === '已交付' && t.acceptance) return true;
    if (t.stage === '已交付') return false;
    return true;
  });

  return tickets.map(t => {
    const base = {
      ticket: t.ticket,
      threadId: t.thread,
      stage: t.stage,
      sendMode: 'steer',
      cursorException: 'Never mode=queue for workers (any driver, incl. Cursor): steer while running, auto if idle; resolve/verify with scripts/worker-send.mjs.',
    };
    if (target.kind === 'external') {
      return {
        ...base,
        reportTo: {
          kind: 'external',
          orchestratorRef: target.ref,
          command: 'node <skill-dir>/scripts/report.mjs --campaign-dir <absolute-campaign-dir> --file <report.json>',
        },
        messageOutline:
          `Orchestrator handoff: report-to is now external ref ${target.ref}. ` +
          'Do not t3_thread_send reports to any old orchestrator threadId. ' +
          'Use scripts/report.mjs (signed, queue-only) for startup/blocker/decision/delivery. ' +
          'Continue current work; do not re-dispatch.',
      };
    }
    return {
      ...base,
      reportTo: { kind: 't3-thread', threadId: target.threadId },
      messageOutline:
        `Orchestrator handoff: report-to is now T3 thread ${target.threadId}. ` +
        'Send milestone reports with t3_thread_send mode=queue to that threadId only. ' +
        'Continue current work; do not re-dispatch.',
    };
  }).concat(
    campaign.housekeeping?.threadId
      ? [{
          ticket: 'housekeeping',
          threadId: campaign.housekeeping.threadId,
          stage: 'housekeeping',
          // Takeover notify is a current-task correction (decision 46 amendment):
          // steer while running, auto if idle — resolve with worker-send.mjs.
          // queue only with --hk-new-matter when the notify must wait behind in-flight work.
          sendMode: 'steer',
          cursorException: 'HK takeover notify: current-task steer (auto if idle) via scripts/worker-send.mjs; queue only with --hk-new-matter if it must wait.',
          reportTo: target.kind === 'external'
            ? { kind: 'external', orchestratorRef: target.ref, command: 'node <skill-dir>/scripts/report.mjs --campaign-dir <abs> --file <report.json>' }
            : { kind: 't3-thread', threadId: target.threadId },
          messageOutline: target.kind === 'external'
            ? `Housekeeping handoff: report via report.mjs to external ref ${target.ref}; orchestrator→HK: new matter queue (--hk-new-matter), current-task steer/auto.`
            : `Housekeeping handoff: new orchestrator threadId ${target.threadId}; notify as current-task steer/auto (new-matter queue only if it must wait).`,
        }]
      : [],
  );
}

function nextCampaignFields(campaign, target, { webhookTask, patrolTask }) {
  const next = { ...campaign };
  next.updatedAt = stamp();
  if (target.kind === 'external') {
    next.orchestratorKind = 'external';
    next.orchestrator = null;
    next.orchestratorRef = target.ref;
    next.reportEndpoint = `label:${target.ref}`;
    next.webhookTask = webhookTask;
    // External patrol is not a T3 schedule_task by default.
    next.patrolTask = patrolTask === undefined ? null : patrolTask;
  } else {
    next.orchestratorKind = 't3-thread';
    next.orchestrator = target.threadId;
    next.orchestratorRef = null;
    next.reportEndpoint = null;
    if (webhookTask !== undefined) next.webhookTask = webhookTask;
    if (patrolTask !== undefined) next.patrolTask = patrolTask;
  }
  return next;
}

export function buildPlan({
  home,
  campaignId,
  campaignDir,
  target,
  allowOwnerBlocked = false,
  allowRunning = false,
  carryOverPending = false,
  forwarderPort = DEFAULT_FORWARDER_PORT,
  scheduledTasksFile = null,
  leaseStatus = null,
  now = Date.now,
}) {
  const campaignPath = path.join(campaignDir, 'campaign.json');
  const campaign = readJson(campaignPath, null);
  if (!campaign || typeof campaign !== 'object') throw new Error('campaign.json 不可读');
  if (campaign.id && campaign.id !== campaignId) {
    throw new Error(`campaign.json id=${campaign.id} 与参数 ${campaignId} 不一致`);
  }
  const id = campaign.id || campaignId;

  // Validate current meta shape without accepting URL secrets.
  loadCampaignMeta(campaignDir);

  const from = currentOrchestratorState(campaign);
  const blocks = collectSafetyBlocks(campaign, campaignDir, { allowOwnerBlocked, allowRunning, leaseStatus, carryOverPending });
  const carriedPending = carryOverPending ? {
    awaitingReports: Array.isArray(campaign.awaitingReports) ? campaign.awaitingReports : [],
    inboxItems: readInboxState(campaignDir).items.filter(i => i && PENDING_INBOX_STATUSES.has(i.status) && !i.withdrawalPending).map(i => ({ id: i.id, status: i.status })),
  } : null;
  const converged = sameTarget(from, target);

  if (target.kind === 'external') {
    if (!privateOrchestratorPresent(home, target.ref)) {
      blocks.push({
        code: 'missing-private-orchestrator',
        detail: `private/orchestrators/${target.ref}.json must exist before apply (create in an unrecorded local terminal; handoff never writes secrets)`,
      });
    }
    if (!isCampaignRegistered(home, id)) {
      blocks.push({
        code: 'not-registered',
        detail: 'Register with inbox.mjs register <dir> before external handoff so t3tots-forward accepts the Campaign',
      });
    }
  }

  const extra = loadExtraScheduledTasks(scheduledTasksFile);
  const automations = enumerateAutomations(campaign, id, extra);
  const reportTo = reportToInstructions(campaign, target, { carryOverPending });
  const idForRecord = handoffId(now);
  const handoffsDir = path.join(campaignDir, 'handoffs');
  const backupName = `campaign.json.bak-handoff-${idForRecord}`;
  const recordName = `${idForRecord}.json`;
  const leaseProbe = Array.isArray(leaseStatus)
    ? 'provided'
    : 'none (pass --leases-file <lease.mjs status JSON> or --project <docs/agents/orchestration.md>)';

  const webhook = target.kind === 'external'
    ? {
        action: converged && from.webhookTask && String(from.webhookTask).includes('t3tots-forward')
          ? 'skip-already-forwarder'
          : 'set-webhook',
        target: 'forwarder-loopback',
        // URL is computed at apply time only and never written to the plan record on disk in clear...
        // Actually plan may include a redacted form:
        urlRedacted: `http://127.0.0.1:<port>/inbox/${id}`,
        port: Number(forwarderPort) || DEFAULT_FORWARDER_PORT,
        recordAs: webhookLabelFor(target, id),
        instruction: 'apply pipes the loopback forwarder URL to inbox.mjs set-webhook on stdin; stdout is only the public success line',
      }
    : {
        action: 'operator-set-webhook',
        target: 't3-webhook-task',
        urlRedacted: null,
        recordAs: null,
        instruction:
          'Create schedule_task {type:webhook} bound to the new orchestrator thread with prompt `/orchestration answers ' +
          id +
          '`. Pipe the secret URL to `node inbox.mjs set-webhook ' +
          id +
          '` in a local unrecorded terminal. Record only the new task id in campaign.json webhookTask.',
      };

  const recreate = target.kind === 'external'
    ? {
        webhook: 'forwarder loopback via set-webhook (no T3 webhook task)',
        patrol:
          'External scheduler or bot invokes PATROL.md / inbox.mjs on an interval; set patrolTask to an external label if desired, not a T3 task id',
        t3: 'Delete old T3 webhook/patrol/daily tasks listed under automations; do not create T3 webhook tasks for external mode',
      }
    : {
        webhook: 'new T3 schedule_task type=webhook bound to new thread',
        patrol:
          'new T3 schedule_task type=interval everyMs=3600000 prompt `/orchestration patrol ' +
          id +
          '` bound to new thread; record id in patrolTask',
        t3: 'After delete of old tasks, create webhook+patrol on the new orchestrator thread; match discussion-tier model via t3_thread_configuration',
      };

  const forwarder = target.kind === 'external'
    ? forwarderAcceptance({ home, campaignId: id, campaignDir })
    : {
        ok: true,
        reasons: [],
        check: 'n/a for t3-thread',
        note: 'Forwarder only serves external campaigns',
      };

  // Predicted post-apply forwarder gate (kind will be external).
  let forwarderAfter = forwarder;
  if (target.kind === 'external') {
    forwarderAfter = {
      ...forwarderAcceptance({ home, campaignId: id, campaignDir }),
      // After apply, kind becomes external; registration still required.
      predictedOk: isCampaignRegistered(home, id) && /^[A-Za-z0-9._-]{1,64}$/.test(id),
      predictedNote: 'After apply, orchestratorKind becomes external; forwarder accepts when machine.json still lists this Campaign',
    };
  }

  const safe = blocks.length === 0;
  return {
    schema: 'orch-handoff-plan/1',
    command: 'plan',
    campaignId: id,
    campaignDir,
    handoffId: idForRecord,
    at: stamp(now),
    dryRun: true,
    converged,
    safe,
    blocks,
    ...(carryOverPending ? { carriedPending } : {}),
    from,
    to: target,
    changes: {
      campaignJson: {
        orchestratorKind: target.kind,
        orchestrator: target.kind === 't3-thread' ? target.threadId : null,
        orchestratorRef: target.kind === 'external' ? target.ref : null,
        reportEndpoint: target.kind === 'external' ? `label:${target.ref}` : null,
        webhookTask: webhook.recordAs,
        patrolTask: target.kind === 'external' ? null : '(new patrol task id after recreate)',
      },
      backupFile: path.join('handoffs', backupName),
      recordFile: path.join('handoffs', recordName),
      eventsLog: 'events.log',
      leaseProbe,
    },
    webhook,
    automations,
    recreate,
    reportTo,
    forwarderBefore: forwarder,
    forwarderAfterApply: forwarderAfter,
    mcpInstructions: {
      list: 'list_scheduled_tasks',
      delete: 'delete_scheduled_task',
      create: 'schedule_task',
      note: 'This CLI cannot call T3 MCP. Operator or orchestrator runs the listed tool calls. Never paste webhook URLs into chat or campaign.json.',
      enumerate: automations.enumerateInstructions,
      deleteKnown: automations.known
        .filter(a => a.kind === 't3-scheduled-task')
        .map(a => ({ tool: 'delete_scheduled_task', scheduledTaskId: a.taskId, role: a.role })),
      recreateSteps: recreate,
    },
    refusal: safe
      ? null
      : {
          message: 'handoff refused: unsafe or incomplete preconditions',
          blocks,
        },
  };
}

function appendEvent(campaignDir, line) {
  const file = path.join(campaignDir, 'events.log');
  fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
}

function acquireLock(campaignDir) {
  const dir = path.join(campaignDir, 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.apply.lock');
  const fd = fs.openSync(lock, 'wx');
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  return () => {
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  };
}

async function runSetWebhook({ home, campaignId, url, inboxMain, fetchImpl }) {
  if (typeof inboxMain === 'function') {
    const chunks = [];
    const result = await inboxMain(['set-webhook', campaignId], {
      home,
      input: (async function* () { yield url; })(),
      output: { write: s => chunks.push(s), isTTY: false },
      fetchImpl,
    });
    return { ok: true, result, stdout: chunks.join('') };
  }
  return spawnSetWebhook(home, campaignId, url);
}

function spawnSetWebhook(home, campaignId, url) {
  const inboxPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'inbox-web', 'inbox.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [inboxPath, 'set-webhook', campaignId], {
      env: { ...process.env, INBOX_HOME: home, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else reject(new Error(stderr.trim() || 'set-webhook failed'));
    });
    child.stdin.write(url);
    child.stdin.end();
  });
}

function publicPlan(plan) {
  // Plans already use urlRedacted and never embed secrets; clone for caller isolation.
  return JSON.parse(JSON.stringify(plan));
}

function resolveHandoffPath(campaignDir, maybeRelative) {
  if (!maybeRelative) return null;
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(campaignDir, maybeRelative);
}

export async function applyHandoff(opts) {
  const plan = buildPlan(opts);
  const {
    home,
    campaignDir,
    target,
    now = Date.now,
    forwarderPort = DEFAULT_FORWARDER_PORT,
    setWebhookImpl,
    inboxMain,
    fetchImpl,
    skipWebhook = false,
  } = opts;

  const campaignPath = path.join(campaignDir, 'campaign.json');
  const before = readJson(campaignPath, null);
  const from = currentOrchestratorState(before);

  if (plan.converged) {
    // Idempotent success: already at target — no writes, even if other warnings exist.
    const acceptance = target.kind === 'external'
      ? forwarderAcceptance({ home, campaignId: plan.campaignId, campaignDir })
      : { ok: true, reasons: [], check: 'n/a' };
    return {
      schema: 'orch-handoff-result/1',
      ok: true,
      converged: true,
      handoffId: null,
      campaignId: plan.campaignId,
      from,
      to: target,
      forwarderAcceptance: acceptance,
      warnings: plan.blocks,
      message: 'already at target; no campaign.json write',
      instructionsPath: null,
      recordPath: null,
    };
  }

  if (!plan.safe) {
    const err = new Error(plan.refusal.message);
    err.code = 'HANDOFF_REFUSED';
    err.plan = publicPlan(plan);
    throw err;
  }

  const release = acquireLock(campaignDir);
  try {
    const handoffsDir = path.join(campaignDir, 'handoffs');
    fs.mkdirSync(handoffsDir, { recursive: true });
    const backupRel = plan.changes.backupFile; // handoffs/…
    const recordRel = plan.changes.recordFile;
    const backupPath = resolveHandoffPath(campaignDir, backupRel);
    const recordPath = resolveHandoffPath(campaignDir, recordRel);
    // Atomic backup before mutating campaign.json
    atomicJson(backupPath, before);

    let webhookTask = plan.webhook.recordAs;
    let webhookApplied = false;
    if (target.kind === 'external' && plan.webhook.action === 'set-webhook' && !skipWebhook) {
      const url = forwarderInboxUrl(plan.campaignId, forwarderPort);
      if (typeof setWebhookImpl === 'function') {
        await setWebhookImpl({ home, campaignId: plan.campaignId, url });
      } else if (typeof inboxMain === 'function') {
        await runSetWebhook({ home, campaignId: plan.campaignId, url, inboxMain, fetchImpl });
      } else {
        await spawnSetWebhook(home, plan.campaignId, url);
      }
      webhookApplied = true;
      // Never retain url beyond this block.
    }

    if (target.kind === 't3-thread') {
      webhookTask = before.webhookTask ?? null; // operator replaces after creating task
    }

    const next = nextCampaignFields(before, target, {
      webhookTask: target.kind === 'external' ? webhookTask : before.webhookTask ?? null,
      patrolTask: target.kind === 'external' ? null : before.patrolTask ?? null,
    });
    atomicJson(campaignPath, next);

    const record = {
      schema: 'orch-handoff-record/1',
      handoffId: plan.handoffId,
      at: stamp(now),
      campaignId: plan.campaignId,
      from,
      to: target,
      backupFile: backupRel,
      recordFile: recordRel,
      webhookApplied,
      webhookTaskRecorded: next.webhookTask,
      automations: plan.automations,
      reportTo: plan.reportTo,
      ...(plan.carriedPending ? { carriedPending: plan.carriedPending } : {}),
      mcpInstructions: plan.mcpInstructions,
      revert: {
        restoreCampaignJsonFrom: backupRel,
        restoreFields: {
          orchestratorKind: from.kind,
          orchestrator: from.threadId,
          orchestratorRef: from.ref,
          reportEndpoint: from.reportEndpoint,
          webhookTask: from.webhookTask,
          patrolTask: from.patrolTask,
        },
        webhook:
          from.kind === 'external'
            ? {
                action: 'set-webhook-forwarder',
                recordAs: from.webhookTask,
                instruction: 'Re-pipe forwarder loopback URL to set-webhook if still external after restore',
              }
            : {
                action: 'operator-set-webhook',
                recordAs: from.webhookTask,
                instruction:
                  'Exact campaign.json restore is automatic. Private Inbox webhook URL for t3-thread is operator follow-up: recreate T3 webhook task and set-webhook; record task id only.',
              },
      },
    };
    atomicJson(recordPath, record);
    atomicJson(path.join(handoffsDir, 'latest.json'), {
      handoffId: plan.handoffId,
      at: record.at,
      recordFile: recordRel,
      backupFile: backupRel,
      to: target.label || `${target.kind}:${target.ref || target.threadId}`,
    });

    appendEvent(
      campaignDir,
      `${stamp(now)} handoff apply ${plan.campaignId} ${from.kind}->${target.kind} id=${plan.handoffId} evidence=${recordRel}`,
    );

    const instructionsRel = path.join('handoffs', `${plan.handoffId}.instructions.md`);
    const instructionsPath = path.join(campaignDir, instructionsRel);
    fs.writeFileSync(instructionsPath, renderInstructions(plan, record), 'utf8');

    const acceptance = target.kind === 'external'
      ? forwarderAcceptance({ home, campaignId: plan.campaignId, campaignDir })
      : { ok: true, reasons: [], check: 'n/a' };

    return {
      schema: 'orch-handoff-result/1',
      ok: true,
      converged: false,
      handoffId: plan.handoffId,
      campaignId: plan.campaignId,
      from,
      to: target,
      backupFile: backupRel,
      recordPath: recordRel,
      instructionsPath: instructionsRel,
      webhookApplied,
      forwarderAcceptance: acceptance,
      pendingOperatorWork: {
        deleteScheduledTasks: plan.mcpInstructions.deleteKnown,
        enumerate: plan.mcpInstructions.enumerate,
        recreate: plan.recreate,
        reportToCount: plan.reportTo.length,
      },
    };
  } finally {
    release();
  }
}

function renderInstructions(plan, record) {
  const lines = [];
  lines.push(`# Orchestrator handoff ${record.handoffId}`);
  lines.push('');
  lines.push(`Campaign: ${plan.campaignId}`);
  lines.push(`From: ${plan.from.kind}${plan.from.ref ? ':' + plan.from.ref : ''}${plan.from.threadId ? ':' + plan.from.threadId : ''}`);
  lines.push(`To: ${plan.to.kind}${plan.to.ref ? ':' + plan.to.ref : ''}${plan.to.threadId ? ':' + plan.to.threadId : ''}`);
  lines.push('');
  lines.push('## T3 scheduled tasks');
  lines.push('This CLI does not call T3 MCP. Run:');
  lines.push('1. list_scheduled_tasks');
  for (const step of plan.mcpInstructions.enumerate) lines.push(`   - ${step}`);
  lines.push('2. delete_scheduled_task for each stale id. Known ids from campaign.json:');
  for (const row of plan.mcpInstructions.deleteKnown) {
    lines.push(`   - ${row.scheduledTaskId} (${row.role})`);
  }
  if (!plan.mcpInstructions.deleteKnown.length) lines.push('   - (none recorded as T3 task ids)');
  lines.push('3. Recreate if target is t3-thread:');
  lines.push(`   - webhook: ${plan.recreate.webhook}`);
  lines.push(`   - patrol: ${plan.recreate.patrol}`);
  lines.push(`   - notes: ${plan.recreate.t3}`);
  if (plan.webhook?.instruction) {
    lines.push('4. Webhook bind:');
    lines.push(`   - action: ${plan.webhook.action}`);
    lines.push(`   - ${plan.webhook.instruction}`);
    if (plan.webhook.recordAs) lines.push(`   - record webhookTask label/id only: ${plan.webhook.recordAs}`);
  }
  lines.push('');
  lines.push('## Report-to updates');
  lines.push('Steer running tickets (auto if idle; never queue; use scripts/worker-send.mjs resolve/verify); HK current-task steer/auto, new-matter queue with --hk-new-matter:');
  for (const row of plan.reportTo) {
    lines.push(`- ${row.ticket} thread=${row.threadId} mode=${row.sendMode}`);
    lines.push(`  ${row.messageOutline}`);
  }
  if (!plan.reportTo.length) lines.push('- (no live ticket threads)');
  lines.push('');
  lines.push('## Forwarder acceptance (external target)');
  lines.push(plan.forwarderAfterApply?.note || plan.forwarderBefore?.note || '');
  lines.push(`Check: ${plan.forwarderAfterApply?.check || ''}`);
  lines.push('');
  lines.push('## Revert');
  lines.push(`node handoff.mjs revert ${plan.campaignId} --handoff-id ${record.handoffId}`);
  lines.push('Never log webhook URLs or private orchestrator secrets.');
  lines.push('');
  return lines.join('\n');
}

export async function revertHandoff(opts) {
  const {
    home,
    campaignId,
    campaignDir: campaignDirOpt,
    handoffId: wantedId = null,
    now = Date.now,
    forwarderPort = DEFAULT_FORWARDER_PORT,
    setWebhookImpl,
    inboxMain,
    fetchImpl,
    skipWebhook = false,
  } = opts;

  const campaignDir = resolveCampaignDir({ home, campaignId, campaignDir: campaignDirOpt });
  const handoffsDir = path.join(campaignDir, 'handoffs');
  let recordRel;
  if (wantedId) {
    recordRel = path.join('handoffs', `${wantedId}.json`);
  } else {
    const latest = readJson(path.join(handoffsDir, 'latest.json'), null);
    if (!latest?.recordFile && !latest?.handoffId) throw new Error('没有可 revert 的 handoff 记录');
    recordRel = latest.recordFile || path.join('handoffs', `${latest.handoffId}.json`);
  }
  const recordPath = resolveHandoffPath(campaignDir, recordRel);
  const record = readJson(recordPath, null);
  if (!record || record.schema !== 'orch-handoff-record/1') throw new Error('handoff 记录不可读');

  const blocks = [];
  const campaign = readJson(path.join(campaignDir, 'campaign.json'), null);
  const safety = collectSafetyBlocks(campaign || {}, campaignDir, { allowOwnerBlocked: true });
  // On revert, still refuse pending inbox / locks, but allow owner-blocked tickets.
  for (const b of safety) {
    if (['pending-inbox', 'handoff-lock-held', 'awaiting-reports', 'unprocessed-tasks'].includes(b.code)) {
      blocks.push(b);
    }
  }
  if (blocks.length) {
    const err = new Error('revert refused: unsafe state');
    err.code = 'HANDOFF_REFUSED';
    err.blocks = blocks;
    throw err;
  }

  const release = acquireLock(campaignDir);
  try {
    const backupRel = record.backupFile || record.revert?.restoreCampaignJsonFrom;
    const backupPath = resolveHandoffPath(campaignDir, backupRel);
    if (!backupPath || !fs.existsSync(backupPath)) throw new Error('缺少 handoff 备份文件');
    const prior = readJson(backupPath, null);
    if (!prior) throw new Error('备份 campaign.json 不可读');

    // Restore exact prior document.
    atomicJson(path.join(campaignDir, 'campaign.json'), prior);

    let webhookRestored = false;
    const restoredKind = prior.orchestratorKind === 'external' ? 'external' : 't3-thread';
    if (restoredKind === 'external' && !skipWebhook) {
      const url = forwarderInboxUrl(record.campaignId || campaignId, forwarderPort);
      if (typeof setWebhookImpl === 'function') {
        await setWebhookImpl({ home, campaignId: record.campaignId || campaignId, url });
        webhookRestored = true;
      } else if (typeof inboxMain === 'function') {
        await runSetWebhook({ home, campaignId: record.campaignId || campaignId, url, inboxMain, fetchImpl });
        webhookRestored = true;
      } else {
        try {
          await spawnSetWebhook(home, record.campaignId || campaignId, url);
          webhookRestored = true;
        } catch (error) {
          // Leave instruction for operator; campaign.json already restored.
          webhookRestored = false;
          record.revertWebhookError = 'set-webhook-failed-public';
        }
      }
    }

    appendEvent(
      campaignDir,
      `${stamp(now)} handoff revert ${record.campaignId || campaignId} id=${record.handoffId} webhookRestored=${webhookRestored} evidence=${recordRel}`,
    );

    atomicJson(path.join(handoffsDir, `revert-${record.handoffId}.json`), {
      schema: 'orch-handoff-revert/1',
      handoffId: record.handoffId,
      at: stamp(now),
      restoredFrom: backupRel,
      webhookRestored,
      note: restoredKind === 't3-thread'
        ? 'Restored campaign.json exactly; private Inbox webhook for t3-thread is operator follow-up (recreate schedule_task + set-webhook)'
        : 'Restored campaign.json; forwarder loopback set-webhook attempted when possible',
    });

    return {
      schema: 'orch-handoff-result/1',
      ok: true,
      reverted: true,
      handoffId: record.handoffId,
      campaignId: record.campaignId || campaignId,
      webhookRestored,
      restoredKind,
      message: 'campaign.json restored from handoff backup',
    };
  } finally {
    release();
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const {
    home = process.env.INBOX_HOME || os.homedir(),
    output = process.stdout,
    now = Date.now,
    setWebhookImpl,
    inboxMain,
    fetchImpl,
    skipWebhook = false,
    leaseStatus: leaseStatusOpt = null,
  } = options;

  const { command, campaignId, flags } = parseArgv(argv);
  const campaignDir = resolveCampaignDir({
    home,
    campaignId,
    campaignDir: flags['campaign-dir'],
  });

  const leaseStatus = await resolveLeaseStatus({
    leasesFile: flags['leases-file'] || null,
    projectFile: flags.project || null,
    leaseStatus: leaseStatusOpt,
  });
  const allowOwnerBlocked = Boolean(flags.allowOwnerBlocked);
  const common = {
    home,
    campaignId,
    campaignDir,
    allowOwnerBlocked,
    carryOverPending: Boolean(flags.carryOverPending),
    forwarderPort: flags['forwarder-port'] || DEFAULT_FORWARDER_PORT,
    scheduledTasksFile: flags['scheduled-tasks-file'] || null,
    leaseStatus,
    now,
  };

  if (command === 'plan') {
    const target = parseTarget(flags.to);
    const plan = buildPlan({ ...common, target });
    // Audit line only (no other plan writes). Safe and refused plans both log.
    appendEvent(
      campaignDir,
      `${stamp(now)} handoff plan ${plan.campaignId} ->${target.kind} safe=${plan.safe} converged=${plan.converged} id=${plan.handoffId}`,
    );
    output.write(`${JSON.stringify(publicPlan(plan), null, 2)}\n`);
    if (!plan.safe) {
      const err = new Error(plan.refusal.message);
      err.code = 'HANDOFF_REFUSED';
      err.exitCode = 2;
      throw err;
    }
    return plan;
  }

  if (command === 'apply') {
    const target = parseTarget(flags.to);
    const result = await applyHandoff({
      ...common,
      target,
      setWebhookImpl,
      inboxMain,
      fetchImpl,
      skipWebhook,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  // revert
  const result = await revertHandoff({
    home,
    campaignId,
    campaignDir,
    handoffId: flags['handoff-id'] || null,
    forwarderPort: flags['forwarder-port'] || DEFAULT_FORWARDER_PORT,
    setWebhookImpl,
    inboxMain,
    fetchImpl,
    skipWebhook,
    now,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = error?.message || String(error);
    // Never dump nested plan secrets; plans are public-shaped already.
    process.stderr.write(`${message}\n`);
    process.exitCode = error?.exitCode || error?.code === 'HANDOFF_REFUSED' ? 2 : 1;
  });
}
