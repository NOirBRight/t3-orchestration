#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createInboxServer } from '../inbox-web/server.mjs';
import { loadConfig } from '../inbox-web/config.mjs';
import { qrMatrix, qrPng } from '../inbox-web/qr.mjs';

const execute = promisify(execFile);
const git = (root, ...args) => execute('git', ['-C', path.join(root, 'repo'), ...args], { windowsHide: true });
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

export async function prepareSmoke(parent = os.tmpdir()) {
  const root = await realpath(await mkdtemp(path.join(path.resolve(parent), 'orchestration-smoke-')));
  for (const dir of ['repo/tickets', 'storage/drafts', 'storage/media', 'home/.agents/skills']) await mkdir(path.join(root, dir), { recursive: true });
  await json(path.join(root, 'smoke-sandbox.json'), { version: 1, root });
  await writeFile(path.join(root, 'repo/README.md'), '# Local orchestration smoke sandbox\n\nNo GitHub repository or issues. Tickets live in tickets/.\n');
  await writeFile(path.join(root, 'repo/tickets/1.md'), '# local-1: Greeting with an owner decision\n\nAsk through Inbox whether greeting.txt should say Hello or Welcome. Continue drafting a test while waiting. After the answer, write the chosen greeting and verify it. Report the commit and evidence to this Campaign orchestrator.\n');
  await writeFile(path.join(root, 'repo/tickets/2.md'), '# local-2: Visual greeting\n\nBlocked by local-1 merged into main. Create index.html displaying greeting.txt, capture a browser screenshot into Campaign media/local-2/, and report with a visual acceptance draft. Owner approval is required before merge.\n');
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Orchestration Smoke');
  await git(root, 'config', 'user.email', 'smoke@example.invalid');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Initialize disposable local smoke tickets');
  const campaign = { id: 'setup-smoke', campaign: 'Setup smoke Campaign', project: 'Local smoke sandbox', projectId: '', initiator: '', orchestrator: '', source: path.join(root, 'repo/tickets'), awaitingReports: [], tasks: [], tickets: [
    { ticket: 'local-1', title: 'Greeting with a decision', kind: '交付', stage: '未开始', blockedBy: [] },
    { ticket: 'local-2', title: 'Visual greeting', kind: '交付', stage: '未开始', blockedBy: ['local-1'] },
  ] };
  await json(path.join(root, 'storage/campaign.json'), campaign);
  await writeFile(path.join(root, 'storage/events.log'), '');
  const question = { id: 'Q1', kind: 'decide', ticket: 'local-1', title: 'Choose the greeting', blocking: false, background: ['Choose the greeting text; test drafting can continue while waiting.'], recommendation: 'Hello is recommended for this example.', askerThreadId: '<execution-thread-id>', askerLabel: 'local-1', options: [{ key: 'hello', label: 'Hello', consequence: 'Write Hello to greeting.txt', recommended: true }, { key: 'welcome', label: 'Welcome', consequence: 'Write Welcome to greeting.txt' }] };
  const acceptance = { id: 'A2', kind: 'accept', ticket: 'local-2', title: 'Review the visual greeting', blocking: false, background: ['Review the greeting page and actual screenshot before merge. Replace this skeleton with verified and unverified results.'], recommendation: 'Approve only after reviewing the actual screenshot.', askerThreadId: '<execution-thread-id>', askerLabel: 'local-2', media: [{ path: 'media/preview.png', caption: 'Dry-run fixture; replace with actual screenshot for live smoke' }] };
  await json(path.join(root, 'storage/drafts/question.json'), question);
  await json(path.join(root, 'storage/drafts/acceptance.json'), acceptance);
  await writeFile(path.join(root, 'storage/media/preview.png'), qrPng(qrMatrix('Non-secret smoke fixture')));
  return { root, repository: path.join(root, 'repo'), campaign: path.join(root, 'storage'), tickets: ['local-1', 'local-2'] };
}

