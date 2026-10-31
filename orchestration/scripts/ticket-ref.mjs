#!/usr/bin/env node
/**
 * Ticket display name: always "id：short title" (full-width colon).
 *
 * Owner basis (2026-10-29): every report, patrol note, Inbox message, and
 * dispatch/launch line that names a ticket uses this form. Bare ids are not
 * enough. title is required; missing/blank title is refused.
 *
 * Used by campaign-write (tickets[].title), orchestrator-target assertPublicReport,
 * and message templates documented in DISPATCH.md (report / worker-send lines).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from './cli-args.mjs';

/** Full-width colon between id and short title (owner wording “id：简短说明”). */
export const TICKET_REF_SEP = '：';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTicketTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} title
 * @param {string} [label]
 * @returns {string} trimmed non-empty title
 */
export function requireTicketTitle(title, label = 'title') {
  const text = normalizeTicketTitle(title);
  if (!text) {
    const err = new Error(`${label} is required (non-empty short description)`);
    err.code = 'TICKET_TITLE_REQUIRED';
    throw err;
  }
  return text;
}

/**
 * @param {unknown} id
 * @param {string} [label]
 * @returns {string}
 */
export function requireTicketId(id, label = 'ticket') {
  if (id == null) {
    const err = new Error(`${label} is required`);
    err.code = 'TICKET_ID_REQUIRED';
    throw err;
  }
  const text = String(id).trim();
  if (!text) {
    const err = new Error(`${label} is required`);
    err.code = 'TICKET_ID_REQUIRED';
    throw err;
  }
  return text;
}

/**
 * Format a ticket mention: `<id>：<short title>`.
 *
 * @param {unknown} id
 * @param {unknown} title
 * @returns {string}
 */
export function formatTicketRef(id, title) {
  const ticketId = requireTicketId(id);
  const short = requireTicketTitle(title);
  return `${ticketId}${TICKET_REF_SEP}${short}`;
}

/**
 * Build from a ticket-like object (`ticket`/`id` + `title`).
 *
 * @param {{ ticket?: unknown, id?: unknown, title?: unknown }|null|undefined} row
 * @returns {string}
 */
export function formatTicketRefFrom(row) {
  if (!row || typeof row !== 'object') {
    const err = new Error('ticket object required');
    err.code = 'TICKET_REF_REQUIRED';
    throw err;
  }
  const id = row.ticket != null ? row.ticket : row.id;
  return formatTicketRef(id, row.title);
}

/**
 * True when text already looks like `id：title` (full-width colon only).
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeTicketRef(text) {
  if (typeof text !== 'string') return false;
  // Full-width colon only (DISPATCH.md SSOT); half-width is not a valid ref.
  return /^.+?：.+\S/.test(text.trim());
}

/**
 * First line of a milestone report / worker message that names the ticket.
 * Example: `P33：工单与派单模板 — startup ok`
 *
 * @param {{ ticket: unknown, title: unknown, phase?: string, summary?: string }} input
 * @returns {string}
 */
export function formatTicketReportLine(input = {}) {
  const ref = formatTicketRef(input.ticket, input.title);
  const phase = typeof input.phase === 'string' && input.phase.trim()
    ? input.phase.trim()
    : '';
  const summary = typeof input.summary === 'string' && input.summary.trim()
    ? input.summary.replace(/\s+/g, ' ').trim()
    : '';
  const tail = [phase, summary].filter(Boolean).join(' — ');
  return tail ? `${ref} — ${tail}` : ref;
}

/**
 * Load campaign.json and require tickets[] row `ticketId` has non-empty title.
 * Used by `inbox.mjs route --ticket` before dispatch.
 *
 * @param {string} campaignDir
 * @param {unknown} ticketId
 * @returns {{ ticket: string, title: string, ticketRef: string }}
 */
export function requireCampaignTicketTitle(campaignDir, ticketId) {
  const id = requireTicketId(ticketId);
  const file = path.join(path.resolve(String(campaignDir || '')), 'campaign.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const err = new Error('campaign.json 不可读');
    err.code = 'CAMPAIGN_UNREADABLE';
    throw err;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.tickets)) {
    const err = new Error('campaign.json tickets missing');
    err.code = 'TICKET_NOT_FOUND';
    throw err;
  }
  const row = data.tickets.find(t => t && String(t.ticket) === id);
  if (!row) {
    const err = new Error(`ticket ${id} not found in campaign.json`);
    err.code = 'TICKET_NOT_FOUND';
    throw err;
  }
  const title = requireTicketTitle(row.title, `tickets[].title for ${id}`);
  return { ticket: id, title, ticketRef: formatTicketRef(id, title) };
}

/**
 * Validate public orch-report body fields related to ticket naming.
 * Call from assertPublicReport; returns void or throws Error with code.
 *
 * @param {{ ticket?: unknown, title?: unknown }} report
 */
export function assertReportTicketTitle(report) {
  if (!report || typeof report !== 'object') return;
  const hasTicket = report.ticket != null && String(report.ticket).trim() !== '';
  const hasTitle = normalizeTicketTitle(report.title) !== '';
  if (hasTicket && !hasTitle) {
    const err = new Error('title is required when ticket is set (use id：short title)');
    err.code = 'TICKET_TITLE_REQUIRED';
    throw err;
  }
  if (hasTitle && !hasTicket) {
    const err = new Error('ticket is required when title is set');
    err.code = 'TICKET_ID_REQUIRED';
    throw err;
  }
  if (hasTicket && hasTitle) {
    // Normalize path: ensure formatTicketRef would succeed.
    formatTicketRef(report.ticket, report.title);
  }
}

/**
 * CLI:
 *   ticket-ref.mjs format --ticket P33 --title '短说明'
 *   ticket-ref.mjs line --ticket P33 --title '短说明' [--phase startup] [--summary '…']
 */
export async function main(argv = process.argv.slice(2), { output = process.stdout } = {}) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    output.write(
      [
        'usage:',
        '  ticket-ref.mjs format --ticket <id> --title <short>',
        '  ticket-ref.mjs line --ticket <id> --title <short> [--phase <phase>] [--summary <text>]',
        '',
        'Prints id：short title. Refuses missing title.',
        '',
      ].join('\n'),
    );
    return { ok: true, help: true };
  }
  const flags = parseFlags(argv.slice(1));
  try {
    if (cmd === 'format') {
      const text = formatTicketRef(flags.ticket, flags.title);
      output.write(`${text}\n`);
      return { ok: true, text };
    }
    if (cmd === 'line') {
      const text = formatTicketReportLine({
        ticket: flags.ticket,
        title: flags.title,
        phase: flags.phase,
        summary: flags.summary,
      });
      output.write(`${text}\n`);
      return { ok: true, text };
    }
    throw new Error(`unknown command ${cmd}`);
  } catch (error) {
    const body = { ok: false, reason: error.message, code: error.code || 'error' };
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
