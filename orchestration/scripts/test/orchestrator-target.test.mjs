import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadCampaignMeta, loadPrivateOrchestrator, deliverExternalReport, signReport, verifyReportSignature,
  assertPublicReport, verifyInboundReport, REPORT_TIMESTAMP_SKEW_SEC,
} from '../orchestrator-target.mjs';
import { main as reportMain } from '../report.mjs';
import { atomicJson } from '../../inbox-web/config.mjs';

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-target-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function externalFixture(home, { ref = 'bot1', secret = 'sec' } = {}) {
  const dir = path.join(home, 'camp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
    id: 'c',
    orchestratorKind: 'external',
    orchestratorRef: ref,
    tickets: [],
  }));
  const privateDir = path.join(home, '.agents', 'orchestration', 'private', 'orchestrators');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  atomicJson(path.join(privateDir, `${ref}.json`), {
    type: 'webhook',
    url: 'http://127.0.0.1:9/orch',
    signingSecret: secret,
    queueOnly: true,
  }, true);
  return { dir, secret, ref };
}

test('t3-thread meta and report CLI skip fetch', async t => {
  const home = tempHome(t);
  const dir = path.join(home, 'camp');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
    id: 'c', orchestrator: 'mcp:thread-1', tickets: [],
  }));
  assert.deepEqual(loadCampaignMeta(dir), { kind: 't3-thread', threadId: 'mcp:thread-1', ref: null });
  let fetches = 0;
  const file = path.join(home, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'orch-report/1', campaign: 'c', summary: 'hi' }));
  const chunks = [];
  const result = await reportMain(['--campaign-dir', dir, '--file', file], {
    home,
    fetchImpl: async () => { fetches++; return new Response(null, { status: 200 }); },
    output: { write: s => chunks.push(s) },
  });
  assert.equal(result.mode, 't3-thread');
  assert.equal(fetches, 0);
  assert.match(chunks.join(''), /t3-thread/);

  const badFile = path.join(home, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({
    schema: 'orch-report/1', campaign: 'c', summary: 'hi', ticket: 'P33',
  }));
  await assert.rejects(
    reportMain(['--campaign-dir', dir, '--file', badFile], {
      home,
      fetchImpl: async () => { fetches++; return new Response(null, { status: 200 }); },
      output: { write() {} },
    }),
    /title/,
  );
  assert.equal(fetches, 0);
});

test('external delivery signs with id and refuses secrets in campaign.json', async t => {
  const home = tempHome(t);
  const { dir } = externalFixture(home);

  const bodies = [];
  const result = await deliverExternalReport({
    home,
    campaignDir: dir,
    report: { schema: 'orch-report/1', campaign: 'c', summary: 'startup ok', ticket: '#1', title: 'one-liner', phase: 'startup' },
    requestId: 'req-fixed-001',
    fetchImpl: async (url, init) => {
      bodies.push({ url: String(url), headers: init.headers, body: init.body });
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].headers['X-Orch-Queue'], '1');
  assert.equal(bodies[0].headers['X-Orch-Id'], 'req-fixed-001');
  assert.equal(
    verifyReportSignature(
      'sec',
      bodies[0].headers['X-Orch-Timestamp'],
      bodies[0].headers['X-Orch-Id'],
      bodies[0].body,
      bodies[0].headers['X-Orch-Signature'],
    ),
    true,
  );
  assert.doesNotMatch(bodies[0].body, /signingSecret/);
  assert.doesNotMatch(JSON.stringify(bodies[0].headers), /signingSecret/);

  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({
    orchestratorKind: 'external',
    orchestratorRef: 'bot1',
    orchestrator: 'https://evil.example/hook',
  }));
  assert.throws(() => loadCampaignMeta(dir), /URL/);

  assert.throws(() => assertPublicReport({ schema: 'orch-report/1', campaign: 'c', summary: 'x', signingSecret: 'no' }), /秘密/);
  assert.throws(
    () => assertPublicReport({ schema: 'orch-report/1', campaign: 'c', summary: 'x', ticket: '#1' }),
    /title/,
  );
  assert.doesNotThrow(() => assertPublicReport({
    schema: 'orch-report/1', campaign: 'c', summary: 'x', ticket: '#1', title: 'short',
  }));
  assert.throws(() => loadPrivateOrchestrator(home, 'missing'), /不存在/);

  atomicJson(path.join(home, '.agents', 'orchestration', 'private', 'orchestrators', 'bot1.json'), {
    type: 'webhook', url: 'http://127.0.0.1:9/x', signingSecret: 'sec', queueOnly: false,
  }, true);
  assert.throws(() => loadPrivateOrchestrator(home, 'bot1'), /queueOnly/);

  const sig = signReport('sec', '1', 'id1', '{}');
  assert.equal(sig.length, 64);
});

