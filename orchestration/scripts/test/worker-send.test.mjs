import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWorkerSendMode,
  buildThreadSendArgs,
  verifyWorkerDelivery,
  classifyRecipient,
  main as workerSendMain,
} from '../worker-send.mjs';

test('classify worker aliases', () => {
  assert.equal(classifyRecipient('execution'), 'worker');
  assert.equal(classifyRecipient('execution-ticket'), 'worker');
  assert.equal(classifyRecipient('HK'), 'housekeeping');
  assert.equal(classifyRecipient('orchestrator'), 'orchestrator');
});

test('running worker defaults to steer and refuses queue', () => {
  const ok = resolveWorkerSendMode({ recipientRole: 'worker', threadState: 'running' });
  assert.equal(ok.mode, 'steer');
  assert.equal(ok.ok, true);
  assert.equal(ok.refused, false);

  const refused = resolveWorkerSendMode({
    recipientRole: 'execution',
    threadState: 'running',
    requestedMode: 'queue',
  });
  assert.equal(refused.refused, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.mode, 'steer');
  assert.ok(refused.flags.includes('never-queue-worker'));
});

test('idle worker defaults to auto; queue still refused', () => {
  const idle = resolveWorkerSendMode({ recipientRole: 'worker', threadState: 'idle' });
  assert.equal(idle.mode, 'auto');
  assert.equal(idle.refused, false);

  const q = resolveWorkerSendMode({
    recipientRole: 'worker',
    threadState: 'idle',
    requestedMode: 'queue',
  });
  assert.equal(q.refused, true);
  assert.equal(q.mode, 'auto');
});

test('auto on running worker is upgraded to steer', () => {
  const r = resolveWorkerSendMode({
    recipientRole: 'worker',
    threadState: 'running',
    requestedMode: 'auto',
  });
  assert.equal(r.mode, 'steer');
  assert.equal(r.refused, false);
  assert.ok(r.flags.includes('auto-on-running-worker-use-steer'));
});

test('Cursor running worker still steers; residual risk flagged', () => {
  const r = resolveWorkerSendMode({
    recipientRole: 'execution',
    threadState: 'running',
    driver: 'cursor',
  });
  assert.equal(r.mode, 'steer');
  assert.ok(r.flags.includes('cursor-worker-steer-residual-risk'));
});

test('housekeeping current-task steers while running; auto when idle', () => {
  const run = resolveWorkerSendMode({ recipientRole: 'housekeeping', threadState: 'running' });
  assert.equal(run.mode, 'steer');
  assert.equal(run.refused, false);
  assert.equal(run.newMatter, false);

  const idle = resolveWorkerSendMode({ recipientRole: 'housekeeping', threadState: 'idle' });
  assert.equal(idle.mode, 'auto');
  assert.equal(idle.refused, false);

  const steerReq = resolveWorkerSendMode({
    recipientRole: 'housekeeping',
    threadState: 'running',
    requestedMode: 'steer',
  });
  assert.equal(steerReq.mode, 'steer');
  assert.equal(steerReq.refused, false);
});

test('housekeeping queue requires explicit newMatter; new matter queues', () => {
  const noFlag = resolveWorkerSendMode({
    recipientRole: 'housekeeping',
    threadState: 'running',
    requestedMode: 'queue',
  });
  assert.equal(noFlag.refused, true);
  assert.equal(noFlag.mode, 'steer');
  assert.ok(noFlag.flags.includes('housekeeping-queue-needs-new-matter'));

  const matterRun = resolveWorkerSendMode({
    recipientRole: 'hk',
    threadState: 'running',
    newMatter: true,
  });
  assert.equal(matterRun.mode, 'queue');
  assert.equal(matterRun.refused, false);
  assert.equal(matterRun.newMatter, true);
  assert.ok(matterRun.flags.includes('hk-new-matter'));

  const matterIdle = resolveWorkerSendMode({
    recipientRole: 'housekeeping',
    threadState: 'idle',
    hkNewMatter: true,
    requestedMode: 'queue',
  });
  assert.equal(matterIdle.mode, 'auto');
  assert.equal(matterIdle.refused, false);

  const matterSteer = resolveWorkerSendMode({
    recipientRole: 'housekeeping',
    threadState: 'running',
    newMatter: true,
    requestedMode: 'steer',
  });
  assert.equal(matterSteer.refused, true);
  assert.ok(matterSteer.flags.includes('housekeeping-new-matter-no-steer'));
});

