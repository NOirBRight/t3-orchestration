#!/usr/bin/env node
/**
 * Risk-tiered merge precheck for housekeeping / orchestrator merges.
 *
 * Decides whether a verified candidate needs the HK zero-context AI recheck
 * ("recheck") or only the scripted precheck ("scripted"). See HOUSEKEEPING.md
 * § Risk-tiered merge checks and decision 53.
 *
 * recheck when any of:
 *   - a changed path (either end of a rename) matches a risk trigger;
 *   - the target moved since verification (verified base != current target),
 *     which also means re-verify.
 * The scripted precheck itself (candidate SHA assert, merge-tree conflict
 * check, diff --check) must pass for either tier; failures stop the merge.
 *
 * CLI:
 *   node merge-risk.mjs --repo <dir> --target <branch> --candidate <sha>
 *     --branch <ticket-branch> --verified-base <sha>
 *     [--project <docs/agents/orchestration.md>] [--triggers-file <json>]
 * Always prints one JSON object on stdout, also on errors
 * ({ ok:false, error:{ type, message } }).
 * Exit 0 = may proceed (see tier), 1 = precheck stop (conflict, diff-check,
 * candidate mismatch), 2 = usage/config error, 3 = tool error (git failed,
 * unsupported git, bad ref). Treat any non-zero exit as "do not merge".
 *
 * Never moves a ref and never touches a worktree or the index. Note:
 * `git merge-tree --write-tree` writes unreferenced loose objects (trees/blobs)
 * into the object store; `git gc` prunes them.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXIT = Object.freeze({ ok: 0, stop: 1, usage: 2, tool: 3 });

/** Default triggers. Projects override with `mergeRiskTriggers` (PROJECT.md § Housekeeping). */
export const DEFAULT_RISK_TRIGGERS = Object.freeze([
  // shared test config / lists / runners
  'package.json', 'package-lock.json', '**/test-list*', '**/run-tests*', '**/test-runner*',
  'tests/list*.txt', '**/tests/list*.txt', 'test/manifest.json', '**/test/manifest.json',
  'tools/test_*.py', 'tools/test-*.ps1', '**/tools/test_*.py', '**/tools/test-*.ps1',
  '**/jest.config.*', '**/vitest.config.*', '**/vite.config.*', '**/playwright.config.*',
  '**/pytest.ini', '**/conftest.py', '**/tox.ini',
  // lockfiles / dependency manifests
  '**/yarn.lock', '**/.yarnrc*', '**/pnpm-lock.yaml', '**/pnpm-workspace.yaml',
  '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum',
  '**/pyproject.toml', '**/requirements*.txt', '**/.npmrc',
  // build / release / signing
  'scripts/release/**', 'build.rs', '**/build.gradle', '**/build.gradle.kts', '**/build.sh', '**/build.ps1',
  '**/build.cmd', '**/build.bat', '**/build.py', '**/build.mjs', '**/build.js', '**/build.ts',
  '**/Makefile', '**/*.gradle', '**/*.gradle.kts', '**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile',
  '**/*signing*', '**/sign-*', '**/*.keystore', '**/*.jks',
  // CI
  '.github/**', '.gitlab-ci.yml', '.circleci/**', '**/Jenkinsfile', '**/azure-pipelines*.yml',
  // agent rules / orchestration tooling (incl. this script)
  'AGENTS.md', '**/AGENTS.md', '.cursor/rules/**', '**/RULES-*.md', 'orchestration/scripts/**',
]);

export class MergeRiskError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * @param {string[]} files changed paths (repo-relative, `/` separators)
 * @param {string[]} triggers glob list
 * @returns {{ file: string, trigger: string }[]}
 */
export function matchRiskTriggers(files, triggers = DEFAULT_RISK_TRIGGERS) {
  const compiled = triggers.map(trigger => ({ trigger, re: globToRegExp(trigger) }));
  const hits = [];
  for (const raw of files) {
    const file = raw.replace(/\\/g, '/');
    const hit = compiled.find(({ re }) => re.test(file));
    if (hit) hits.push({ file, trigger: hit.trigger });
  }
  return hits;
}

/**
 * Pure tier decision.
 * @param {{ files: string[], triggers?: string[], verifiedBase?: string, currentBase?: string }} input
 */
