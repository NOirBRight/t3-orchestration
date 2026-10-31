import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classifyMergeRisk, matchRiskTriggers, precheck, parseArgs, parseProjectHousekeeping, run, DEFAULT_RISK_TRIGGERS, EXIT } from '../merge-risk.mjs';

const SCRIPT = fileURLToPath(new URL('../merge-risk.mjs', import.meta.url));

test('ordinary product paths take the scripted tier', () => {
  const result = classifyMergeRisk({ files: ['src/app.js', 'docs/readme.md'], verifiedBase: 'a', currentBase: 'a' });
  assert.equal(result.tier, 'scripted');
  assert.deepEqual(result.reasons, []);
});

test('test runners, release scripts and CI trigger the recheck', () => {
  for (const file of ['package.json', '.github/workflows/test.yml', 'scripts/release/export.mjs', 'tools/run-tests.sh', 'app/build.gradle']) {
    assert.equal(classifyMergeRisk({ files: [file] }).tier, 'recheck', file);
  }
});

test('a moved base triggers recheck and re-verify', () => {
  const result = classifyMergeRisk({ files: ['src/app.js'], verifiedBase: 'a', currentBase: 'b' });
  assert.equal(result.tier, 'recheck');
  assert.deepEqual(result.reasons, ['base-moved']);
  assert.equal(result.reverify, true);
});

test('project trigger lists replace the defaults', () => {
  assert.deepEqual(matchRiskTriggers(['core/shared/io.ts', 'src/x.ts'], ['core/shared/**']), [{ file: 'core/shared/io.ts', trigger: 'core/shared/**' }]);
  assert.equal(matchRiskTriggers(['package.json'], ['core/**']).length, 0);
  assert.ok(DEFAULT_RISK_TRIGGERS.includes('.github/**'));
});

test('precheck asserts candidate SHA, conflicts and diff --check without moving refs', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-risk-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'ticket');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
  git('add', '.');
  git('commit', '-qm', 'ticket');
  const candidate = git('rev-parse', 'HEAD');
  const clean = precheck({ repo, target: 'main', candidate, branch: 'ticket', verifiedBase: base });
  assert.equal(clean.ok, true);
  assert.equal(clean.tier, 'scripted');
  assert.deepEqual(clean.files, ['b.txt']);
  assert.equal(precheck({ repo, target: 'main', candidate: base, branch: 'ticket', verifiedBase: base }).stops[0], 'candidate-not-branch-head');
  // Target moves with a conflicting edit.
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'other\n');
  git('add', '.');
  git('commit', '-qm', 'main moves');
  const moved = precheck({ repo, target: 'main', candidate, branch: 'ticket', verifiedBase: base });
  assert.equal(moved.ok, false);
  assert.ok(moved.stops.includes('merge-conflict'));
  assert.equal(moved.tier, 'recheck');
  assert.equal(git('rev-parse', 'ticket'), candidate);
  // Whitespace errors fail diff --check.
  git('checkout', '-q', 'ticket');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'trailing \n');
  git('add', '.');
  git('commit', '-qm', 'ws');
  const ws = precheck({ repo, target: 'main', candidate: git('rev-parse', 'HEAD'), branch: 'ticket', verifiedBase: base });
  assert.ok(ws.stops.includes('diff-check'));
});

function fixtureRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-risk-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  write('a.txt', 'one\n');
  write('core/shared/io.ts', 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'ticket');
  return { repo, git, write, base };
}

function cli(args) {
  const child = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: child.status, json: JSON.parse(child.stdout), stderr: child.stderr };
}

function snapshot(git) {
  return { refs: git('for-each-ref', '--format=%(refname) %(objectname)'), head: git('symbolic-ref', 'HEAD'), status: git('status', '--porcelain=v1', '--untracked-files=all') };
}

test('new default triggers cover lists, runners, lockfiles, CI, rules, tooling and configs', () => {
  for (const file of ['tests/list-smoke.txt', 'test/manifest.json', 'tools/test_unit.py', 'tools/test-all.ps1', 'yarn.lock', 'web/pnpm-lock.yaml',
    'Cargo.toml', 'crates/x/Cargo.lock', 'go.mod', 'pyproject.toml', 'requirements-dev.txt', 'Jenkinsfile', 'azure-pipelines.yml', 'AGENTS.md',
    '.cursor/rules/style.mdc', 'orchestration/RULES-ORCHESTRATOR.md', 'orchestration/scripts/merge-risk.mjs', 'Dockerfile', '.npmrc',
    'web/vite.config.ts', 'playwright.config.ts', 'build.rs', 'app/build.gradle', 'tools/build.ps1']) {
    assert.equal(classifyMergeRisk({ files: [file] }).tier, 'recheck', file);
  }
});