export async function verifySandbox(root) {
  const absolute = path.resolve(root);
  const resolved = await realpath(absolute);
  const marker = JSON.parse(await readFile(path.join(resolved, 'smoke-sandbox.json'), 'utf8'));
  if ((await lstat(absolute)).isSymbolicLink() || resolved !== absolute || marker.version !== 1 || marker.root !== resolved || !path.basename(resolved).startsWith('orchestration-smoke-')) throw new Error('Not the original disposable smoke sandbox.');
  return resolved;
}

export async function dryRunSmoke(root) {
  root = await verifySandbox(root);
  const report = { mode: 'dry-run', realThreads: 0, githubIssues: 0, simulated: ['dispatch', 'owner answers', 'reports', 'light review', 'closeout approval'], steps: [] };
  const config = loadConfig({ home: path.join(root, 'home') }); config.port = 0; config.remotePort = 0;
  const push = { publicKey: '', start() {}, stop() {}, enqueue() {} };
  const server = await createInboxServer({ config, push });
  try {
    await server.start(); await server.admin('register', { dir: path.join(root, 'storage') });
    for (const [ticket, branch, file, text, draft, choice] of [
      ['local-1', 'smoke/1', 'greeting.txt', 'Hello\n', 'question', 'hello'],
      ['local-2', 'smoke/2', 'index.html', '<!doctype html><html lang="en"><title>Greeting</title><h1>Hello</h1></html>\n', 'acceptance', 'pass'],
    ]) {
      const item = JSON.parse(await readFile(path.join(root, `storage/drafts/${draft}.json`), 'utf8')); item.askerThreadId = 'dry-run-simulated-thread';
      await server.admin('ask', { campaign: 'setup-smoke', item });
      server.store.submit('setup-smoke', [{ id: item.id, answer: { choices: [choice] } }]);
      await server.admin('ack', { campaign: 'setup-smoke', id: item.id });
      if (item.kind === 'decide') await server.admin('forward', { campaign: 'setup-smoke', id: item.id, to: 'dry-run-simulated-thread' });
      await server.admin('close', { campaign: 'setup-smoke', id: item.id });
      await git(root, 'checkout', '-b', branch);
      await writeFile(path.join(root, 'repo', file), text);
      await git(root, 'add', file); await git(root, 'commit', '-m', `Dry-run ${ticket}`);
      await git(root, 'checkout', 'main'); await git(root, 'merge', '--ff-only', branch); await git(root, 'branch', '-d', branch);
      report.steps.push(`${ticket}: simulated dispatch/answer/report/review; local Inbox lifecycle and git merge passed`);
    }
    await server.admin('ask', { campaign: 'setup-smoke', item: { id: 'A3', kind: 'accept', ticket: 'Closeout summary', title: 'Close out both local smoke tickets', askerThreadId: 'dry-run-orchestrator', askerLabel: 'Dry-run', background: report.steps } });
    server.store.submit('setup-smoke', [{ id: 'A3', answer: { choices: ['pass'] } }]);
    await server.admin('ack', { campaign: 'setup-smoke', id: 'A3' }); await server.admin('close', { campaign: 'setup-smoke', id: 'A3' });
    await server.admin('unregister', { campaign: 'setup-smoke' });
    report.steps.push('Simulated closeout approved; unregistered; archive retained. No T3 tools or network dispatch used.');
    await json(path.join(root, 'dry-run.json'), report);
    return report;
  } finally { await server.stop(); }
}

export async function cleanupSmoke(root) {
  const verified = await verifySandbox(root);
  await rm(verified, { recursive: true });
  return { removed: verified };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, location] = process.argv.slice(2);
  const actions = { prepare: () => prepareSmoke(location), 'dry-run': () => dryRunSmoke(location), cleanup: () => cleanupSmoke(location) };
  Promise.resolve().then(() => { if (!actions[command] || (command !== 'prepare' && !location)) throw new Error('smoke.mjs prepare [parent] | dry-run <sandbox> | cleanup <sandbox>'); return actions[command](); })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
