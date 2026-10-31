import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseTarget,
  parseArgv,
  buildPlan,
  applyHandoff,
  revertHandoff,
  forwarderAcceptance,
  forwarderInboxUrl,
  collectSafetyBlocks,
  main as handoffMain,
} from '../handoff.mjs';
import { atomicJson } from '../../inbox-web/config.mjs';

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeMachine(home, campaigns = []) {
  const root = path.join(home, '.agents', 'orchestration');
  fs.mkdirSync(path.join(root, 'private'), { recursive: true, mode: 0o700 });
  atomicJson(path.join(root, 'machine.json'), {
    name: 'test-machine',
    port: 8780,
    remotePort: 8781,
    lanTrustSubnet: false,
    remote: { type: 'none' },
    peers: [],
    campaigns,
  });
}

function privateOrch(home, ref = 't3tots-main') {
  const dir = path.join(home, '.agents', 'orchestration', 'private', 'orchestrators');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicJson(path.join(dir, `${ref}.json`), {
    type: 'webhook',
    url: 'http://127.0.0.1:9/orch',
    signingSecret: 'test-secret',
    queueOnly: true,
  }, true);
}

function fixtureCampaign(home, {
  id = 'throwaway-camp',
  kind = 't3-thread',
  register = true,
  tickets = [],
  inbox = null,
  awaitingReports = [],
  tasks = [],
  webhookTask = 'task-webhook-old',
  patrolTask = 'task-patrol-old',
  orchestrator = 'mcp:orch-thread-old',
  ref = 't3tots-main',
} = {}) {
  const dir = path.join(home, 'campaigns', id);
  fs.mkdirSync(dir, { recursive: true });
  const campaign = {
    id,
    campaign: 'throwaway',
    awaitingReports,
    tasks,
    orchestratorKind: kind,
    orchestrator: kind === 'external' ? null : orchestrator,
    orchestratorRef: kind === 'external' ? ref : null,
    reportEndpoint: kind === 'external' ? `label:${ref}` : null,
    webhookTask,
    patrolTask,
    tickets,
    updatedAt: '2026-01-01T00:00:00Z',
  };
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
  if (inbox) fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify(inbox, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'events.log'), '');
  writeMachine(home, register ? [{ id, dir }] : []);
  privateOrch(home, ref);
  return { dir, campaign };
}

test('parseTarget accepts external and t3-thread forms', () => {
  assert.deepEqual(parseTarget('external:t3tots-main'), {
    kind: 'external', ref: 't3tots-main', threadId: null, label: 'external:t3tots-main',
  });
  assert.equal(parseTarget('t3-thread:mcp:abc').threadId, 'mcp:abc');
  assert.equal(parseTarget('thread:mcp:xyz').kind, 't3-thread');
  assert.throws(() => parseTarget('external:bad label'), /标签/);
  assert.throws(() => parseTarget('t3-thread:https://evil'), /URL/);
  assert.throws(() => parseTarget('nope'), /--to/);
});

test('parseArgv requires plan|apply|revert shapes', () => {
  assert.equal(parseArgv(['plan', 'c', '--to', 'external:x']).command, 'plan');
  assert.throws(() => parseArgv(['plan', 'c']), /Usage|handoff/);
  assert.throws(() => parseArgv(['nope', 'c', '--to', 'external:x']), /handoff/);
});

test('plan is dry-run and refuses pending inbox + awaiting reports', t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {
    awaitingReports: ['P9'],
    inbox: {
      items: [
        { id: 'Q1', status: 'saved', answer: { choices: ['a'] } },
        { id: 'Q2', status: 'open' },
        { id: 'Q3', status: 'closed' },
      ],
      messages: [{ id: 'M1', status: 'saved' }],
    },
    tickets: [{ ticket: 'P1', stage: '执行中', thread: 'mcp:t1' }],
  });

  const plan = buildPlan({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('external:t3tots-main'),
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.safe, false);
  const codes = plan.blocks.map(b => b.code);
  assert.ok(codes.includes('awaiting-reports'));
  assert.ok(codes.includes('pending-inbox'));
  // plan did not mutate campaign kind
  const camp = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(camp.orchestratorKind, 't3-thread');
  assert.ok(!fs.existsSync(path.join(dir, 'handoffs')));
});

