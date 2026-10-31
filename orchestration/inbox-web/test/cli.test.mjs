import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { parseCommand, main } from '../inbox.mjs';
import { loadConfig, privateText } from '../config.mjs';
import { autostart, linuxUnit, windowsTask, windowsLauncher } from '../autostart.mjs';

test('CLI 命令和必填参数', () => {
  assert.deepEqual(parseCommand(['forward', 'Q1', '--to', '执行会话']), { command: 'forward', values: ['Q1'], flags: { to: '执行会话' } });
  assert.throws(() => parseCommand(['forward', 'Q1']), /--to/);
  assert.throws(() => parseCommand(['close', 'Q1', '--by', 'owner']), /orchestrator/);
  assert.throws(() => parseCommand(['health', '--note', 'x']), /不支持/);
});

test('rotate-token 拒绝把秘密写到重定向输出', async () => { await assert.rejects(main(['rotate-token'], { output: { isTTY: false } }), /本机交互终端/); });

test('CLI 经本机管理接口发送题稿，webhook 标准输入不回显', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  const config = loadConfig({ home }); privateText(config.privateDir, 'admin-token', 'cli-admin-token');
  const file = path.join(home, 'question.json'); await writeFile(file, JSON.stringify({ kind: 'accept', title: '验收' }));
  let printed = ''; const requests = [];
  const options = { home, output: { write: text => { printed += text; } }, fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body), headers: init.headers }); return Response.json({ id: 'A1', ok: true }); } };
  await main(['ask', 'campaign', file], options);
  assert.equal(requests[0].url, 'http://127.0.0.1:8780/admin/ask'); assert.equal(requests[0].body.item.kind, 'accept'); assert.equal(requests[0].headers['X-Inbox-Admin'], 'cli-admin-token'); assert.equal(printed, 'A1\n');
  printed = '';
  await main(['set-webhook', 'campaign'], { ...options, input: Readable.from(['https://example.test/private-test-hook']) });
  assert.equal(requests[1].body.url, 'https://example.test/private-test-hook'); assert.equal(printed, '通知地址已保存\n');
});

test('CLI 私有配置错误不输出服务器返回的地址', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  const config = loadConfig({ home }); privateText(config.privateDir, 'admin-token', 'cli-admin-token');
  await assert.rejects(main(['set-webhook', 'campaign'], { home, input: Readable.from(['https://example.test/hook']), fetchImpl: async () => Response.json({ error: 'https://example.test/hook' }, { status: 400 }) }), /^Error: 私有配置更新失败$/);
});

test('自启模板引用实际 Node 和服务路径，Windows 隐藏窗口并崩溃重启', () => {
  const unit = linuxUnit('/opt/node path/node', '/srv/trial/skill/server.mjs', '/srv/trial');
  assert.match(unit, /ExecStart="\/opt\/node path\/node"/); assert.match(unit, /Restart=on-failure/);
  const launcher = windowsLauncher('C:\\Program Files\\node.exe', "E:\\a'b & 中文\\server.mjs", "C:\\Trial\\a'b");
  assert.match(launcher, /^\$ErrorActionPreference = 'Stop'\n\(Get-Process -Id \$PID\)\.PriorityClass = 'Normal'\n/);
  assert.match(launcher, /-WindowStyle Hidden -PassThru/); assert.match(launcher, /\$inboxProcess.WaitForExit\(\)/);
  assert.match(launcher, /while \(\$true\)/); assert.match(launcher, /if \(\$inboxExitCode -eq 0\) \{ exit 0 \}/); assert.match(launcher, /Start-Sleep -Seconds 5/);
  assert.match(launcher, /ParentProcessId = .*\$inboxProcess.Id.*AND Name = 'ssh.exe'/);
  assert.ok(launcher.includes("$env:INBOX_HOME = 'C:\\Trial\\a''b'"));
  assert.ok(launcher.includes("-ArgumentList '\"E:\\a''b & 中文\\server.mjs\"'"));
  const task = windowsTask('E:\\Inbox\\a&b\\inbox-launcher.ps1', 'DOMAIN\\user&name');
  assert.match(task, /<Command>conhost.exe<\/Command>/);
  assert.ok(task.includes('--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File &quot;E:\\Inbox\\a&amp;b\\inbox-launcher.ps1&quot;</Arguments>'));
  assert.doesNotMatch(task, /EncodedCommand/);
  assert.match(task, /LogonTrigger/); assert.match(task, /RestartOnFailure/); assert.match(task, /user&amp;name/); assert.match(task, /PT0S/);
});