test('build.* no longer false-matches source files like src/build.rs', () => {
  for (const file of ['src/build.rs', 'src/builder/build.rs', 'docs/build.md', 'src/app/build-info.ts']) {
    assert.equal(classifyMergeRisk({ files: [file] }).tier, 'scripted', file);
  }
});

test('missing --verified-base is rejected (exit 2, JSON error), also via the API', t => {
  const { repo, git, write, base } = fixtureRepo(t);
  write('b.txt', 'two\n'); git('add', '.'); git('commit', '-qm', 'x');
  const out = cli(['--repo', repo, '--target', 'main', '--candidate', git('rev-parse', 'HEAD'), '--branch', 'ticket']);
  assert.equal(out.status, EXIT.usage);
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error.type, 'usage');
  assert.match(out.json.error.message, /verified-base/);
  assert.throws(() => precheck({ repo, target: 'main', candidate: 'HEAD', branch: 'ticket' }), /verifiedBase/);
  assert.ok(base);
});

test('bad args error out: unknown flags, underscores, missing values, duplicates, positional', () => {
  const ok = ['--repo', 'r', '--target', 't', '--candidate', 'c', '--branch', 'b', '--verified-base', 'v'];
  assert.equal(parseArgs(ok)['verified-base'], 'v');
  assert.equal(parseArgs(['--repo=r', '--target=t', '--candidate=c', '--branch=b', '--verified-base=v']).repo, 'r');
  for (const bad of [
    [...ok.slice(0, 8), '--verified_base', 'v'],
    [...ok, '--bogus', 'x'],
    [...ok, '--project'],
    [...ok, '--repo', 'again'],
    [...ok, 'stray'],
    [...ok, '--project', 'p.md', '--triggers-file', 't.json'],
  ]) {
    const { exitCode, result } = run(bad);
    assert.equal(exitCode, EXIT.usage, bad.join(' '));
    assert.equal(result.error.type, 'usage');
  }
  const out = cli([...ok.slice(0, 8), '--verified_base', 'v']);
  assert.equal(out.status, EXIT.usage);
  assert.match(out.json.error.message, /unknown option --verified_base/);
});

test('renames report both ends, so moving a risk file out of a trigger path still triggers', t => {
  const { repo, git, write, base } = fixtureRepo(t);
  write('scripts/release/sign.mjs', 'export default 1;\n'.repeat(20));
  git('checkout', '-q', 'main'); git('add', '-f', '.'); git('commit', '-qm', 'release script');
  const base2 = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'ticket'); git('reset', '-q', '--hard', base2);
  git('mv', 'scripts/release/sign.mjs', 'moved.mjs');
  git('commit', '-qm', 'move');
  const result = precheck({ repo, target: 'main', candidate: git('rev-parse', 'HEAD'), branch: 'ticket', verifiedBase: base2 });
  assert.ok(result.files.includes('scripts/release/sign.mjs'));
  assert.ok(result.files.includes('moved.mjs'));
  assert.equal(result.tier, 'recheck');
  assert.deepEqual(result.reasons, ['risk-path']);
  assert.ok(base);
});

test('project settings mergeRiskTriggers are read from the Housekeeping section', t => {
  const { repo, git, write, base } = fixtureRepo(t);
  write('core/shared/io.ts', 'export const x = 2;\n'); git('add', '.'); git('commit', '-qm', 'core');
  const candidate = git('rev-parse', 'HEAD');
  const settings = path.join(repo, '..', path.basename(repo) + '-settings.md');
  t.after(() => fs.rmSync(settings, { force: true }));
  fs.writeFileSync(settings, '# Orchestration settings\n\n## Tests\n- mergeRiskTriggers: nope/**\n\n## Housekeeping\n- enabled: true\n- mergeRiskTriggers: `core/shared/**`, `default`\n- postMergeBatch: 1\n\n## Orchestrator mode\n- kind: t3-thread\n');
  const args = ['--repo', repo, '--target', 'main', '--candidate', candidate, '--branch', 'ticket', '--verified-base', base, '--project', settings];
  const out = cli(args);
  assert.equal(out.status, EXIT.ok);
  assert.equal(out.json.tier, 'recheck');
  assert.equal(out.json.triggerSource, 'project');
  assert.deepEqual(out.json.riskFiles, [{ file: 'core/shared/io.ts', trigger: 'core/shared/**' }]);
  // Without the project list the same change is scripted-tier.
  const plain = cli(args.slice(0, 10));
  assert.equal(plain.json.tier, 'scripted');
  assert.equal(plain.json.triggerSource, 'default');
  // `default` alone keeps the built-in list; parser ignores other sections.
  assert.equal(parseProjectHousekeeping('## Housekeeping\n- mergeRiskTriggers: default\n').triggers.length, DEFAULT_RISK_TRIGGERS.length);
  assert.equal(parseProjectHousekeeping('## Housekeeping\n- enabled: true\n').triggers, null);
  assert.deepEqual(parseProjectHousekeeping('## Housekeeping\n- mergeRiskTriggers: a/**, b.txt\n').triggers, ['a/**', 'b.txt']);
  assert.throws(() => parseProjectHousekeeping('## Housekeeping\n- mergeRiskTriggers: <globs>\n'), /placeholder/);
});

