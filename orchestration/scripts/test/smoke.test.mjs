import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareSmoke, dryRunSmoke, cleanupSmoke } from '../smoke.mjs';

test('local sandbox dry-run exercises Inbox, question, visual acceptance, merge and closeout without dispatch', async t => {
  const sandbox = await prepareSmoke(); t.after(() => rm(sandbox.root, { recursive: true, force: true }));
  const report = await dryRunSmoke(sandbox.root);
  assert.equal(report.realThreads, 0); assert.equal(report.githubIssues, 0); assert.equal(report.steps.length, 3);
  assert.equal((await readFile(path.join(sandbox.repository, 'greeting.txt'), 'utf8')).trimEnd(), 'Hello');
  const inbox = JSON.parse(await readFile(path.join(sandbox.campaign, 'inbox.json'), 'utf8'));
  assert.equal(inbox.items.length, 3); assert.ok(inbox.items.every(x => x.status === 'closed'));
  const config = JSON.parse(await readFile(path.join(sandbox.root, 'home/.agents/orchestration/machine.json'), 'utf8'));
  assert.deepEqual(config.campaigns, []);
  await cleanupSmoke(sandbox.root); await assert.rejects(readFile(path.join(sandbox.root, 'smoke-sandbox.json')));
});
test('cleanup refuses a non-sandbox directory', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unrelated-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(cleanupSmoke(dir));
});
