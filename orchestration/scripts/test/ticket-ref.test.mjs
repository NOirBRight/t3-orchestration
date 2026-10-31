import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TICKET_REF_SEP,
  formatTicketRef,
  formatTicketRefFrom,
  formatTicketReportLine,
  requireTicketTitle,
  requireCampaignTicketTitle,
  assertReportTicketTitle,
  looksLikeTicketRef,
  main as ticketRefMain,
} from '../ticket-ref.mjs';

test('formatTicketRef joins id and title with full-width colon', () => {
  assert.equal(formatTicketRef('P33', '工单与派单模板'), `P33${TICKET_REF_SEP}工单与派单模板`);
  assert.equal(formatTicketRef(' #42 ', '  Welcome page  '), `#42${TICKET_REF_SEP}Welcome page`);
});

test('formatTicketRef refuses blank title or id', () => {
  assert.throws(() => formatTicketRef('P33', ''), err => err.code === 'TICKET_TITLE_REQUIRED');
  assert.throws(() => formatTicketRef('P33', '   '), err => err.code === 'TICKET_TITLE_REQUIRED');
  assert.throws(() => formatTicketRef('', 'x'), err => err.code === 'TICKET_ID_REQUIRED');
  assert.throws(() => requireTicketTitle(null), err => err.code === 'TICKET_TITLE_REQUIRED');
});

test('formatTicketRefFrom reads ticket+title rows', () => {
  assert.equal(
    formatTicketRefFrom({ ticket: 'P1', title: 'toolchain' }),
    `P1${TICKET_REF_SEP}toolchain`,
  );
  assert.throws(() => formatTicketRefFrom({ ticket: 'P1' }), err => err.code === 'TICKET_TITLE_REQUIRED');
});

test('assertReportTicketTitle requires title with ticket and vice versa', () => {
  assert.doesNotThrow(() => assertReportTicketTitle({ ticket: 'P33', title: 'templates' }));
  assert.doesNotThrow(() => assertReportTicketTitle({ summary: 'no ticket' }));
  assert.throws(
    () => assertReportTicketTitle({ ticket: 'P33', summary: 'x' }),
    err => err.code === 'TICKET_TITLE_REQUIRED',
  );
  assert.throws(
    () => assertReportTicketTitle({ title: 'only title' }),
    err => err.code === 'TICKET_ID_REQUIRED',
  );
});

test('formatTicketReportLine and looksLikeTicketRef', () => {
  assert.equal(
    formatTicketReportLine({ ticket: 'P33', title: 'templates', phase: 'startup', summary: 'ok' }),
    `P33${TICKET_REF_SEP}templates — startup — ok`,
  );
  assert.equal(looksLikeTicketRef('P33：templates'), true);
  assert.equal(looksLikeTicketRef('P33:templates'), false); // half-width colon is not SSOT
  assert.equal(looksLikeTicketRef('P33'), false);
});

test('requireCampaignTicketTitle reads campaign.json and refuses blank title', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ticket-ref-camp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
    id: 'c',
    tickets: [
      { ticket: 'P33', title: 'templates', stage: '执行中' },
      { ticket: 'P1', title: '   ', stage: '执行中' },
    ],
  }));
  assert.deepEqual(requireCampaignTicketTitle(dir, 'P33'), {
    ticket: 'P33',
    title: 'templates',
    ticketRef: `P33${TICKET_REF_SEP}templates`,
  });
  assert.throws(() => requireCampaignTicketTitle(dir, 'P1'), err => err.code === 'TICKET_TITLE_REQUIRED');
  assert.throws(() => requireCampaignTicketTitle(dir, 'P99'), err => err.code === 'TICKET_NOT_FOUND');
});

test('CLI format refuses missing title', async () => {
  const chunks = [];
  const out = { write: s => chunks.push(s) };
  const bad = await ticketRefMain(['format', '--ticket', 'P33', '--title', ''], { output: out });
  assert.equal(bad.ok, false);
  assert.match(chunks.join(''), /title/i);

  chunks.length = 0;
  const good = await ticketRefMain(
    ['format', '--ticket', 'P33', '--title', '工单模板'],
    { output: out },
  );
  assert.equal(good.ok, true);
  assert.equal(chunks.join('').trim(), `P33${TICKET_REF_SEP}工单模板`);
});