test('carry-over CLI preserves pending work and records complete IDs for the new orchestrator', async t => {
  const home = tempHome(t);
  const awaitingReports = Array.from({ length: 17 }, (_, i) => `P${i}`);
  const inbox = { items: [{ id: 'Q1', status: 'saved' }, { id: 'A1', status: 'notified' }, { id: 'A2', status: 'read' }], messages: [] };
  const { dir } = fixtureCampaign(home, { kind: 'external', awaitingReports, inbox, tickets: [{ ticket: 'P1', stage: '已交付', thread: 'mcp:worker' }] });
  const beforeInbox = fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8');
  const args = ['throwaway-camp', '--to', 't3-thread:mcp:new', '--campaign-dir', dir, '--carry-over-pending'];
  const options = { home, output: { write() {} } };
  const plan = await handoffMain(['plan', ...args], options);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.carriedPending, { awaitingReports, inboxItems: inbox.items });
  assert.equal(plan.reportTo[0].sendMode, 'steer');
  assert.equal(plan.reportTo[0].reportTo.threadId, 'mcp:new');
  const result = await handoffMain(['apply', ...args], options);
  const campaign = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json')));
  const record = JSON.parse(fs.readFileSync(path.join(dir, result.recordPath)));
  assert.deepEqual(campaign.awaitingReports, awaitingReports);
  assert.equal(fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8'), beforeInbox);
  assert.deepEqual(record.carriedPending, plan.carriedPending);
  assert.equal(record.reportTo[0].reportTo.threadId, 'mcp:new');
  assert.equal(record.mcpInstructions.recreateSteps.webhook, 'new T3 schedule_task type=webhook bound to new thread');
});

test('carry-over does not waive unrelated blockers or pending messages and withdrawals', t => {
  const home = tempHome(t);
  const { dir, campaign } = fixtureCampaign(home, { awaitingReports: ['P1'], tasks: [{ taskId: 'T1' }], inbox: { items: [{ id: 'Q1', status: 'saved', withdrawalPending: true }], messages: [{ id: 'M1', status: 'saved' }] } });
  const blocks = collectSafetyBlocks(campaign, dir, { carryOverPending: true, leaseStatus: [{ pool: 'device', pid: 5 }] });
  assert.deepEqual(blocks.find(b => b.code === 'pending-inbox').detail, { items: ['Q1'], messages: 1 });
  assert.ok(blocks.some(b => b.code === 'unprocessed-tasks'));
  assert.ok(blocks.some(b => b.code === 'active-leases'));
  assert.ok(!blocks.some(b => b.code === 'awaiting-reports'));
  assert.throws(() => parseArgv(['revert', 'c', '--carry-over-pending']), /only for plan\/apply/);
});

test('plan refuses active leases and missing private orchestrator', t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {});
  // remove private file
  fs.rmSync(path.join(home, '.agents', 'orchestration', 'private', 'orchestrators'), { recursive: true, force: true });

  const plan = buildPlan({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('external:t3tots-main'),
    leaseStatus: [{ pool: 'device', lane: 'a', pid: 1234 }],
  });
  const codes = plan.blocks.map(b => b.code);
  assert.ok(codes.includes('active-leases'));
  assert.ok(codes.includes('missing-private-orchestrator'));
});

test('CLI main loads --leases-file and refuses active leases without DI', async t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {});
  const leasesFile = path.join(home, 'leases.json');
  fs.writeFileSync(leasesFile, JSON.stringify([{ pool: 'device', lane: 'a', pid: 99, startedAt: '2026-01-01T00:00:00Z' }]));
  const out = [];
  await assert.rejects(
    () => handoffMain(
      ['plan', 'throwaway-camp', '--to', 'external:t3tots-main', '--campaign-dir', dir, '--leases-file', leasesFile],
      { home, output: { write: s => out.push(s) } },
    ),
    err => err.code === 'HANDOFF_REFUSED',
  );
  const text = out.join('');
  assert.match(text, /active-leases/);
  const events = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
  assert.match(events, /handoff plan/);
});