test('Linux install/uninstall 经用户级 systemd，文件路径与实际 home 一致', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-startup-')); t.after(() => rm(home, { recursive: true, force: true }));
  const calls = []; const options = { home, platform: 'linux', nodePath: '/bin/node', serverPath: '/skill/server.mjs', run: async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; } };
  await autostart('install', options);
  assert.match(await readFile(path.join(home, '.config/systemd/user/orchestration-inbox.service'), 'utf8'), /\/skill\/server.mjs/);
  assert.deepEqual(calls[1], ['systemctl', '--user', 'enable', '--now', 'orchestration-inbox.service']);
  await autostart('uninstall', options); assert.deepEqual(calls[2], ['systemctl', '--user', 'disable', '--now', 'orchestration-inbox.service']);
});

test('Windows install 写出启动器文件、启动计划任务并删除临时 XML', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-startup-')); t.after(() => rm(home, { recursive: true, force: true }));
  const calls = []; const options = { home, platform: 'win32', user: 'test', nodePath: 'C:\\node.exe', serverPath: 'C:\\skill\\server.mjs', run: async (file, args) => { calls.push([file, ...args]); return {}; } };
  await autostart('install', options);
  assert.deepEqual(calls.filter(call => call[0] === 'schtasks.exe').map(call => call[1]), ['/Query', '/End', '/Create', '/Run']);
  assert.equal(calls.find(call => call[0] === 'powershell.exe')[1], '-NoProfile');
  await assert.rejects(readFile(path.join(home, '.agents/orchestration/inbox-task.xml')));
  const launcherFile = path.join(home, '.agents/orchestration/inbox-launcher.ps1');
  assert.equal(await readFile(launcherFile, 'utf8'), '\ufeff' + windowsLauncher('C:\\node.exe', 'C:\\skill\\server.mjs', home));
  await autostart('uninstall', options); await assert.rejects(readFile(launcherFile));
});

// 计划任务里由 conhost --headless 运行同一个文件；这里直接用 PowerShell 跑装好的文件。
async function installedLauncher(t, script) {
  const home = await mkdtemp(path.join(os.tmpdir(), "inbox user's 中文-")); t.after(() => rm(home, { recursive: true, force: true }));
  const nodeScript = path.join(home, 'node child.mjs'); await writeFile(nodeScript, script);
  await autostart('install', { home, platform: 'win32', user: 'test', nodePath: process.execPath, serverPath: nodeScript, run: async () => ({}) });
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(home, '.agents', 'orchestration', 'inbox-launcher.ps1')], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  return { home, run };
}

test('Windows 启动器文件支持带空格、单引号和中文的路径，Node 正常退出后结束', { skip: process.platform !== 'win32' }, async t => {
  const { run } = await installedLauncher(t, 'import path from "node:path"; import { fileURLToPath } from "node:url"; process.exit(process.env.INBOX_HOME === path.dirname(fileURLToPath(import.meta.url)) ? 0 : 24);');
  const result = run();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('Windows 启动器结束上一个 watchdog 并记下自己的 PID', { skip: process.platform !== 'win32' }, async t => {
  const { home, run } = await installedLauncher(t, 'process.exit(0);');
  const previous = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Sleep -Seconds 60 # ${path.join(home, '.agents', 'orchestration', 'inbox-launcher.ps1')}`], { windowsHide: true });
  const ended = new Promise(resolve => previous.once('exit', resolve)); t.after(() => previous.kill());
  const pidFile = path.join(home, '.agents', 'orchestration', 'inbox-watchdog.pid');
  await writeFile(pidFile, `${previous.pid}\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  await ended;
  const recorded = Number(await readFile(pidFile, 'utf8'));
  assert.ok(recorded > 0); assert.notEqual(recorded, previous.pid);
});

test('add-device refuses captured output before any request and never returns link', async t => {
  let called = false;
  await assert.rejects(main(['add-device'], { output: { isTTY: false }, fetchImpl: async () => { called = true; } }), /interactive terminal/);
  assert.equal(called, false);
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-device-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  const config = loadConfig({ home }); privateText(config.privateDir, 'admin-token', 'cli-admin-token');
  let printed = '';
  const result = await main(['add-device'], { home, output: { isTTY: true, write: text => printed += text }, fetchImpl: async (url, init) => {
    assert.match(url, /\/admin\/add-device$/); assert.equal(init.headers['X-Inbox-Admin'], 'cli-admin-token');
    return Response.json({ url: 'https://example.test/?device=synthetic-only', code: 'AB12-CD34', expiresIn: 300 });
  } });
  assert.deepEqual(result, { ok: true });
  assert.doesNotMatch(printed, /synthetic-only|https:/);
  assert.match(printed, /AB12-CD34/);
  assert.match(printed, /5 minutes/);
  assert.match(printed, /single use|仅限一次|一次有效/i);
});
