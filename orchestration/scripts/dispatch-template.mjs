#!/usr/bin/env node
/**
 * Dispatch launch helpers (P35):
 * - t3_thread_launch title must be "id：short title" from campaign.json
 * - launch messages must include the Waiting and reporting / orch-report steps
 *
 * Owner basis (2026-10-29): sidebar titles like "my-campaign P34" violated the
 * naming rule; earlier tickets delivered without reporting because the launch
 * message omitted the report steps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from './cli-args.mjs';
import {
  TICKET_REF_SEP,
  formatTicketRef,
  requireCampaignTicketTitle,
  requireTicketId,
  requireTicketTitle,
} from './ticket-ref.mjs';

/** Milestone phases every launch message must name for orch-report/1 (base gate). */
export const REPORT_MILESTONE_PHASES = Object.freeze(['startup', 'blocker', 'delivery']);

/**
 * External-mode phases from EXTERNAL-ORCHESTRATOR.md report template.
 * `blocker` covers blocker/question; JSON may also use `decision`.
 */
export const EXTERNAL_REPORT_PHASES = Object.freeze(['startup', 'progress', 'blocker', 'delivery']);

/**
 * Canonical t3_thread_launch title: same string as ticketRef (`id：short title`).
 *
 * @param {unknown} id
 * @param {unknown} title
 * @returns {string}
 */
export function formatLaunchThreadTitle(id, title) {
  return formatTicketRef(id, title);
}

/**
 * Assert a proposed launch title is exactly `id：non-empty short title`
 * (full-width colon, non-empty id prefix, non-empty description).
 *
 * @param {unknown} value
 * @returns {{ ticket: string, title: string, threadTitle: string }}
 */
