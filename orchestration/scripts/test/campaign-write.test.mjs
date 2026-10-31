import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidStage,
  validateCampaign,
  writeCampaign,
  patchCampaign,
  main as campaignWriteMain,
  STAGE_EXACT,
} from '../campaign-write.mjs';

function tempCampaign(t, seed = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-campaign-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = {
    id: 'demo',
    campaign: 'demo',
    awaitingReports: [],
    tickets: [{ ticket: '#1', title: 't', kind: '交付', stage: '执行中' }],
    housekeeping: { enabled: true, countsTowardLimits: false },
    ...seed,
  };
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify(data, null, 2) + '\n');
  return { dir, data };
}

test('stage enum accepts exact, prefix, and legacy store-readable forms', () => {
  for (const s of STAGE_EXACT) assert.equal(isValidStage(s), true);
  assert.equal(isValidStage('卡住：缺依赖'), true);
  assert.equal(isValidStage('等你决定 Q12'), true);
  assert.equal(isValidStage('已合入 prep main'), true);
  assert.equal(isValidStage('已合主线'), true);
  assert.equal(isValidStage('已交付还差截图'), true); // legacy done (store.mjs)
  assert.equal(isValidStage(''), false);
  assert.equal(isValidStage('running'), false);
  assert.equal(isValidStage('almost done'), false);
});

test('validateCampaign rejects bad stage, missing title, countsTowardLimits, secrets', () => {
  const ok = validateCampaign({
    id: 'x',
    tickets: [{ ticket: '#1', title: 'done work', stage: '已交付' }],
    housekeeping: { countsTowardLimits: false },
    inboxUrl: 'http://127.0.0.1:8780/',
  });
  assert.equal(ok.ok, true);

  const missingTitle = validateCampaign({
    tickets: [{ ticket: '#1', stage: '执行中' }],
  });
  assert.equal(missingTitle.ok, false);
  assert.ok(missingTitle.errors.some(e => e.includes('title')));

  const blankTitle = validateCampaign({
    tickets: [{ ticket: '#1', title: '   ', stage: '执行中' }],
  });
  assert.equal(blankTitle.ok, false);
  assert.ok(blankTitle.errors.some(e => e.includes('title')));

  const badStage = validateCampaign({
    tickets: [{ ticket: '#1', title: 't', stage: 'almost done' }],
  });
  assert.equal(badStage.ok, false);
  assert.ok(badStage.errors.some(e => e.includes('stage')));

  const badCounts = validateCampaign({
    housekeeping: { countsTowardLimits: true },
  });
  assert.equal(badCounts.ok, false);
  assert.ok(badCounts.errors.some(e => e.includes('countsTowardLimits')));

  const secret = validateCampaign({
    reportEndpoint: 'https://evil.example/hook',
    webhookUrl: 'https://evil.example/wh',
    tickets: [{ ticket: '#1', title: 't', stage: '执行中' }],
  });
  assert.equal(secret.ok, false);
  assert.ok(secret.errors.some(e => e.includes('reportEndpoint')));
  assert.ok(secret.errors.some(e => e.includes('webhookUrl')));

  // P33 key ban: secret-shaped keys refused for any value type.
  const secretAnyType = validateCampaign({
    webhookUrl: 1,
    signingSecret: true,
    inboundToken: null,
    tickets: [{ ticket: '#1', title: 't', stage: '执行中' }],
  });
  assert.equal(secretAnyType.ok, false);
  assert.ok(secretAnyType.errors.some(e => e.includes('webhookUrl')));
  assert.ok(secretAnyType.errors.some(e => e.includes('signingSecret')));
  assert.ok(secretAnyType.errors.some(e => e.includes('inboundToken')));

  // Bare URL under a non-allowlisted field is refused (P9 value-shape check).
  const bareUrl = validateCampaign({
    id: 'x',
    otherHook: 'https://evil.example/x',
    tickets: [{ ticket: '#1', title: 't', stage: '执行中' }],
  });
  assert.equal(bareUrl.ok, false);
  assert.ok(bareUrl.errors.some(e => e.includes('otherHook')));

  // Nested tickets[i].*.url is not the tracker field — refuse.
  const nestedTicketUrl = validateCampaign({
    tickets: [{
      ticket: '#1',
      title: 't',
      stage: '执行中',
      webhook: { url: 'https://evil.example/nested' },
    }],
  });
  assert.equal(nestedTicketUrl.ok, false);
  assert.ok(nestedTicketUrl.errors.some(e => e.includes('tickets.0.webhook.url')));

  // Ordinary tracker URLs in note/source and exact tickets[].url are allowed.
  const withNoteUrl = validateCampaign({
    id: 'x',
    source: 'https://example.com/map',
    tickets: [{
      ticket: '#1',
      title: 't',
      stage: '执行中',
      note: 'see https://example.com/issue/1',
      url: 'https://example.com/issue/1',
    }],
    inboxUrl: 'http://127.0.0.1:8780/',
  });
  assert.equal(withNoteUrl.ok, true);

  // reportEndpoint label:<ref> is allowed; raw URL already covered above.
  const labelEndpoint = validateCampaign({
    reportEndpoint: 'label:t3tots-main',
    tickets: [{ ticket: '#1', title: 't', stage: '执行中' }],
  });
  assert.equal(labelEndpoint.ok, true);

  // Legacy stage must not block title-bearing writes.
  const legacy = validateCampaign({
    tickets: [{ ticket: 'P1', title: 'toolchain', stage: '已合入 prep' }],
  });
  assert.equal(legacy.ok, true);
});