test('verify accepts good report and rejects tamper, expired, replay', async t => {
  const home = tempHome(t);
  const { dir } = externalFixture(home);
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const body = JSON.stringify({ schema: 'orch-report/1', campaign: 'c', summary: 'ok', at: new Date(nowMs).toISOString() });
  const id = 'nonce-abc-001';
  const signature = `sha256=${signReport('sec', timestamp, id, body)}`;
  const headers = {
    'X-Orch-Signature': signature,
    'X-Orch-Timestamp': timestamp,
    'X-Orch-Id': id,
    'X-Orch-Queue': '1',
  };

  const good = verifyInboundReport({ home, campaignDir: dir, bodyText: body, headers, now: () => nowMs });
  assert.deepEqual(good, { ok: true });

  const replay = verifyInboundReport({ home, campaignDir: dir, bodyText: body, headers, now: () => nowMs });
  assert.deepEqual(replay, { ok: false, reason: 'replay' });

  const tamperedBody = body.replace('ok', 'no');
  const tamper = verifyInboundReport({
    home,
    campaignDir: dir,
    bodyText: tamperedBody,
    headers: { ...headers, 'X-Orch-Id': 'nonce-abc-002', 'X-Orch-Signature': signature },
    now: () => nowMs,
  });
  assert.deepEqual(tamper, { ok: false, reason: 'bad-signature' });

  const expiredTs = String(Math.floor(nowMs / 1000) - REPORT_TIMESTAMP_SKEW_SEC - 1);
  const expiredId = 'nonce-abc-003';
  const expiredSig = `sha256=${signReport('sec', expiredTs, expiredId, body)}`;
  const expired = verifyInboundReport({
    home,
    campaignDir: dir,
    bodyText: body,
    headers: { 'X-Orch-Signature': expiredSig, 'X-Orch-Timestamp': expiredTs, 'X-Orch-Id': expiredId },
    now: () => nowMs,
  });
  assert.deepEqual(expired, { ok: false, reason: 'expired' });
});

test('report.mjs verify CLI prints only ok/reason JSON and exit code', async t => {
  const home = tempHome(t);
  const { dir } = externalFixture(home);
  const nowMs = 1_710_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const body = JSON.stringify({ schema: 'orch-report/1', campaign: 'c', summary: 'cli' });
  const id = 'cli-id-0001';
  const headers = {
    'X-Orch-Signature': `sha256=${signReport('sec', timestamp, id, body)}`,
    'X-Orch-Timestamp': timestamp,
    'X-Orch-Id': id,
  };
  const bodyFile = path.join(home, 'body.json');
  const headersFile = path.join(home, 'headers.json');
  fs.writeFileSync(bodyFile, body);
  fs.writeFileSync(headersFile, JSON.stringify(headers));

  const out = [];
  let code;
  const ok = await reportMain(
    ['verify', '--campaign-dir', dir, '--body-file', bodyFile, '--headers-file', headersFile],
    { home, now: () => nowMs, output: { write: s => out.push(s) }, exit: c => { code = c; } },
  );
  assert.deepEqual(ok, { ok: true });
  assert.equal(out.join('').trim(), '{"ok":true}');
  assert.equal(code, undefined);
  assert.doesNotMatch(out.join(''), /sec|127\.0\.0\.1|sha256=/);

  const out2 = [];
  let code2;
  const bad = await reportMain(
    ['verify', '--campaign-dir', dir, '--body-file', bodyFile, '--headers-file', headersFile],
    { home, now: () => nowMs, output: { write: s => out2.push(s) }, exit: c => { code2 = c; } },
  );
  assert.deepEqual(bad, { ok: false, reason: 'replay' });
  assert.equal(out2.join('').trim(), '{"ok":false,"reason":"replay"}');
  assert.equal(code2, 1);
  assert.doesNotMatch(out2.join(''), /sec|signingSecret|sha256=/);
});