test('postMergeBatch > 1 is rejected as unimplemented', t => {
  assert.equal(parseProjectHousekeeping('## Housekeeping\n- postMergeBatch: 1\n').postMergeBatch, 1);
  assert.throws(() => parseProjectHousekeeping('## Housekeeping\n- postMergeBatch: 3\n'), err => err.type === 'unimplemented');
  assert.throws(() => parseProjectHousekeeping('## Housekeeping\n- postMergeBatch: zero\n'), err => err.type === 'config');
  const { repo, git, base } = fixtureRepo(t);
  const settings = path.join(repo, '..', path.basename(repo) + '-batch.md');
  t.after(() => fs.rmSync(settings, { force: true }));
  fs.writeFileSync(settings, '## Housekeeping\n- postMergeBatch: 2\n');
  const out = cli(['--repo', repo, '--target', 'main', '--candidate', git('rev-parse', 'HEAD'), '--branch', 'ticket', '--verified-base', base, '--project', settings]);
  assert.equal(out.status, EXIT.usage);
  assert.equal(out.json.error.type, 'unimplemented');
});

test('exit codes: 0 proceed, 1 conflict stop, 3 tool error; JSON always on stdout', t => {
  const { repo, git, write, base } = fixtureRepo(t);
  write('b.txt', 'two\n'); git('add', '.'); git('commit', '-qm', 'ticket');
  const candidate = git('rev-parse', 'HEAD');
  const args = ['--repo', repo, '--target', 'main', '--candidate', candidate, '--branch', 'ticket', '--verified-base', base];
  const clean = cli(args);
  assert.equal(clean.status, EXIT.ok);
  assert.equal(clean.json.ok, true);
  git('checkout', '-q', 'main'); write('b.txt', 'other\n'); git('add', '.'); git('commit', '-qm', 'main moves');
  const conflict = cli(args);
  assert.equal(conflict.status, EXIT.stop);
  assert.equal(conflict.json.ok, false);
  assert.deepEqual(conflict.json.stops, ['merge-conflict']);
  assert.deepEqual(conflict.json.conflicts, ['b.txt']);
  assert.equal(conflict.json.error, undefined);
  const badRef = cli(['--repo', repo, '--target', 'no-such-branch', '--candidate', candidate, '--branch', 'ticket', '--verified-base', base]);
  assert.equal(badRef.status, EXIT.tool);
  assert.equal(badRef.json.ok, false);
  assert.equal(badRef.json.error.type, 'tool');
  const notRepo = path.join(repo, 'does-not-exist');
  const noRepo = cli(['--repo', notRepo, '--target', 'main', '--candidate', 'HEAD', '--branch', 'main', '--verified-base', 'HEAD']);
  assert.equal(noRepo.status, EXIT.tool);
  assert.equal(noRepo.json.error.type, 'tool');
});

test('refs, HEAD and worktree status are unchanged by a run (clean and conflicting)', t => {
  const { repo, git, write, base } = fixtureRepo(t);
  write('b.txt', 'two\n'); git('add', '.'); git('commit', '-qm', 'ticket');
  const candidate = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main'); write('b.txt', 'other\n'); git('add', '.'); git('commit', '-qm', 'main moves');
  write('untracked.txt', 'u\n'); write('a.txt', 'dirty\n');
  const before = snapshot(git);
  const args = ['--repo', repo, '--target', 'main', '--candidate', candidate, '--branch', 'ticket', '--verified-base', base];
  assert.equal(cli(args).status, EXIT.stop);
  assert.deepEqual(snapshot(git), before);
  git('checkout', '-q', '--', 'a.txt');
  git('checkout', '-q', 'ticket');
  const before2 = snapshot(git);
  assert.equal(cli([...args.slice(0, 2), '--target', 'ticket', ...args.slice(4)]).status, EXIT.ok);
  assert.deepEqual(snapshot(git), before2);
});
