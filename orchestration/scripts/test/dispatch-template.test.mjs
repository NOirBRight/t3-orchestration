import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICKET_REF_SEP } from '../ticket-ref.mjs';
import {
  REPORT_MILESTONE_PHASES,
  EXTERNAL_REPORT_PHASES,
  formatLaunchThreadTitle,
  assertLaunchThreadTitle,
  requireLaunchThreadTitle,
  assertDispatchMessageReportSteps,
  formatWaitingAndReportingSection,
  formatExternalReportTemplateSection,
  resolveOrchestratorKind,
  main as dispatchMain,
} from '../dispatch-template.mjs';

test('formatLaunchThreadTitle is id：short title with full-width colon', () => {
  assert.equal(
    formatLaunchThreadTitle('P35', '派单线程标题与回报步骤'),
    `P35${TICKET_REF_SEP}派单线程标题与回报步骤`,
  );
  assert.equal(formatLaunchThreadTitle('P34', 'spec'), `P34${TICKET_REF_SEP}spec`);
});

test('assertLaunchThreadTitle accepts good form and refuses bad titles', () => {
  const ok = assertLaunchThreadTitle('P35：派单线程标题与回报步骤');
  assert.equal(ok.ticket, 'P35');
  assert.equal(ok.title, '派单线程标题与回报步骤');
  assert.equal(ok.threadTitle, `P35${TICKET_REF_SEP}派单线程标题与回报步骤`);

  assert.throws(() => assertLaunchThreadTitle(''), err => err.code === 'LAUNCH_TITLE_REQUIRED');
  assert.throws(() => assertLaunchThreadTitle('P35'), err => err.code === 'LAUNCH_TITLE_FORMAT');
  assert.throws(() => assertLaunchThreadTitle('P35: half width'), err => err.code === 'LAUNCH_TITLE_FORMAT');
  assert.throws(() => assertLaunchThreadTitle('my-campaign P34'), err => err.code === 'LAUNCH_TITLE_FORMAT');
  assert.throws(() => assertLaunchThreadTitle('P35：'), err => err.code === 'TICKET_TITLE_REQUIRED');
  assert.throws(() => assertLaunchThreadTitle('P35：   '), err => err.code === 'TICKET_TITLE_REQUIRED');
  assert.throws(() => assertLaunchThreadTitle('：only title'), err => err.code === 'TICKET_ID_REQUIRED');
});

test('requireLaunchThreadTitle reads campaign.json and refuses blank title', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
    id: 'c',
    tickets: [
      { ticket: 'P35', title: '派单线程标题与回报步骤', stage: '执行中' },
      { ticket: 'P1', title: '  ', stage: '执行中' },
    ],
  }));
  const meta = requireLaunchThreadTitle(dir, 'P35');
  assert.equal(meta.threadTitle, `P35${TICKET_REF_SEP}派单线程标题与回报步骤`);
  assert.equal(meta.ticketRef, meta.threadTitle);
  assert.throws(() => requireLaunchThreadTitle(dir, 'P1'), err => err.code === 'TICKET_TITLE_REQUIRED');
  assert.throws(() => requireLaunchThreadTitle(dir, 'P99'), err => err.code === 'TICKET_NOT_FOUND');
});

test('assertDispatchMessageReportSteps requires section, schema, phases, report.mjs', () => {
  const good = [
    '7. Waiting and reporting: wait in this turn.',
    'Write orch-report/1 with phase startup, blocker, or delivery.',
    'node <skill-dir>/scripts/report.mjs --campaign-dir <dir> --file <f>',
  ].join('\n');
  assert.deepEqual(assertDispatchMessageReportSteps(good), { ok: true, orchestratorKind: null });

  assert.throws(
    () => assertDispatchMessageReportSteps(''),
    err => err.code === 'DISPATCH_MESSAGE_REQUIRED',
  );
  assert.throws(
    () => assertDispatchMessageReportSteps('Waiting and reporting only, no schema'),
    err => err.code === 'DISPATCH_REPORT_SCHEMA' || err.missing?.includes('schema'),
  );
  assert.throws(
    () => assertDispatchMessageReportSteps('Waiting and reporting\norch-report/1\nreport.mjs\nstartup delivery'),
    err => err.code === 'DISPATCH_REPORT_PHASES' || err.missing?.includes('phases'),
  );
  assert.throws(
    () => assertDispatchMessageReportSteps('Waiting and reporting\norch-report/1\nstartup blocker delivery'),
    err => err.code === 'DISPATCH_REPORT_CLI' || err.missing?.includes('report-cli'),
  );
  // Chinese section heading also accepted
  assert.doesNotThrow(() => assertDispatchMessageReportSteps(
    '等待与回报\norch-report/1\nstartup blocker delivery\nreport.mjs',
  ));
});