test('workers still never queue even when newMatter is set', () => {
  const r = resolveWorkerSendMode({
    recipientRole: 'worker',
    threadState: 'running',
    requestedMode: 'queue',
    newMatter: true,
  });
  assert.equal(r.refused, true);
  assert.equal(r.mode, 'steer');
  assert.ok(r.flags.includes('never-queue-worker'));
});

test('buildThreadSendArgs HK new-matter emits queue; current-task refuses queue', () => {
  const built = buildThreadSendArgs({
    threadId: 'mcp:hk',
    message: 'HK-3 ops rollout',
    recipientRole: 'housekeeping',
    threadState: 'running',
    newMatter: true,
  });
  assert.equal(built.args.mode, 'queue');

  const current = buildThreadSendArgs({
    threadId: 'mcp:hk',
    message: 'fix scope: skip remote host',
    recipientRole: 'housekeeping',
    threadState: 'running',
  });
  assert.equal(current.args.mode, 'steer');

  assert.throws(
    () => buildThreadSendArgs({
      threadId: 'mcp:hk',
      message: 'HK-4 disk',
      recipientRole: 'housekeeping',
      threadState: 'running',
      requestedMode: 'queue',
    }),
    err => err.code === 'WORKER_SEND_REFUSED',
  );
});

test('verify housekeeping new-matter vs current-task paths', () => {
  const msg = 'HK-9 ops: rollout skill';
  const queued = verifyWorkerDelivery({
    message: msg,
    modeUsed: 'queue',
    recipientRole: 'housekeeping',
    newMatter: true,
    queueEntries: [{ text: msg }],
    activeRunMessages: [],
    sendAccepted: true,
  });
  assert.equal(queued.ok, true);

  const steered = verifyWorkerDelivery({
    message: 'narrow disk to /tmp/x only',
    modeUsed: 'steer',
    recipientRole: 'housekeeping',
    queueEntries: [],
    activeRunMessages: [{ text: 'narrow disk to /tmp/x only' }],
    sendAccepted: true,
  });
  assert.equal(steered.ok, true);

  const queueWithoutFlag = verifyWorkerDelivery({
    message: 'fix path',
    modeUsed: 'queue',
    recipientRole: 'housekeeping',
    queueEntries: [{ text: 'fix path' }],
    sendAccepted: true,
  });
  assert.equal(queueWithoutFlag.ok, false);
  assert.match(queueWithoutFlag.reason, /without newMatter/);

  const currentInQueue = verifyWorkerDelivery({
    message: 'fix path now',
    modeUsed: 'steer',
    recipientRole: 'housekeeping',
    newMatter: false,
    queueEntries: [{ text: 'fix path now' }],
    activeRunMessages: [],
    sendAccepted: true,
  });
  assert.equal(currentInQueue.ok, false);
  assert.equal(currentInQueue.inQueue, true);
});

test('orchestrator/report stay queue-only never auto', () => {
  const r = resolveWorkerSendMode({ recipientRole: 'orchestrator', threadState: 'running' });
  assert.equal(r.mode, 'queue');
  const n = resolveWorkerSendMode({ recipientRole: 'report', threadState: 'idle' });
  assert.equal(n.mode, 'queue');
  const idleAuto = resolveWorkerSendMode({
    recipientRole: 'orchestrator',
    threadState: 'idle',
    requestedMode: 'auto',
  });
  assert.equal(idleAuto.mode, 'queue');
});

test('terminal worker resumes with auto', () => {
  const r = resolveWorkerSendMode({
    recipientRole: 'worker',
    threadState: 'interrupted',
  });
  assert.equal(r.mode, 'auto');
});