export function classifyMergeRisk({ files, triggers = DEFAULT_RISK_TRIGGERS, verifiedBase, currentBase }) {
  const hits = matchRiskTriggers(files, triggers);
  const reasons = [];
  const baseMoved = Boolean(verifiedBase && currentBase && verifiedBase !== currentBase);
  if (hits.length) reasons.push('risk-path');
  if (baseMoved) reasons.push('base-moved');
  return { tier: reasons.length ? 'recheck' : 'scripted', reasons, riskFiles: hits, baseMoved, reverify: baseMoved };
}

function splitList(value) {
  return value.split(',').map(item => item.trim().replace(/^`|`$/g, '').trim()).filter(Boolean);
}

/**
 * Read `mergeRiskTriggers` and `postMergeBatch` from a project settings file
 * (PROJECT.md template, `## Housekeeping` bullets). Trigger value: `default`,
 * or a comma-separated glob list (backticks optional); a `default` entry in the
 * list expands to the built-in list, so `default, core/shared/**` extends it.
 * @returns {{ triggers: string[] | null, postMergeBatch: number }}
 */
export function parseProjectHousekeeping(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let inSection = false;
  const fields = {};
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) { inSection = /^housekeeping$/i.test(heading[2]); continue; }
    if (!inSection) continue;
    const bullet = /^\s*[-*]\s+`?(mergeRiskTriggers|postMergeBatch)`?\s*:\s*(.*?)\s*$/.exec(line);
    if (bullet) fields[bullet[1]] = bullet[2];
  }
  let triggers = null;
  if (fields.mergeRiskTriggers !== undefined) {
    const items = splitList(fields.mergeRiskTriggers);
    if (!items.length || items.some(item => item.startsWith('<'))) {
      throw new MergeRiskError('config', 'mergeRiskTriggers is empty or still a template placeholder');
    }
    triggers = items.flatMap(item => (item.toLowerCase() === 'default' ? DEFAULT_RISK_TRIGGERS : [item]));
  }
  let postMergeBatch = 1;
  if (fields.postMergeBatch !== undefined && !fields.postMergeBatch.startsWith('<')) {
    const raw = fields.postMergeBatch.replace(/`/g, '').trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new MergeRiskError('config', `postMergeBatch must be a positive integer, got "${raw}"`);
    postMergeBatch = Number(raw);
  }
  if (postMergeBatch > 1) {
    throw new MergeRiskError('unimplemented', `postMergeBatch=${postMergeBatch} is not implemented; only 1 (one full suite per merge) is supported`);
  }
  return { triggers, postMergeBatch };
}

function runGit(repo, args) {
  try {
    return { status: 0, stdout: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }), stderr: '' };
  } catch (error) {
    if (typeof error.status !== 'number') throw new MergeRiskError('tool', `git not runnable: ${error.code || error.message}`);
    return { status: error.status, stdout: `${error.stdout || ''}`, stderr: `${error.stderr || ''}` };
  }
}

function git(repo, args) {
  const result = runGit(repo, args);
  if (result.status !== 0) throw new MergeRiskError('tool', `git ${args[0]} failed (exit ${result.status}): ${result.stderr.trim().split('\n')[0] || 'no message'}`);
  return result.stdout;
}

function revParse(repo, ref, label) {
  const result = runGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.status !== 0) throw new MergeRiskError('tool', `${label} "${ref}" is not a commit in this repo`);
  return result.stdout.trim();
}

/** Changed paths with both ends of renames/copies. */
export function changedFiles(repo, from, to) {
  const out = git(repo, ['diff', '--no-renames', '--name-only', '-z', `${from}..${to}`]);
  return [...new Set(out.split('\0').filter(Boolean))];
}

/** Run the scripted precheck against a real repo (no ref, index or worktree change). */
export function precheck({ repo, target, candidate, branch, verifiedBase, triggers = DEFAULT_RISK_TRIGGERS }) {
  if (!verifiedBase) throw new MergeRiskError('usage', 'verifiedBase is required (the target SHA the candidate was verified on)');
  const stops = [];
  const branchHead = revParse(repo, branch, 'branch');
  const candidateSha = revParse(repo, candidate, 'candidate');
  if (branchHead !== candidateSha) stops.push('candidate-not-branch-head');
  const currentBase = revParse(repo, target, 'target');
  const verifiedSha = revParse(repo, verifiedBase, 'verified base');
  const mergeBase = git(repo, ['merge-base', currentBase, candidateSha]).trim();
  const files = changedFiles(repo, mergeBase, candidateSha);
  // merge-tree --write-tree: exit 0 clean, 1 conflicts; anything else (e.g. old
  // git without --write-tree, exit 129) is a tool error, not a conflict.
  const tree = runGit(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', currentBase, candidateSha]);
  let conflicts = [];
  if (tree.status === 1) {
    conflicts = tree.stdout.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
    stops.push('merge-conflict');
  } else if (tree.status !== 0) {
    throw new MergeRiskError('tool', `git merge-tree --write-tree failed (exit ${tree.status}); needs git >= 2.38: ${tree.stderr.trim().split('\n')[0] || 'no message'}`);
  }
  // diff --check: exit 0 clean; whitespace problems exit non-zero with findings on stdout.
  const check = runGit(repo, ['diff', '--check', `${mergeBase}..${candidateSha}`]);
  if (check.status !== 0) {
    if (check.status >= 128 || !check.stdout.trim()) throw new MergeRiskError('tool', `git diff --check failed (exit ${check.status}): ${check.stderr.trim().split('\n')[0] || 'no message'}`);
    stops.push('diff-check');
  }
  const risk = classifyMergeRisk({ files, triggers, verifiedBase: verifiedSha, currentBase });
  return {
    ok: stops.length === 0,
    stops,
    candidate: candidateSha,
    target,
    currentBase,
    verifiedBase: verifiedSha,
    files,
    conflicts,
    ...risk,
  };
}

const FLAGS = Object.freeze(['repo', 'target', 'candidate', 'branch', 'verified-base', 'triggers-file', 'project']);
const REQUIRED = Object.freeze(['repo', 'target', 'candidate', 'branch', 'verified-base']);
const USAGE = 'usage: merge-risk.mjs --repo <dir> --target <branch> --candidate <sha> --branch <branch> --verified-base <sha> [--project <settings.md>] [--triggers-file <json array>]';

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new MergeRiskError('usage', `unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!FLAGS.includes(name)) throw new MergeRiskError('usage', `unknown option --${name}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new MergeRiskError('usage', `--${name} needs a value`);
    if (Object.hasOwn(flags, name)) throw new MergeRiskError('usage', `--${name} given twice`);
    flags[name] = value;
  }
  for (const key of REQUIRED) if (!flags[key]) throw new MergeRiskError('usage', `missing --${key}`);
  if (flags['triggers-file'] && flags.project) throw new MergeRiskError('usage', 'use either --triggers-file or --project, not both');
  return flags;
}

function loadTriggers(flags) {
  if (flags['triggers-file']) {
    let triggers;
    try {
      triggers = JSON.parse(fs.readFileSync(flags['triggers-file'], 'utf8'));
    } catch (error) {
      throw new MergeRiskError('config', `cannot read triggers file: ${error.message}`);
    }
    if (!Array.isArray(triggers) || !triggers.length || !triggers.every(item => typeof item === 'string' && item)) {
      throw new MergeRiskError('config', 'triggers file must be a non-empty JSON array of globs');
    }
    return { triggers, triggerSource: 'triggers-file', postMergeBatch: 1 };
  }
  if (flags.project) {
    let text;
    try {
      text = fs.readFileSync(flags.project, 'utf8');
    } catch (error) {
      throw new MergeRiskError('config', `cannot read project settings: ${error.message}`);
    }
    const parsed = parseProjectHousekeeping(text);
    return { triggers: parsed.triggers || DEFAULT_RISK_TRIGGERS, triggerSource: parsed.triggers ? 'project' : 'default', postMergeBatch: parsed.postMergeBatch };
  }
  return { triggers: DEFAULT_RISK_TRIGGERS, triggerSource: 'default', postMergeBatch: 1 };
}

const EXIT_BY_TYPE = { usage: EXIT.usage, config: EXIT.usage, unimplemented: EXIT.usage, tool: EXIT.tool };

/** CLI core; returns { exitCode, result } and never throws. */
export function run(argv) {
  try {
    const flags = parseArgs(argv);
    const { triggers, triggerSource, postMergeBatch } = loadTriggers(flags);
    const result = precheck({ repo: flags.repo, target: flags.target, candidate: flags.candidate, branch: flags.branch, verifiedBase: flags['verified-base'], triggers });
    return { exitCode: result.ok ? EXIT.ok : EXIT.stop, result: { ...result, triggerSource, postMergeBatch } };
  } catch (error) {
    const type = error instanceof MergeRiskError ? error.type : 'internal';
    const result = { ok: false, error: { type, message: error.message } };
    if (type === 'usage') result.usage = USAGE;
    return { exitCode: EXIT_BY_TYPE[type] ?? EXIT.tool, result };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, result } = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.error) process.stderr.write(`merge-risk: ${result.error.type}: ${result.error.message}\n`);
  process.exitCode = exitCode;
}