test('formatWaitingAndReportingSection passes its own gate and names all phases', () => {
  const text = formatWaitingAndReportingSection({
    ticket: 'P35',
    title: '派单线程标题与回报步骤',
    campaignDir: '/tmp/camp',
    skillDir: '/tmp/skill',
    orchestratorKind: 't3-thread',
  });
  assert.doesNotThrow(() => assertDispatchMessageReportSteps(text));
  for (const phase of REPORT_MILESTONE_PHASES) {
    assert.match(text, new RegExp(phase, 'i'));
  }
  assert.match(text, /orch-report\/1/);
  assert.match(text, /report\.mjs/);
  assert.match(text, /P35：派单线程标题与回报步骤/);
});

test('external mode check-message requires four phases, report.mjs, and verify', () => {
  const baseOnly = [
    'Waiting and reporting',
    'orch-report/1',
    'startup blocker delivery',
    'report.mjs --campaign-dir <dir> --file <f>',
  ].join('\n');
  // Base gate still passes without progress/verify.
  assert.deepEqual(assertDispatchMessageReportSteps(baseOnly), { ok: true, orchestratorKind: null });
  assert.throws(
    () => assertDispatchMessageReportSteps(baseOnly, { orchestratorKind: 'external' }),
    err => err.code === 'EXTERNAL_REPORT_PHASES' || err.missing?.includes('external-phases'),
  );

  const withProgressNoVerify = `${baseOnly}\nprogress checkpoint`;
  assert.throws(
    () => assertDispatchMessageReportSteps(withProgressNoVerify, { orchestratorKind: 'external' }),
    err => err.code === 'EXTERNAL_REPORT_VERIFY' || err.missing?.includes('external-verify'),
  );

  // Bare English "verify" (no report.mjs verify) must not satisfy the external receive-path gate.
  const bareVerify = [
    'Waiting and reporting',
    'orch-report/1',
    'startup progress blocker delivery',
    'report.mjs --file f',
    'please verify modelSelection before start',
  ].join('\n');
  assert.throws(
    () => assertDispatchMessageReportSteps(bareVerify, { orchestratorKind: 'external' }),
    err => err.code === 'EXTERNAL_REPORT_VERIFY' || err.missing?.includes('external-verify'),
  );

  const goodExternal = [
    'Waiting and reporting (等待与回报)',
    'orch-report/1 fields schema campaign ticket title phase threadId summary',
    'phases startup progress blocker delivery',
    'node skill/scripts/report.mjs --campaign-dir /c --file f.json',
    'orchestrator runs report.mjs verify then SHA clean tree tests reviews',
  ].join('\n');
  assert.deepEqual(
    assertDispatchMessageReportSteps(goodExternal, { orchestratorKind: 'external' }),
    { ok: true, orchestratorKind: 'external' },
  );

  // campaign.json kind auto-detect
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-ext-kind-'));
  try {
    fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
      id: 'c',
      orchestratorKind: 'external',
      orchestratorRef: 'lab',
      tickets: [{ ticket: 'P36', title: 'external template' }],
    }));
    assert.equal(resolveOrchestratorKind({ campaignDir: dir }), 'external');
    assert.throws(
      () => assertDispatchMessageReportSteps(baseOnly, { campaignDir: dir }),
      err => err.missing?.includes('external-phases') || err.code === 'EXTERNAL_REPORT_PHASES',
    );
    assert.doesNotThrow(() => assertDispatchMessageReportSteps(goodExternal, { campaignDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatExternalReportTemplateSection passes external gate and names transport path shapes', () => {
  const text = formatExternalReportTemplateSection({
    ticket: 'P36',
    title: 'external 模式回报方式写进技能并做成模板',
    campaignDir: '/tmp/camp',
    skillDir: '/tmp/skill',
    orchestratorRef: 't3tots-main',
  });
  assert.doesNotThrow(() => assertDispatchMessageReportSteps(text, { orchestratorKind: 'external' }));
  for (const phase of EXTERNAL_REPORT_PHASES) {
    assert.match(text, new RegExp('\\b' + phase + '\\b', 'i'));
  }
  assert.match(text, /orch-report\/1/);
  assert.match(text, /report\.mjs/);
  assert.match(text, /report\.mjs\s+verify/i);
  assert.match(text, /\/report\//); // loopback path shape
  assert.match(text, /\/inbox\//);
  assert.match(text, /orchestrators\//);
  assert.match(text, /webhooks\//);
  assert.match(text, /P36：external 模式回报方式写进技能并做成模板/);
  // no raw secrets
  assert.doesNotMatch(text, /signingSecret|https?:\/\/\d/);
});

test('formatWaitingAndReportingSection external kind is one coherent contract', () => {
  const text = formatWaitingAndReportingSection({
    ticket: 'P36',
    title: 'external template',
    campaignDir: '/tmp/camp',
    skillDir: '/tmp/skill',
    orchestratorKind: 'external',
    orchestratorRef: 'lab',
  });
  assert.doesNotThrow(() => assertDispatchMessageReportSteps(text, { orchestratorKind: 'external' }));
  // Single §7 heading line (zh+en on same line counts once as one numbered section).
  assert.equal([...text.matchAll(/^\s*\d*\.?\s*Waiting and reporting/gim)].length, 1);
  assert.match(text, /Phases \(four\):.*\bprogress\b/i);
  assert.match(text, /report\.mjs\s+verify/i);
  // Base-only phase enum without progress must not remain when kind is external.
  assert.doesNotMatch(text, /phase one of startup\|blocker\|decision\|delivery/);
  assert.doesNotMatch(text, /Phases that must always be covered: startup, blocker, delivery/);
});

test('CLI title and check-message', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
    id: 'c',
    tickets: [{ ticket: 'P35', title: 'thread title gate' }],
  }));
  const chunks = [];
  const out = { write: s => chunks.push(s) };

  const badTitle = await dispatchMain(['title', '--ticket', 'P35', '--title', ''], { output: out });
  assert.equal(badTitle.ok, false);

  chunks.length = 0;
  const goodTitle = await dispatchMain(
    ['title', '--campaign-dir', dir, '--ticket', 'P35'],
    { output: out },
  );
  assert.equal(goodTitle.ok, true);
  assert.equal(goodTitle.threadTitle, `P35${TICKET_REF_SEP}thread title gate`);

  const msgFile = path.join(dir, 'msg.txt');
  fs.writeFileSync(msgFile, 'no report steps here');
  chunks.length = 0;
  const badMsg = await dispatchMain(['check-message', '--file', msgFile], { output: out });
  assert.equal(badMsg.ok, false);

  const section = await dispatchMain(
    ['section', '--ticket', 'P35', '--title', 'thread title gate'],
    { output: out },
  );
  assert.equal(section.ok, true);
  fs.writeFileSync(msgFile, section.text);
  chunks.length = 0;
  const goodMsg = await dispatchMain(['check-message', '--file', msgFile], { output: out });
  assert.equal(goodMsg.ok, true);

  // external check-message on base section fails; external-section passes
  chunks.length = 0;
  const badExt = await dispatchMain(
    ['check-message', '--file', msgFile, '--orchestrator-kind', 'external'],
    { output: out },
  );
  assert.equal(badExt.ok, false);

  const extSection = await dispatchMain(
    ['external-section', '--ticket', 'P36', '--title', 'external template', '--orchestrator-ref', 'lab'],
    { output: out },
  );
  assert.equal(extSection.ok, true);
  fs.writeFileSync(msgFile, extSection.text);
  chunks.length = 0;
  const goodExt = await dispatchMain(
    ['check-message', '--file', msgFile, '--orchestrator-kind', 'external'],
    { output: out },
  );
  assert.equal(goodExt.ok, true);
  assert.equal(goodExt.orchestratorKind, 'external');
});

test('EXTERNAL-ORCHESTRATOR.md documents the required external template; DISPATCH links without a second copy', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const externalDoc = fs.readFileSync(path.join(root, 'EXTERNAL-ORCHESTRATOR.md'), 'utf8');
  const dispatchDoc = fs.readFileSync(path.join(root, 'DISPATCH.md'), 'utf8');
  assert.match(externalDoc, /External mode report template \(required\)/);
  for (const phase of EXTERNAL_REPORT_PHASES) {
    assert.match(externalDoc, new RegExp('\\b' + phase + '\\b', 'i'));
  }
  assert.match(externalDoc, /report\.mjs/);
  assert.match(externalDoc, /report\.mjs verify|verify/i);
  assert.match(externalDoc, /loopback/i);
  assert.match(externalDoc, /orchestrators\//);
  assert.match(externalDoc, /webhooks\//);
  assert.match(externalDoc, /\/report\//);
  assert.match(externalDoc, /\/inbox\//);
  assert.match(externalDoc, /clean working tree|clean tree/i);
  assert.match(externalDoc, /Standards\/Spec|review/i);
  assert.match(externalDoc, /id：short title/);
  // DISPATCH points at the template rather than duplicating the full contract
  assert.match(dispatchDoc, /EXTERNAL-ORCHESTRATOR\.md/);
  assert.match(dispatchDoc, /external mode report template|required template/i);
  assert.match(dispatchDoc, /do not paste a second copy|do not copy a second|link only|Link that section/i);
  // full private path inventory stays in EXTERNAL, not re-listed as a second SSOT block in DISPATCH
  assert.doesNotMatch(dispatchDoc, /private\/orchestrators\/<ref>\.json/);
});