test('buildThreadSendArgs refuses queue for workers', () => {
  assert.throws(
    () => buildThreadSendArgs({
      threadId: 'mcp:t1',
      message: 'nudge',
      recipientRole: 'worker',
      threadState: 'running',
      requestedMode: 'queue',
    }),
    err => err.code === 'WORKER_SEND_REFUSED',
  );

  const built = buildThreadSendArgs({
    threadId: 'mcp:t1',
    message: 'nudge',
    recipientRole: 'worker',
    threadState: 'running',
  });
  assert.deepEqual(built.args, { threadId: 'mcp:t1', message: 'nudge', mode: 'steer' });
});

test('verifyWorkerDelivery fails when worker message is in queue', () => {
  const msg = 'report-to change: new orchestratorRef t3tots-main';
  const bad = verifyWorkerDelivery({
    message: msg,
    modeUsed: 'queue',
    recipientRole: 'worker',
    queueEntries: [{ text: msg }],
    activeRunMessages: [],
    sendAccepted: true,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.inQueue, true);

  const good = verifyWorkerDelivery({
    message: msg,
    modeUsed: 'steer',
    recipientRole: 'execution',
    queueEntries: [],
    activeRunMessages: [{ text: msg, role: 'user' }],
    activeRunStatus: 'running',
    sendAccepted: true,
  });
  assert.equal(good.ok, true);
  assert.equal(good.inActiveRun, true);
});

test('verifyWorkerDelivery fails closed on echo pending until active-run match', () => {
  const r = verifyWorkerDelivery({
    message: 'please continue from interruption',
    modeUsed: 'steer',
    recipientRole: 'worker',
    queueEntries: [],
    activeRunMessages: [],
    activeRunStatus: 'running',
    sendAccepted: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.provisional, true);
  assert.match(r.reason, /echo pending/);
});

test('verify rejects worker mode=queue even if not listed in queue snapshot', () => {
  const r = verifyWorkerDelivery({
    message: 'hello worker',
    modeUsed: 'queue',
    recipientRole: 'worker',
    queueEntries: [],
    activeRunMessages: [],
    sendAccepted: true,
  });
  assert.equal(r.ok, false);
});

test('CLI resolve and build (no T3)', async () => {
  const chunks = [];
  const out = { write: s => chunks.push(s) };
  const resolved = await workerSendMain(
    ['resolve', '--role', 'worker', '--state', 'running', '--mode', 'queue'],
    { output: out },
  );
  assert.equal(resolved.refused, true);
  assert.equal(resolved.mode, 'steer');

  chunks.length = 0;
  const built = await workerSendMain(
    ['build', '--thread-id', 'mcp:x', '--message', 'hi', '--role', 'worker', '--state', 'running'],
    { output: out },
  );
  assert.equal(built.ok, true);
  assert.equal(built.args.mode, 'steer');

  chunks.length = 0;
  const hkMatter = await workerSendMain(
    ['resolve', '--role', 'housekeeping', '--state', 'running', '--hk-new-matter'],
    { output: out },
  );
  assert.equal(hkMatter.mode, 'queue');
  assert.equal(hkMatter.refused, false);

  chunks.length = 0;
  const hkCurrent = await workerSendMain(
    ['resolve', '--role', 'housekeeping', '--state', 'running'],
    { output: out },
  );
  assert.equal(hkCurrent.mode, 'steer');
});

test('CLI verify fixture in temp dir only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worker-send-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'snap.json');
  fs.writeFileSync(fixture, JSON.stringify({
    message: 'fix me',
    modeUsed: 'steer',
    recipientRole: 'worker',
    queueEntries: [],
    activeRunMessages: [{ text: 'fix me' }],
    activeRunStatus: 'running',
    sendAccepted: true,
  }));
  const chunks = [];
  const result = await workerSendMain(['verify', '--fixture', fixture], {
    output: { write: s => chunks.push(s) },
  });
  assert.equal(result.ok, true);
});
