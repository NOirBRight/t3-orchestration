#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { parseFlags } from './cli-args.mjs';
import { assertPublicReport, deliverExternalReport, loadCampaignMeta, verifyInboundReport } from './orchestrator-target.mjs';

const usageSend = 'report.mjs --campaign-dir <dir> --file <report.json>';
const usageVerify = 'report.mjs verify --campaign-dir <dir> --body-file <file> --headers-file <file>';

function writeResult(output, result, { exit } = {}) {
  // Machine-readable only; never include secrets, URLs, or signature material.
  const safe = result.ok
    ? { ok: true }
    : { ok: false, reason: typeof result.reason === 'string' ? result.reason : 'failed' };
  output.write(`${JSON.stringify(safe)}\n`);
  if (exit && !result.ok) exit(1);
  return safe;
}

export async function main(argv = process.argv.slice(2), {
  home = process.env.INBOX_HOME || homedir(),
  fetchImpl = fetch,
  output = process.stdout,
  now = Date.now,
  exit = code => { process.exitCode = code; },
} = {}) {
  if (argv[0] === 'verify') {
    let flags;
    try {
      flags = parseFlags(argv.slice(1));
    } catch {
      return writeResult(output, { ok: false, reason: 'usage' }, { exit });
    }
    if (!flags['campaign-dir'] || !flags['body-file'] || !flags['headers-file']) {
      return writeResult(output, { ok: false, reason: 'usage' }, { exit });
    }
    let bodyText;
    let headers;
    try {
      bodyText = await readFile(path.resolve(flags['body-file']), 'utf8');
      headers = JSON.parse(await readFile(path.resolve(flags['headers-file']), 'utf8'));
    } catch {
      return writeResult(output, { ok: false, reason: 'read-error' }, { exit });
    }
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
      return writeResult(output, { ok: false, reason: 'bad-headers' }, { exit });
    }
    const result = verifyInboundReport({
      home,
      campaignDir: path.resolve(flags['campaign-dir']),
      bodyText,
      headers,
      now,
    });
    return writeResult(output, result, { exit });
  }

  let flags;
  try {
    flags = parseFlags(argv);
  } catch {
    throw new Error(usageSend);
  }
  if (!flags['campaign-dir'] || !flags.file) throw new Error(usageSend);
  const campaignDir = path.resolve(flags['campaign-dir']);
  const report = JSON.parse(await readFile(path.resolve(flags.file), 'utf8'));
  // Title/ticket rules apply in both modes (DISPATCH.md id：title).
  assertPublicReport({
    ...report,
    schema: report.schema || 'orch-report/1',
  });
  const meta = loadCampaignMeta(campaignDir);
  if (meta.kind === 't3-thread') {
    const result = {
      ok: true,
      mode: 't3-thread',
      threadId: meta.threadId,
      instruction: 'Use t3_thread_send mode=queue to the orchestrator threadId; this CLI does not send T3 messages.',
    };
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const result = await deliverExternalReport({ home, campaignDir, report, fetchImpl, now });
  // Never echo URL, secret, or signature.
  output.write(`${JSON.stringify({ ok: true, mode: 'external', ref: meta.ref, delivered: true }, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // Send path may print a short public error; verify path never reaches here with secrets.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
