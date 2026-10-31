#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { autostart } from './autostart.mjs';

const usage = 'inbox.mjs setup --answers <public-answers.json>|doctor|add-device|phone-qr [--png <private-file.png>]|install|uninstall|status|register <dir>|unregister <campaign>|ask <campaign> <题稿.json>|pending <campaign>|ack <id> [--submission <submissionId>]|forward <id> --to <标签>|close <id> [--by orchestrator] [--note <说明>]|health|rotate-token|set-webhook <campaign>|relay set|status|revoke|resend <campaign> [id]|route <campaign> <type> [--ticket <id>]|routes [campaign]|catalog-write [--allow-missing]|routing-import [--force]|quota mark|clear <instanceId/model> [--resume <ISO>] [--by orchestrator|owner]';

export function parseCommand(argv) {
  const [command, ...args] = argv; const values = []; const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (key === 'force') { flags.force = true; continue; }
      if (key === 'allow-missing') { flags['allow-missing'] = true; continue; }
      if (key === 'allow-option-removal') { flags['allow-option-removal'] = true; continue; }
      if (!['to', 'by', 'note', 'campaign', 'answers', 'png', 'resume', 'submission', 'ticket'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数 ${args[i]} 无效或缺值`);
      flags[key] = args[++i];
    } else values.push(args[i]);
  }
  const arities = {
    setup: 0, doctor: 0, 'phone-qr': 0, 'add-device': 0, install: 0, uninstall: 0, status: 0,
    register: 1, unregister: 1, ask: 2, pending: 1, ack: 1, forward: 1, close: 1, health: 0,
    'rotate-token': 0, 'set-webhook': 1, relay: [2, 3],
    route: 2, routes: [0, 1], 'catalog-write': 0, 'routing-import': 0, quota: 2,
  };
  if (!(command in arities)) throw new Error(usage);
  const arity = arities[command];
  const ok = Array.isArray(arity) ? values.length >= arity[0] && values.length <= arity[1] : values.length === arity;
  if (!ok) throw new Error(usage);
  const allowed = {
    setup: ['answers'], 'phone-qr': ['png'], ack: ['campaign', 'submission'], forward: ['to', 'campaign'],
    close: ['by', 'note', 'campaign'], 'routing-import': ['force'], 'catalog-write': ['allow-missing', 'allow-option-removal'], quota: ['resume', 'by'],
    route: ['ticket'],
  }[command] || [];
  if (Object.keys(flags).some(k => !allowed.includes(k))) throw new Error('此命令不支持这些参数');
  if (command === 'forward' && !flags.to) throw new Error('forward 需要 --to <标签>');
  if (flags.by && !['orchestrator', 'owner'].includes(flags.by)) throw new Error('--by 只接受 orchestrator 或 owner');
  if (command === 'close' && flags.by && flags.by !== 'orchestrator') throw new Error('--by 只接受 orchestrator');
  if (command === 'setup' && !flags.answers) throw new Error('Use /orchestration setup to gather answers, then setup --answers <public-answers.json>.');
  if (command === 'quota' && !['mark', 'clear'].includes(values[0])) throw new Error('quota 子命令只支持 mark 或 clear');
  if (command === 'relay') {
    const sub = values[0];
    if (!['set', 'status', 'revoke', 'resend'].includes(sub)) throw new Error('relay 子命令只支持 set、status、revoke、resend');
    if (sub === 'resend' && values.length !== 3) throw new Error('relay resend 需要 <campaign> <题号>');
    if (sub !== 'resend' && values.length !== 2) throw new Error(`relay ${sub} 需要 <campaign>`);
  }
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
  if (command === 'relay' && values[0] === 'set' && !output.isTTY) throw new Error('中继令牌只允许显示在本机交互终端');
  if (['install', 'uninstall', 'status'].includes(command)) {
    const result = await autostartImpl(command, { home }); output.write(JSON.stringify(result) + '\n'); return result;
  }
  if (['route', 'routes', 'catalog-write', 'routing-import', 'quota'].includes(command)) {
    const { loadConfig } = await import('./config.mjs');
    const {
      emptyRoutingDocument, seedBuiltinRouting, loadRouting, resolveAll, resolveRoute, saveRouting, setQuota, writeCatalog, routingPath,
    } = await import('./routing.mjs');
    const { publishRoutingChange } = await import('./routing-events.mjs');
    const fs = await import('node:fs');
    const config = loadConfig({ home });
    const campaignDir = campaignId => {
      if (!campaignId) return null;
      const campaign = config.campaigns.find(item => item.id === campaignId);
      if (!campaign) throw new Error(`未注册的 Campaign：${campaignId}`);
      return campaign.dir;
    };
    if (command === 'routing-import') {
      if (fs.existsSync(routingPath(home)) && !flags.force) throw new Error('routing.json 已存在；确认覆盖请加 --force');
      const before = fs.existsSync(routingPath(home)) ? loadRouting(home) : emptyRoutingDocument();
      const document = seedBuiltinRouting();
      saveRouting(home, document);
      // A fresh import matches the built-in defaults, so only a real overwrite emits a change event.
      const published = await publishRoutingChange({
        config,
        scope: 'global',
        beforeLayer: before.global,
        afterLayer: document.global,
        routingVersion: document.version,
        changedBy: 'cli',
        fetchImpl,
      });
      output.write(JSON.stringify({ ok: true, path: routingPath(home), version: document.version, routingEvent: published.deliveries }, null, 2) + '\n');
      return document;
    }
    if (command === 'catalog-write') {
      const text = await stdinText(input);
      if (!text) throw new Error('请从标准输入提供 orchestrator_capabilities JSON');
      let capabilities;
      try { capabilities = JSON.parse(text); } catch { throw new Error('标准输入不是合法 JSON'); }
      const document = writeCatalog(home, capabilities, { campaignDirs: config.campaigns.map(c => c.dir), allowMissing: Boolean(flags['allow-missing']), allowOptionRemoval: Boolean(flags['allow-option-removal']) });
      if (document.missing) process.stderr.write(`警告：catalog.json 缺少路由使用的模型，这些路由将失效：${document.missing.join(', ')}\n`);
      output.write(JSON.stringify({ ok: !document.missing, capturedAt: document.capturedAt, missing: document.missing || [] }, null, 2) + '\n');
      return document;
    }
    if (command === 'quota') {
      const [, key] = values;
      const before = loadRouting(home);
      const result = setQuota(home, {
        key,
        exhausted: values[0] === 'mark',
        resumeAt: flags.resume || null,
        markedBy: flags.by || 'orchestrator',
        expectedVersion: before.version,
      });
      const after = loadRouting(home);
      const published = await publishRoutingChange({
        config,
        scope: 'global',
        beforeLayer: before.global,
        afterLayer: after.global,
        routingVersion: after.version,
        changedBy: 'cli',
        fetchImpl,
      });
      output.write(JSON.stringify({ ...result, routingEvent: published.deliveries }, null, 2) + '\n');
      return result;
    }
    if (command === 'route') {
      const dir = campaignDir(values[0]);
      // Dispatch must pass --ticket; blank/missing title is refused (DISPATCH.md / P33).
      // threadTitle is the required t3_thread_launch title (id：short title; P35).
      let ticketMeta = null;
      if (flags.ticket) {
        const { requireLaunchThreadTitle } = await import('../scripts/dispatch-template.mjs');
        ticketMeta = requireLaunchThreadTitle(dir, flags.ticket);
      }
      const result = resolveRoute({
        home,
        machine: config.name,
        campaignDir: dir,
        type: values[1],
      });
      if (ticketMeta) Object.assign(result, ticketMeta);
      output.write(JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    const result = resolveAll({
      home,
      machine: config.name,
      campaignDir: campaignDir(values[0]),
    });
    // Keep a copy of loadRouting so empty installs still surface version metadata.
    const routing = loadRouting(home);
    result.version = routing.version;
    result.updatedAt = routing.updatedAt;
    output.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }
  // Only public machine configuration is read here. All data mutations go through the server.
  const { loadConfig, privateText } = await import('./config.mjs'); const config = await loadConfig({ home });
  const adminToken = privateText(config.privateDir, 'admin-token');
  if (!adminToken) throw new Error('缺少管理令牌；请运行 setup 或启动一次 Inbox 服务以生成');
  const body = { ...flags };
  let adminCommand = command === 'phone-qr' ? 'rotate-token' : command;
  if (command === 'register') body.dir = path.resolve(values[0]);
  if (['unregister', 'pending', 'set-webhook', 'ask'].includes(command)) body.campaign = values[0];
  if (['ack', 'forward', 'close'].includes(command)) body.id = values[0];
  if (command === 'ask') {
    try { body.item = JSON.parse(await readFile(values[1], 'utf8')); } catch { throw new Error('题稿不是可读的 JSON 文件'); }
  }
  if (command === 'set-webhook') { body.url = await privateStdin(input); if (!body.url) throw new Error('请从标准输入提供 webhook 地址'); }
  if (command === 'relay') {
    const sub = values[0];
    body.campaign = values[1];
    adminCommand = `relay-${sub}`;
    if (sub === 'resend') body.id = values[2];
    if (sub === 'set') {
      body.bridgeUrl = await privateStdin(input);
      if (!body.bridgeUrl) throw new Error('请从标准输入提供桥地址');
    }
  }
  let response;
  try { response = await fetchImpl(`http://127.0.0.1:${config.port}/admin/${adminCommand}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Inbox-Admin': adminToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('无法连接本机 Inbox 服务；请检查 status'); }
  let result; try { result = await response.json(); } catch { throw new Error('本机 Inbox 服务返回无效响应'); }
  if (!response.ok) throw new Error(['set-webhook', 'rotate-token', 'phone-qr', 'add-device', 'relay'].includes(command) ? '私有配置更新失败' : result.error || 'Inbox 命令失败');
  if (['phone-qr', 'add-device'].includes(command)) {
    const { qrMatrix, qrTerminal, qrPng } = await import('./qr.mjs');
    if (typeof result.url !== 'string') throw new Error('Login QR response is invalid.');
    const matrix = qrMatrix(result.url);
    if (flags.png) await writeFile(flags.png, qrPng(matrix), { mode: 0o600, flag: 'wx' });
    output.write(qrTerminal(matrix));
    if (command === 'add-device') {
      if (typeof result.code !== 'string' || !result.code.trim()) throw new Error('Login code response is invalid.');
      output.write(`${result.code}\n`);
      output.write('One-time code above, or scan QR. 5 minutes, single use; existing sessions stay signed in. Do not record. / 上方一次性码或扫码，五分钟内一次有效，已有登录不变。勿记录。\n');
    } else {
      output.write('Scan locally. Passphrase rotated; previous sessions are invalid. Do not record this QR.\n');
    }
    return { ok: true }; // Never return the login URL or code to callers/loggers.
  }
  if (command === 'ask') output.write(`${result.id || result.item?.id}\n`);
  else if (command === 'rotate-token') output.write(`${result.url}\n`);
  else if (command === 'set-webhook') output.write('通知地址已保存\n');
  else if (command === 'relay' && values[0] === 'set') {
    // Show secrets once on an interactive TTY only; never return them to callers.
    output.write(`中继已启用 tokenId=${result.tokenId}\n`);
    output.write(`inboundToken=${result.tokenId}.${result.inboundToken}\n`);
    output.write(`signingSecret=${result.signingSecret}\n`);
    output.write('请立即保存；之后无法再查看明文。\n');
    return { ok: true, tokenId: result.tokenId, enabled: result.enabled };
  }
  else if (command === 'relay' && values[0] === 'revoke') output.write('中继已撤销\n');
  else output.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