export function assertLaunchThreadTitle(value) {
  if (typeof value !== 'string' || !value.trim()) {
    const err = new Error('t3_thread_launch title is required (id：short title)');
    err.code = 'LAUNCH_TITLE_REQUIRED';
    throw err;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  const sep = text.indexOf(TICKET_REF_SEP);
  // Full-width colon required. Half-width "P35: spec", bare ids, and campaign-id
  // styles like "my-campaign P34" fail here (no TICKET_REF_SEP).
  if (sep < 0) {
    const err = new Error(
      `t3_thread_launch title must be id${TICKET_REF_SEP}short title (full-width colon); got ${JSON.stringify(text)}`,
    );
    err.code = 'LAUNCH_TITLE_FORMAT';
    throw err;
  }
  const ticket = requireTicketId(text.slice(0, sep), 'launch title id');
  // Empty / whitespace-only description → TICKET_TITLE_REQUIRED (not format).
  const short = requireTicketTitle(text.slice(sep + TICKET_REF_SEP.length), 'launch title description');
  if (/\s/.test(ticket)) {
    const err = new Error('launch title id must not contain spaces');
    err.code = 'LAUNCH_TITLE_FORMAT';
    throw err;
  }
  // Launch title ≡ ticketRef (formatTicketRef / TICKET_REF_SEP SSOT).
  return { ticket, title: short, threadTitle: formatLaunchThreadTitle(ticket, short) };
}

/**
 * Load campaign.json and return the launch title for a ticket.
 * Refuses missing/blank tickets[].title (same gate as route --ticket).
 *
 * @param {string} campaignDir
 * @param {unknown} ticketId
 * @returns {{ ticket: string, title: string, ticketRef: string, threadTitle: string }}
 */
export function requireLaunchThreadTitle(campaignDir, ticketId) {
  const meta = requireCampaignTicketTitle(campaignDir, ticketId);
  const threadTitle = formatLaunchThreadTitle(meta.ticket, meta.title);
  assertLaunchThreadTitle(threadTitle);
  return { ...meta, threadTitle };
}

/**
 * Markers a dispatch launch message must include so workers always report.
 * Deliberately string-based so both filled templates and the DISPATCH.md
 * source template (with `<placeholders>`) pass the same gate.
 */
export const DISPATCH_REPORT_STEP_REQUIREMENTS = Object.freeze([
  {
    id: 'section',
    code: 'DISPATCH_REPORT_SECTION',
    test: text => /waiting and reporting|等待与回报/i.test(text),
    hint: 'include a "Waiting and reporting" (or 等待与回报) section',
  },
  {
    id: 'schema',
    code: 'DISPATCH_REPORT_SCHEMA',
    test: text => /orch-report\/1/.test(text),
    hint: 'name schema orch-report/1',
  },
  {
    id: 'phases',
    code: 'DISPATCH_REPORT_PHASES',
    test: text => REPORT_MILESTONE_PHASES.every(p => new RegExp(`\\b${p}\\b`, 'i').test(text)),
    hint: `name phases ${REPORT_MILESTONE_PHASES.join('/')}`,
  },
  {
    id: 'report-cli',
    code: 'DISPATCH_REPORT_CLI',
    test: text => /report\.mjs/.test(text),
    hint: 'include report.mjs send command',
  },
]);

/**
 * Extra markers required when orchestratorKind is external.
 * SSOT text: EXTERNAL-ORCHESTRATOR.md "External mode report template".
 * Four phases (startup/progress/blocker/delivery), report.mjs, and verify.
 */
export const EXTERNAL_REPORT_TEMPLATE_REQUIREMENTS = Object.freeze([
  {
    id: 'external-phases',
    code: 'EXTERNAL_REPORT_PHASES',
    test: text => EXTERNAL_REPORT_PHASES.every(p => new RegExp(`\\b${p}\\b`, 'i').test(text)),
    hint: `name external phases ${EXTERNAL_REPORT_PHASES.join('/')} (blocker covers question)`,
  },
  // report.mjs send is already required by base DISPATCH_REPORT_STEP_REQUIREMENTS (report-cli).
  {
    id: 'external-verify',
    code: 'EXTERNAL_REPORT_VERIFY',
    // Documented receive path is `report.mjs verify` (or zh 校验/验证). Bare English "verify" alone is too loose.
    test: text => /report\.mjs\s+verify|校验|验证/i.test(text),
    hint: 'include report.mjs verify (orchestrator receive check) explanation',
  },
]);

/**
 * Resolve orchestrator kind from an explicit value or campaign.json.
 * @param {{ orchestratorKind?: unknown, campaignDir?: unknown }} [opts]
 * @returns {'external'|'t3-thread'|null}
 */
export function resolveOrchestratorKind(opts = {}) {
  const raw = opts.orchestratorKind;
  if (raw === 'external' || raw === 't3-thread') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const v = raw.trim().toLowerCase();
    if (v === 'external') return 'external';
    if (v === 't3-thread' || v === 't3') return 't3-thread';
  }
  const dir = opts.campaignDir;
  if (dir) {
    try {
      const file = path.join(path.resolve(String(dir)), 'campaign.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data?.orchestratorKind === 'external' ? 'external' : 't3-thread';
    } catch {
      const err = new Error(`cannot read orchestratorKind from campaign.json at ${dir}`);
      err.code = 'CAMPAIGN_KIND_UNREADABLE';
      throw err;
    }
  }
  return null;
}

/**
 * Validate that a launch / continuation message carries the reporting steps.
 * Throws Error with code DISPATCH_REPORT_* / EXTERNAL_REPORT_* when missing.
 *
 * @param {unknown} message
 * @param {{ orchestratorKind?: unknown, campaignDir?: unknown }} [opts]
 *   When kind resolves to `external`, also require EXTERNAL-ORCHESTRATOR.md
 *   template markers (four phases including progress, report.mjs, verify).
 * @returns {{ ok: true, orchestratorKind: string|null }}
 */
export function assertDispatchMessageReportSteps(message, opts = {}) {
  if (typeof message !== 'string' || !message.trim()) {
    const err = new Error('dispatch message is required for report-step validation');
    err.code = 'DISPATCH_MESSAGE_REQUIRED';
    throw err;
  }
  const text = message;
  const kind = resolveOrchestratorKind(opts);
  const reqs = [...DISPATCH_REPORT_STEP_REQUIREMENTS];
  if (kind === 'external') reqs.push(...EXTERNAL_REPORT_TEMPLATE_REQUIREMENTS);
  const missing = [];
  for (const req of reqs) {
    if (!req.test(text)) missing.push(req);
  }
  if (missing.length) {
    const err = new Error(
      `dispatch message missing report steps: ${missing.map(m => m.id).join(', ')} (${missing.map(m => m.hint).join('; ')})`,
    );
    err.code = missing[0].code;
    err.missing = missing.map(m => m.id);
    err.orchestratorKind = kind;
    throw err;
  }
  return { ok: true, orchestratorKind: kind };
}

const HARNESS_WAIT_CLAUSE = '<keep the line for this harness> Claude Code: after starting native background subagents or background commands, end the turn and say what you wait for; their completion wakes this thread. | Pi, Cursor, other: native subagent and background completion do not wake an ended turn, so wait in this turn and end only at delivery, a blocker, or a decision wait. Every wait call (harness wait, t3_thread_wait, task_status) waits at most about 60 seconds; never sleep, so steer can land between calls. Both: wait for review children with t3_thread_wait in slices of at most about 60 seconds; subagents return only after their work has finished and been checked, never right after starting a script.';

const DELIVERY_NOTES_CLAUSE = 'Put intermediate review/test/revision progress on ticket/delivery files, not messages. Delivery includes branch, worktree, final commit, separate review conclusions, actual validation, unverified areas, artifact locations. Before delivery comment on the ticket with changes, verified and unverified areas. For a local Markdown tracker append a `## Delivery notes` section to the ticket on the execution branch.';

/**
 * Helper body for the Waiting and reporting launch section.
 * **Authoritative template text lives in DISPATCH.md** (launch §7 / discussion §6).
 * This helper fills common placeholders so a draft passes `check-message`; it is not
 * a second SSOT. Prefer copying DISPATCH.md and substituting paths/ids.
 * When `orchestratorKind` is `external`, emits one coherent section (harness + EXTERNAL
 * template body) — not the base phase list plus a second Waiting-and-reporting block.
 *
 * @param {{
 *   ticket?: string,
 *   title?: string,
 *   ticketRef?: string,
 *   campaignDir?: string,
 *   skillDir?: string,
 *   storageDir?: string,
 *   orchestratorKind?: 't3-thread'|'external'|string,
 *   orchestratorThreadId?: string,
 *   orchestratorRef?: string,
 *   resourceAdapter?: string,
 * }} [opts]
 * @returns {string}
 */
export function formatWaitingAndReportingSection(opts = {}) {
  const ticket = opts.ticket ? String(opts.ticket).trim() : '<id>';
  const title = opts.title ? String(opts.title).trim() : '<short title>';
  const ticketRef = opts.ticketRef
    || (opts.ticket && opts.title ? formatTicketRef(opts.ticket, opts.title) : `${ticket}${TICKET_REF_SEP}${title}`);
  const campaignDir = opts.campaignDir || '<absolute-campaign-dir>';
  const storageDir = opts.storageDir || opts.campaignDir || '<Campaign storage>';
  const skillDir = opts.skillDir || '<skill-dir>';
  const orchThread = opts.orchestratorThreadId || '<actual dispatching threadId>';
  const resources = opts.resourceAdapter || '<Campaign-pinned project resource adapter>';
  const kind = opts.orchestratorKind || '';

  // External: one coherent §7. Do not keep base-only phases and append a second heading.
  if (kind === 'external') {
    return [
      `7. Waiting and reporting (等待与回报): ${HARNESS_WAIT_CLAUSE}`,
      `Resources: read and use ${resources}; follow its acquisition/status/reporting contract.`,
      formatExternalReportTemplateSection({ ...opts, includeHeading: false }),
      DELIVERY_NOTES_CLAUSE,
    ].join('\n');
  }

  const reportSend = `node ${skillDir}/scripts/report.mjs --campaign-dir ${campaignDir} --file <report.json>`;
  const t3Note = `Also queue a three-to-five-line note with t3_thread_send mode=queue to orchestrator ${orchThread} that names this ticket as ${ticketRef}.`;
  const externalNote = `External Campaigns: follow the required external mode report template in EXTERNAL-ORCHESTRATOR.md (do not keep a second copy in DISPATCH). Orchestrator ref/thread for context: ${orchThread}.`;
  const modeNote = kind === 't3-thread' ? t3Note : `${t3Note} ${externalNote}`;

  return [
    `7. Waiting and reporting (等待与回报): ${HARNESS_WAIT_CLAUSE}`,
    `Resources: read and use ${resources}; follow its acquisition/status/reporting contract.`,
    `Only after startup verification (branch/worktree/HEAD), on blocker/decision, or validated delivery, write an orch-report/1 JSON under ${storageDir}/deliveries/${ticket}/reports/ with fields: schema "orch-report/1", campaign, ticket "${ticket}", title "${title}", phase one of startup|blocker|decision|delivery, threadId (this thread), summary (3–5 lines naming ${ticketRef}). Then send with: ${reportSend}.`,
    'Phases that must always be covered: startup, blocker, delivery (plus decision when asking the orchestrator). Do not skip delivery after a local candidate commit.',
    modeNote,
    DELIVERY_NOTES_CLAUSE,
  ].join('\n');
}

/**
 * Filled helper for the EXTERNAL-ORCHESTRATOR.md external mode report template.
 * **Authoritative template text lives in EXTERNAL-ORCHESTRATOR.md** — this is not a second SSOT.
 * Output passes `assertDispatchMessageReportSteps(..., { orchestratorKind: 'external' })`.
 * Set `includeHeading: false` when embedding under an existing §7 heading.
 *
 * @param {{
 *   ticket?: string,
 *   title?: string,
 *   ticketRef?: string,
 *   campaignDir?: string,
 *   skillDir?: string,
 *   storageDir?: string,
 *   orchestratorRef?: string,
 *   includeHeading?: boolean,
 * }} [opts]
 * @returns {string}
 */
export function formatExternalReportTemplateSection(opts = {}) {
  const ticket = opts.ticket ? String(opts.ticket).trim() : '<id>';
  const title = opts.title ? String(opts.title).trim() : '<short title>';
  const ticketRef = opts.ticketRef
    || (opts.ticket && opts.title ? formatTicketRef(opts.ticket, opts.title) : `${ticket}${TICKET_REF_SEP}${title}`);
  const campaignDir = opts.campaignDir || '<absolute-campaign-dir>';
  const storageDir = opts.storageDir || opts.campaignDir || '<Campaign storage>';
  const skillDir = opts.skillDir || '<skill-dir>';
  const ref = opts.orchestratorRef || '<orchestratorRef>';
  const includeHeading = opts.includeHeading !== false;
  const reportSend = `node ${skillDir}/scripts/report.mjs --campaign-dir ${campaignDir} --file <report.json>`;
  const reportVerify = `node ${skillDir}/scripts/report.mjs verify --campaign-dir ${campaignDir} --body-file <raw-body.txt> --headers-file <headers.json>`;

  const body = [
    'External orchestrator (see EXTERNAL-ORCHESTRATOR.md template; do not t3_thread_send reports).',
    `Name this ticket ${ticketRef} (id：short title) in every report.`,
    `Write orch-report/1 JSON under ${storageDir}/deliveries/${ticket}/reports/ with fields: schema "orch-report/1", campaign, ticket "${ticket}", title "${title}", phase, threadId (this thread), summary (3–5 lines).`,
    'Phases (four): startup (after branch/worktree/HEAD check), progress (optional checkpoint with evidence path), blocker or question (JSON phase blocker|decision), delivery (validated candidate + tests + reviews). Do not skip delivery.',
    `Send each report with: ${reportSend}.`,
    `Transport (paths/mechanism only, no URLs or secrets in messages): campaign reportEndpoint label:${ref} → private orchestrators/<ref>.json (queueOnly webhook) typically loopback path /report/<campaignId>; Inbox webhookTask label → private webhooks/<campaignId>.url typically loopback path /inbox/<campaignId>; external loopback forwarder verifies then wakes the agent.`,
    `Orchestrator after receive: run ${reportVerify} (wakeup only when ok); then check candidate SHA, clean working tree, tests with exit codes, and Standards/Spec review 0/0 plus delivery inventory before accepting.`,
  ];
  if (includeHeading) {
    body.unshift('Waiting and reporting (等待与回报) — external mode.');
  }
  return body.join('\n');
}

/**
 * CLI:
 *   dispatch-template.mjs title --campaign-dir <dir> --ticket <id>
 *   dispatch-template.mjs title --ticket <id> --title <short>
 *   dispatch-template.mjs check-message --file <path> | --message <text>
 *       [--orchestrator-kind external|t3-thread] [--campaign-dir <dir>]
 *   dispatch-template.mjs section [--ticket id --title short ...]
 *   dispatch-template.mjs external-section [--ticket id --title short ...]
 */
export async function main(argv = process.argv.slice(2), { output = process.stdout } = {}) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    output.write(
      [
        'usage:',
        '  dispatch-template.mjs title --campaign-dir <dir> --ticket <id>',
        '  dispatch-template.mjs title --ticket <id> --title <short>',
        '  dispatch-template.mjs check-message --file <path> [--orchestrator-kind external|t3-thread] [--campaign-dir <dir>]',
        '  dispatch-template.mjs check-message --message <text> [--orchestrator-kind external|t3-thread] [--campaign-dir <dir>]',
        '  dispatch-template.mjs section [--ticket <id> --title <short>] [--campaign-dir <dir>] [--skill-dir <dir>] [--orchestrator-kind external|t3-thread]',
        '  dispatch-template.mjs external-section [--ticket <id> --title <short>] [--campaign-dir <dir>] [--skill-dir <dir>] [--orchestrator-ref <ref>]',
        '',
        'Launch title is always id：short title. check-message refuses messages without orch-report steps;',
        'with --orchestrator-kind external (or campaign.json kind) also requires progress + verify markers.',
        '',
      ].join('\n'),
    );
    return { ok: true, help: true };
  }
  const flags = parseFlags(argv.slice(1));
  try {
    if (cmd === 'title') {
      let result;
      if (flags['campaign-dir'] || flags.campaignDir) {
        const dir = flags['campaign-dir'] || flags.campaignDir;
        result = requireLaunchThreadTitle(dir, flags.ticket);
      } else {
        const threadTitle = formatLaunchThreadTitle(flags.ticket, flags.title);
        result = { ...assertLaunchThreadTitle(threadTitle), ticketRef: threadTitle };
      }
      output.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return { ok: true, ...result };
    }
    if (cmd === 'check-message') {
      let message = flags.message;
      if (flags.file) {
        message = fs.readFileSync(path.resolve(String(flags.file)), 'utf8');
      }
      const kindOpts = {
        orchestratorKind: flags['orchestrator-kind'] || flags.orchestratorKind,
        campaignDir: flags['campaign-dir'] || flags.campaignDir,
      };
      const checked = assertDispatchMessageReportSteps(message, kindOpts);
      output.write(`${JSON.stringify({ ok: true, orchestratorKind: checked.orchestratorKind })}\n`);
      return { ok: true, orchestratorKind: checked.orchestratorKind };
    }
    if (cmd === 'section') {
      const kind = flags['orchestrator-kind'] || flags.orchestratorKind;
      const text = formatWaitingAndReportingSection({
        ticket: flags.ticket,
        title: flags.title,
        campaignDir: flags['campaign-dir'] || flags.campaignDir,
        skillDir: flags['skill-dir'] || flags.skillDir,
        orchestratorKind: kind,
        orchestratorThreadId: flags['orchestrator-thread-id'] || flags.orchestratorThreadId,
        orchestratorRef: flags['orchestrator-ref'] || flags.orchestratorRef,
      });
      // Self-check: generated section must pass the same gate (including external when set).
      assertDispatchMessageReportSteps(text, { orchestratorKind: kind || undefined });
      output.write(`${text}\n`);
      return { ok: true, text };
    }
    if (cmd === 'external-section') {
      const text = formatExternalReportTemplateSection({
        ticket: flags.ticket,
        title: flags.title,
        campaignDir: flags['campaign-dir'] || flags.campaignDir,
        skillDir: flags['skill-dir'] || flags.skillDir,
        orchestratorRef: flags['orchestrator-ref'] || flags.orchestratorRef,
      });
      assertDispatchMessageReportSteps(text, { orchestratorKind: 'external' });
      output.write(`${text}\n`);
      return { ok: true, text };
    }
    throw new Error(`unknown command ${cmd}`);
  } catch (error) {
    const body = {
      ok: false,
      reason: error.message,
      code: error.code || 'error',
      missing: error.missing,
      orchestratorKind: error.orchestratorKind,
    };
    output.write(`${JSON.stringify(body)}\n`);
    return body;
  }
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
