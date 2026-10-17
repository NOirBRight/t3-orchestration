import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { parseCommand, main } from '../inbox.mjs';
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
  const file = path.join(home, 'question.json'); await writeFile(file, JSON.stringify({ kind: 'accept', title: '验收' }));
  let printed = ''; const requests = [];
  const options = { home, output: { write: text => { printed += text; } }, fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return Response.json({ id: 'A1', ok: true }); } };
  await main(['ask', 'campaign', file], options);
  assert.equal(requests[0].url, 'http://127.0.0.1:8780/admin/ask'); assert.equal(requests[0].body.item.kind, 'accept'); assert.equal(printed, 'A1\n');
  printed = '';
  await main(['set-webhook', 'campaign'], { ...options, input: Readable.from(['https://example.test/private-test-hook']) });
  assert.equal(requests[1].body.url, 'https://example.test/private-test-hook'); assert.equal(printed, '通知地址已保存\n');
});

test('CLI 私有配置错误不输出服务器返回的地址', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(main(['set-webhook', 'campaign'], { home, input: Readable.from(['https://example.test/hook']), fetchImpl: async () => Response.json({ error: 'https://example.test/hook' }, { status: 400 }) }), /^Error: 私有配置更新失败$/);
});

test('自启模板引用实际 Node 和服务路径，Windows 隐藏窗口并崩溃重启', () => {
  const unit = linuxUnit('/opt/node path/node', '/srv/trial/skill/server.mjs', '/srv/trial');
  assert.match(unit, /ExecStart="\/opt\/node path\/node"/); assert.match(unit, /Restart=on-failure/);
  const launcher = windowsLauncher('C:\\Program Files\\node.exe', "E:\\a'b & 中文\\server.mjs", "C:\\Trial\\a'b");
  assert.match(launcher, /-WindowStyle Hidden -PassThru/); assert.match(launcher, /\$inboxProcess.WaitForExit\(\)/);
  assert.match(launcher, /while \(\$true\)/); assert.match(launcher, /if \(\$inboxExitCode -eq 0\) \{ exit 0 \}/); assert.match(launcher, /Start-Sleep -Seconds 5/);
  assert.match(launcher, /ParentProcessId = .*\$inboxProcess.Id.*AND Name = 'ssh.exe'/);
  assert.ok(launcher.includes("$env:INBOX_HOME = 'C:\\Trial\\a''b'"));
  assert.ok(launcher.includes("-ArgumentList '\"E:\\a''b & 中文\\server.mjs\"'"));
  const task = windowsTask(launcher, 'DOMAIN\\user&name');
  assert.match(task, /<Command>conhost.exe<\/Command>/);
  assert.match(task, /--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand/);
  assert.match(task, /LogonTrigger/); assert.match(task, /RestartOnFailure/); assert.match(task, /user&amp;name/); assert.match(task, /PT0S/);
  assert.equal(Buffer.from(task.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le'), launcher);
});

test('Linux install/uninstall 经用户级 systemd，文件路径与实际 home 一致', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-startup-')); t.after(() => rm(home, { recursive: true, force: true }));
  const calls = []; const options = { home, platform: 'linux', nodePath: '/bin/node', serverPath: '/skill/server.mjs', run: async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; } };
  await autostart('install', options);
  assert.match(await readFile(path.join(home, '.config/systemd/user/orchestration-inbox.service'), 'utf8'), /\/skill\/server.mjs/);
  assert.deepEqual(calls[1], ['systemctl', '--user', 'enable', '--now', 'orchestration-inbox.service']);
  await autostart('uninstall', options); assert.deepEqual(calls[2], ['systemctl', '--user', 'disable', '--now', 'orchestration-inbox.service']);
});

test('Windows install 启动计划任务并删除临时 XML', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-startup-')); t.after(() => rm(home, { recursive: true, force: true }));
  const calls = []; await autostart('install', { home, platform: 'win32', user: 'test', run: async (file, args) => { calls.push([file, ...args]); return {}; } });
  assert.equal(calls[0][1], '/Create'); assert.equal(calls[1][1], '/Run');
  await assert.rejects(readFile(path.join(home, '.agents/orchestration/inbox-task.xml')));
});

test('Windows headless 启动器支持带空格和单引号的路径，Node 正常退出后结束', { skip: process.platform !== 'win32' }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "inbox user's 中文-")); t.after(() => rm(home, { recursive: true, force: true }));
  const script = path.join(home, 'node child.mjs');
  await writeFile(script, 'import path from "node:path"; import { fileURLToPath } from "node:url"; process.exit(process.env.INBOX_HOME === path.dirname(fileURLToPath(import.meta.url)) ? 0 : 24);');
  const launcher = windowsLauncher(process.execPath, script, home);
  const result = spawnSync('conhost.exe', ['--headless', 'powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('add-device refuses captured output before any request and never returns link', async t => {
  let called = false;
  await assert.rejects(main(['add-device'], { output: { isTTY: false }, fetchImpl: async () => { called = true; } }), /interactive terminal/);
  assert.equal(called, false);
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-device-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  let printed = '';
  const result = await main(['add-device'], { home, output: { isTTY: true, write: text => printed += text }, fetchImpl: async url => {
    assert.match(url, /\/admin\/add-device$/); return Response.json({ url: 'https://example.test/?device=synthetic-only', expiresIn: 300 });
  } });
  assert.deepEqual(result, { ok: true }); assert.doesNotMatch(printed, /synthetic-only|https:/); assert.match(printed, /5 minutes/);
});