test('apply t3→external updates campaign.json atomically, backup, events, webhook mock', async t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {
    tickets: [
      { ticket: 'P1', stage: '执行中', thread: 'mcp:exec-1' },
      { ticket: 'P2', stage: '已合并', thread: 'mcp:exec-2' },
    ],
    webhookTask: 'old-wh-task',
    patrolTask: 'old-patrol-task',
  });

  const hooks = [];
  const result = await applyHandoff({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('external:t3tots-main'),
    setWebhookImpl: async ({ campaignId, url }) => {
      hooks.push({ campaignId, url });
    },
    now: () => Date.parse('2026-10-28T04:00:00Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.converged, false);
  assert.equal(result.webhookApplied, true);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].campaignId, 'throwaway-camp');
  assert.equal(hooks[0].url, 'http://127.0.0.1:8793/inbox/throwaway-camp');
  assert.doesNotMatch(JSON.stringify(result), /signingSecret|test-secret/);

  const camp = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(camp.orchestratorKind, 'external');
  assert.equal(camp.orchestrator, null);
  assert.equal(camp.orchestratorRef, 't3tots-main');
  assert.equal(camp.reportEndpoint, 'label:t3tots-main');
  assert.equal(camp.webhookTask, 'external:t3tots-forward (loopback /inbox/throwaway-camp)');
  assert.equal(camp.patrolTask, null);
  assert.doesNotMatch(JSON.stringify(camp), /127\.0\.0\.1:8793/);

  const backupAbs = path.isAbsolute(result.backupFile)
    ? result.backupFile
    : path.join(dir, result.backupFile);
  assert.ok(fs.existsSync(backupAbs));
  const backup = JSON.parse(fs.readFileSync(backupAbs, 'utf8'));
  assert.equal(backup.orchestratorKind, 't3-thread');
  assert.equal(backup.orchestrator, 'mcp:orch-thread-old');

  const events = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
  assert.match(events, /handoff apply throwaway-camp t3-thread->external/);

  const recordAbs = path.isAbsolute(result.recordPath)
    ? result.recordPath
    : path.join(dir, result.recordPath);
  const record = JSON.parse(fs.readFileSync(recordAbs, 'utf8'));
  assert.ok(!path.isAbsolute(record.backupFile));
  assert.equal(record.schema, 'orch-handoff-record/1');
  assert.equal(record.from.threadId, 'mcp:orch-thread-old');
  assert.ok(record.reportTo.some(r => r.ticket === 'P1'));
  assert.ok(!record.reportTo.some(r => r.ticket === 'P2'));
  assert.ok(record.mcpInstructions.deleteKnown.some(d => d.scheduledTaskId === 'old-wh-task'));
  assert.ok(record.mcpInstructions.deleteKnown.some(d => d.scheduledTaskId === 'old-patrol-task'));

  const acceptance = forwarderAcceptance({ home, campaignId: 'throwaway-camp', campaignDir: dir });
  assert.equal(acceptance.ok, true);
  assert.equal(result.forwarderAcceptance.ok, true);

  // idempotent re-apply
  const again = await applyHandoff({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('external:t3tots-main'),
    setWebhookImpl: async () => { throw new Error('should not set webhook again'); },
  });
  assert.equal(again.converged, true);
  assert.equal(again.ok, true);
});

test('apply refuses when not registered for external target', async t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, { register: false });
  await assert.rejects(
    () => applyHandoff({
      home,
      campaignId: 'throwaway-camp',
      campaignDir: dir,
      target: parseTarget('external:t3tots-main'),
      setWebhookImpl: async () => {},
    }),
    err => err.code === 'HANDOFF_REFUSED',
  );
  const camp = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(camp.orchestratorKind, 't3-thread');
});

test('revert restores exact prior campaign.json', async t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {
    webhookTask: 'wh-1',
    patrolTask: 'pt-1',
    orchestrator: 'mcp:old',
  });

  const hooks = [];
  const applied = await applyHandoff({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('external:t3tots-main'),
    setWebhookImpl: async args => { hooks.push(['apply', args.url]); },
  });

  const reverted = await revertHandoff({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    handoffId: applied.handoffId,
    setWebhookImpl: async args => { hooks.push(['revert', args.url]); },
  });
  assert.equal(reverted.ok, true);
  assert.equal(reverted.reverted, true);

  const camp = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(camp.orchestratorKind, 't3-thread');
  assert.equal(camp.orchestrator, 'mcp:old');
  assert.equal(camp.webhookTask, 'wh-1');
  assert.equal(camp.patrolTask, 'pt-1');
  assert.equal(camp.orchestratorRef, null);

  const events = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
  assert.match(events, /handoff revert/);
});

test('apply external→t3-thread emits operator webhook instructions without calling set-webhook', async t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {
    kind: 'external',
    webhookTask: 'external:t3tots-forward (loopback /inbox/throwaway-camp)',
    patrolTask: null,
  });
  let webhookCalls = 0;
  const result = await applyHandoff({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('t3-thread:mcp:new-orch'),
    setWebhookImpl: async () => { webhookCalls++; },
  });
  assert.equal(result.ok, true);
  assert.equal(webhookCalls, 0);
  const camp = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(camp.orchestratorKind, 't3-thread');
  assert.equal(camp.orchestrator, 'mcp:new-orch');
  assert.equal(camp.orchestratorRef, null);
  assert.equal(camp.reportEndpoint, null);
  const instructionsAbs = path.isAbsolute(result.instructionsPath)
    ? result.instructionsPath
    : path.join(dir, result.instructionsPath);
  const instructions = fs.readFileSync(instructionsAbs, 'utf8');
  assert.match(instructions, /schedule_task/);
  assert.match(instructions, /set-webhook/);
  assert.doesNotMatch(instructions, /signingSecret/);
});