test('writeCampaign backups and atomically updates in temp dir', t => {
  const { dir } = tempCampaign(t);
  const next = {
    id: 'demo',
    campaign: 'demo',
    tickets: [{ ticket: '#1', title: 't', kind: '交付', stage: '已交付' }],
    housekeeping: { enabled: true, countsTowardLimits: false },
    updatedAt: '2026-10-28T00:00:00Z',
  };
  const result = writeCampaign({
    campaignDir: dir,
    data: next,
    backupSuffix: 'test1',
    now: new Date('2026-10-28T00:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(written.tickets[0].stage, '已交付');
  const bak = JSON.parse(fs.readFileSync(result.backupPath, 'utf8'));
  assert.equal(bak.tickets[0].stage, '执行中');
});

test('writeCampaign refuses invalid payload and leaves file unchanged', t => {
  const { dir } = tempCampaign(t);
  const before = fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8');
  const result = writeCampaign({
    campaignDir: dir,
    data: {
      tickets: [{ ticket: '#1', title: 't', stage: 'nope' }],
      webhookUrl: 'https://example.com/x',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'), before);
});

test('patchCampaign updates ticket stage', t => {
  const { dir } = tempCampaign(t);
  const result = patchCampaign({
    campaignDir: dir,
    ticket: '#1',
    ticketPatch: { stage: '已合并', commit: 'abc' },
    backupSuffix: 'patch1',
  });
  assert.equal(result.ok, true);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(written.tickets[0].stage, '已合并');
  assert.equal(written.tickets[0].commit, 'abc');
});

test('CLI validate and write on temp dirs only', async t => {
  const { dir, data } = tempCampaign(t);
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({
    ...data,
    tickets: [{ ticket: '#1', title: 't', stage: 'bogus' }],
  }));
  const chunks = [];
  const out = { write: s => chunks.push(s) };
  const bad = await campaignWriteMain(['validate', '--file', badFile], { output: out });
  assert.equal(bad.ok, false);

  const goodFile = path.join(dir, 'next.json');
  fs.writeFileSync(goodFile, JSON.stringify({
    ...data,
    tickets: [{ ticket: '#1', title: 't', kind: '交付', stage: '返修' }],
  }));
  chunks.length = 0;
  const written = await campaignWriteMain(
    ['write', '--campaign-dir', dir, '--file', goodFile, '--backup-suffix', 'cli'],
    { output: out },
  );
  assert.equal(written.ok, true);
  const camp = JSON.parse(fs.readFileSync(path.join(dir, 'campaign.json'), 'utf8'));
  assert.equal(camp.tickets[0].stage, '返修');
});
