#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { autostart } from './autostart.mjs';

const usage = 'inbox.mjs setup --answers <public-answers.json>|doctor|add-device|phone-qr [--png <private-file.png>]|install|uninstall|status|register <dir>|unregister <campaign>|ask <campaign> <题稿.json>|pending <campaign>|ack <id>|forward <id> --to <标签>|close <id> [--by orchestrator] [--note <说明>]|health|rotate-token|set-webhook <campaign>';

export function parseCommand(argv) {
  const [command, ...args] = argv; const values = []; const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (!['to', 'by', 'note', 'campaign', 'answers', 'png'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数 ${args[i]} 无效或缺值`);
      flags[key] = args[++i];
    } else values.push(args[i]);
  }
  const arities = { setup: 0, doctor: 0, 'phone-qr': 0, 'add-device': 0, install: 0, uninstall: 0, status: 0, register: 1, unregister: 1, ask: 2, pending: 1, ack: 1, forward: 1, close: 1, health: 0, 'rotate-token': 0, 'set-webhook': 1 };
  if (!(command in arities) || values.length !== arities[command]) throw new Error(usage);
  const allowed = { setup: ['answers'], 'phone-qr': ['png'], ack: ['campaign'], forward: ['to', 'campaign'], close: ['by', 'note', 'campaign'] }[command] || [];
  if (Object.keys(flags).some(k => !allowed.includes(k))) throw new Error('此命令不支持这些参数');
  if (command === 'forward' && !flags.to) throw new Error('forward 需要 --to <标签>');
  if (flags.by && flags.by !== 'orchestrator') throw new Error('--by 只接受 orchestrator');
  if (command === 'setup' && !flags.answers) throw new Error('Use /orchestration setup to gather answers, then setup --answers <public-answers.json>.');
  return { command, values, flags };
}

async function stdinText(input) { let result = ''; for await (const chunk of input) result += chunk; return result.trim(); }

async function privateStdin(input) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return stdinText(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let text = '';
    const cleanup = () => { input.off('data', onData); input.off('end', onEnd); input.setRawMode(Boolean(wasRaw)); input.pause(); };
    const onEnd = () => { cleanup(); resolve(text.trim()); };
    const onData = chunk => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { cleanup(); reject(new Error('已取消')); return; }
        if (char === '\r' || char === '\n' || char === '\u0004') { onEnd(); return; }
        if (char === '\u007f' || char === '\b') text = text.slice(0, -1); else text += char;
      }
    };
    input.on('data', onData); input.once('end', onEnd);
  });
}

export async function main(argv = process.argv.slice(2), { home = process.env.INBOX_HOME || homedir(), input = process.stdin, output = process.stdout, fetchImpl = fetch, autostartImpl = autostart } = {}) {
  const { command, values, flags } = parseCommand(argv);
  if (command === 'doctor') {
    const { doctor } = await import('./doctor.mjs');
    const result = await doctor({ home, startup: autostartImpl, fetchImpl });
    output.write(JSON.stringify(result, null, 2) + '\n'); return result;
  }
  if (command === 'setup') {
    const { setup } = await import('./setup.mjs');
    const answers = JSON.parse(await readFile(flags.answers, 'utf8'));
    const result = await setup(answers, { home, startup: autostartImpl, fetchImpl });
    output.write(JSON.stringify(result) + '\n'); return result;
  }
  if (['phone-qr', 'add-device'].includes(command) && !output.isTTY) throw new Error('Login QR requires a local interactive terminal; do not log or capture it.');
  if (command === 'rotate-token' && !output.isTTY) throw new Error('新口令链接只允许显示在本机交互终端');
  if (['install', 'uninstall', 'status'].includes(command)) {
    const result = await autostartImpl(command, { home }); output.write(JSON.stringify(result) + '\n'); return result;
  }
  // Only public machine configuration is read here. All data mutations go through the server.
  const { loadConfig } = await import('./config.mjs'); const config = await loadConfig({ home });
  const body = { ...flags };
  if (command === 'register') body.dir = path.resolve(values[0]);
  if (['unregister', 'pending', 'set-webhook', 'ask'].includes(command)) body.campaign = values[0];
  if (['ack', 'forward', 'close'].includes(command)) body.id = values[0];
  if (command === 'ask') {
    try { body.item = JSON.parse(await readFile(values[1], 'utf8')); } catch { throw new Error('题稿不是可读的 JSON 文件'); }
  }
  if (command === 'set-webhook') { body.url = await privateStdin(input); if (!body.url) throw new Error('请从标准输入提供 webhook 地址'); }
  let response;
  try { response = await fetchImpl(`http://127.0.0.1:${config.port}/admin/${command === 'phone-qr' ? 'rotate-token' : command}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('无法连接本机 Inbox 服务；请检查 status'); }
  let result; try { result = await response.json(); } catch { throw new Error('本机 Inbox 服务返回无效响应'); }
  if (!response.ok) throw new Error(['set-webhook', 'rotate-token', 'phone-qr', 'add-device'].includes(command) ? '私有配置更新失败' : result.error || 'Inbox 命令失败');
  if (['phone-qr', 'add-device'].includes(command)) {
    const { qrMatrix, qrTerminal, qrPng } = await import('./qr.mjs');
    if (typeof result.url !== 'string') throw new Error('Login QR response is invalid.');
    const matrix = qrMatrix(result.url);
    if (flags.png) await writeFile(flags.png, qrPng(matrix), { mode: 0o600, flag: 'wx' });
    output.write(qrTerminal(matrix));
    output.write(command === 'add-device' ? 'Scan locally within 5 minutes. Single use; existing sessions stay signed in. Do not record this QR. / 请在五分钟内扫码，仅限一次，已有登录不变。\n' : 'Scan locally. Passphrase rotated; previous sessions are invalid. Do not record this QR.\n');
    return { ok: true }; // Never return the login URL to callers/loggers.
  }
  if (command === 'ask') output.write(`${result.id || result.item?.id}\n`);
  else if (command === 'rotate-token') output.write(`${result.url}\n`);
  else if (command === 'set-webhook') output.write('通知地址已保存\n');
  else output.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