test('forwarderAcceptance mirrors forwarder gate', t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, { kind: 't3-thread' });
  assert.equal(forwarderAcceptance({ home, campaignId: 'throwaway-camp', campaignDir: dir }).ok, false);
  const camp = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  camp.orchestratorKind = 'external';
  camp.orchestratorRef = 't3tots-main';
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify(camp, null, 2));
  assert.equal(forwarderAcceptance({ home, campaignId: 'throwaway-camp', campaignDir: dir }).ok, true);

  writeMachine(home, []); // unregister
  assert.ok(forwarderAcceptance({ home, campaignId: 'throwaway-camp', campaignDir: dir }).reasons.includes('not-registered'));
});

test('forwarderInboxUrl shape', () => {
  assert.equal(forwarderInboxUrl('abc', 8793), 'http://127.0.0.1:8793/inbox/abc');
  assert.throws(() => forwarderInboxUrl('../x'), /不合法/);
});

test('CLI plan/apply/revert via main()', async t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {});
  const out = [];
  const write = s => out.push(s);

  await handoffMain(
    ['plan', 'throwaway-camp', '--to', 'external:t3tots-main', '--campaign-dir', dir],
    { home, output: { write }, setWebhookImpl: async () => {} },
  );
  assert.match(out.join(''), /"dryRun": true/);

  out.length = 0;
  const applied = await handoffMain(
    ['apply', 'throwaway-camp', '--to', 'external:t3tots-main', '--campaign-dir', dir],
    {
      home,
      output: { write },
      setWebhookImpl: async () => {},
    },
  );
  assert.equal(applied.ok, true);

  out.length = 0;
  const reverted = await handoffMain(
    ['revert', 'throwaway-camp', '--campaign-dir', dir, '--handoff-id', applied.handoffId],
    { home, output: { write }, setWebhookImpl: async () => {}, skipWebhook: true },
  );
  assert.equal(reverted.reverted, true);

  // empty leases file (no holders) must not refuse
  out.length = 0;
  const emptyLeases = path.join(home, 'empty-leases.json');
  fs.writeFileSync(emptyLeases, JSON.stringify([{ pool: 'device', lane: 'a', pid: null }]));
  const planned = await handoffMain(
    ['plan', 'throwaway-camp', '--to', 'external:t3tots-main', '--campaign-dir', dir, '--leases-file', emptyLeases],
    { home, output: { write } },
  );
  assert.equal(planned.safe, true);
  assert.doesNotMatch(JSON.stringify(planned.blocks), /active-leases/);
});

test('collectSafetyBlocks ignores open/closed inbox items', t => {
  const home = tempHome(t);
  const { dir, campaign } = fixtureCampaign(home, {
    inbox: {
      items: [
        { id: 'Qopen', status: 'open' },
        { id: 'Qclosed', status: 'closed' },
        { id: 'Qfwd', status: 'forwarded' },
      ],
      messages: [],
    },
  });
  const blocks = collectSafetyBlocks(campaign, dir);
  assert.equal(blocks.find(b => b.code === 'pending-inbox'), undefined);
});

test('plan never embeds raw webhook URL', t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {});
  const plan = buildPlan({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('external:t3tots-main'),
  });
  const text = JSON.stringify(plan);
  assert.doesNotMatch(text, /http:\/\/127\.0\.0\.1:8793\/inbox/);
  assert.match(text, /urlRedacted/);
  assert.doesNotMatch(text, /test-secret|signingSecret/);
});

test('housekeeping report-to row defaults to current-task steer (not queue)', t => {
  const home = tempHome(t);
  const { dir } = fixtureCampaign(home, {});
  const campPath = path.join(dir, 'campaign.json');
  const camp = JSON.parse(fs.readFileSync(campPath, 'utf8'));
  camp.housekeeping = {
    enabled: true,
    threadId: 'mcp:hk-thread',
    countsTowardLimits: false,
  };
  camp.tickets = [{ ticket: '#1', title: 't', kind: '交付', stage: '执行中', thread: 'mcp:w1' }];
  fs.writeFileSync(campPath, JSON.stringify(camp, null, 2) + '\n');
  const plan = buildPlan({
    home,
    campaignId: 'throwaway-camp',
    campaignDir: dir,
    target: parseTarget('t3-thread:mcp:orch-new'),
  });
  const hk = plan.reportTo.find(r => r.ticket === 'housekeeping');
  assert.ok(hk);
  assert.equal(hk.sendMode, 'steer');
  assert.notEqual(hk.sendMode, 'queue');
  assert.match(String(hk.cursorException || ''), /hk-new-matter|worker-send/i);
  const worker = plan.reportTo.find(r => r.ticket === '#1');
  assert.equal(worker.sendMode, 'steer');
});
