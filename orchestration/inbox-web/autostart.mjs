import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const execute = promisify(execFile);
const taskName = 'Orchestration Inbox';
const unitName = 'orchestration-inbox.service';
const agentLabel = 'org.orchestration.inbox';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const unitQuote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export function linuxUnit(nodePath, serverPath, home) {
  return `[Unit]\nDescription=Orchestration Inbox\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=${unitQuote(`INBOX_HOME=${home}`)}\nExecStart=${unitQuote(nodePath)} ${unitQuote(serverPath)}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

export function macosAgent(nodePath, serverPath, home, label = agentLabel) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(serverPath)}</string></array>
<key>EnvironmentVariables</key><dict><key>INBOX_HOME</key><string>${xml(home)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
</dict></plist>
`;
}

export function windowsLauncher(nodePath, serverPath, home) {
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  // WaitForExit waits for Node alone; Start-Process -Wait also waits for the SSH descendants.
  return `$ErrorActionPreference = 'Stop'\n$env:INBOX_HOME = ${literal(home)}\nwhile ($true) {\n  $inboxExitCode = 1\n  try {\n    $inboxProcess = Start-Process -FilePath ${literal(nodePath)} -ArgumentList ${literal(`"${serverPath}"`)} -WindowStyle Hidden -PassThru\n    $inboxProcess.WaitForExit()\n    $inboxExitCode = $inboxProcess.ExitCode\n    Get-CimInstance Win32_Process -Filter (\"ParentProcessId = \" + $inboxProcess.Id + \" AND Name = 'ssh.exe'\") -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\n  } catch { $inboxExitCode = 1 }\n  if ($inboxExitCode -eq 0) { exit 0 }\n  Start-Sleep -Seconds 5\n}\n`;
}

// ConHost 的 headless 控制台独立于默认终端，不创建可被关闭的窗口。
export function windowsTask(launcher, user) {
  const encoded = Buffer.from(launcher, 'utf16le').toString('base64');
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Orchestration Inbox</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}</Arguments></Exec></Actions></Task>`;
}

export async function autostart(command, { home = process.env.INBOX_HOME || os.homedir(), platform = process.platform, nodePath = process.execPath, serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url)), run = execute, restart = false, uid, label = agentLabel, user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME } = {}) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error('Autostart supports Windows, Linux, and macOS');
  if (platform === 'darwin') {
    const domain = `gui/${uid ?? os.userInfo().uid}`;
    const service = `${domain}/${label}`;
    const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const loaded = () => run('launchctl', ['print', service]).then(r => r.stdout).catch(() => null);
    if (command === 'install') {
      if (await loaded() !== null) await run('launchctl', ['bootout', service]);
      await mkdir(path.dirname(plist), { recursive: true });
      await writeFile(plist, macosAgent(nodePath, serverPath, home, label));
      await run('launchctl', ['enable', service]);
      await run('launchctl', ['bootstrap', domain, plist]);
    } else if (command === 'uninstall') {
      if (await loaded() !== null) await run('launchctl', ['bootout', service]);
      await rm(plist, { force: true });
    } else {
      const state = await loaded();
      const installed = await access(plist).then(() => true).catch(() => false);
      return { platform, enabled: installed, active: state !== null && /\bstate = running\b/.test(state) };
    }
  } else if (platform === 'linux') {
    const unit = path.join(home, '.config', 'systemd', 'user', unitName);
    if (command === 'install') {
      await mkdir(path.dirname(unit), { recursive: true }); await writeFile(unit, linuxUnit(nodePath, serverPath, home));
      await run('systemctl', ['--user', 'daemon-reload']); await run('systemctl', ['--user', 'enable', '--now', unitName]);
      if (restart) await run('systemctl', ['--user', 'restart', unitName]);
    } else if (command === 'uninstall') {
      await run('systemctl', ['--user', 'disable', '--now', unitName]); await rm(unit, { force: true }); await run('systemctl', ['--user', 'daemon-reload']);
    } else {
      const enabled = await run('systemctl', ['--user', 'is-enabled', unitName]).then(r => r.stdout.trim()).catch(() => 'disabled');
      const active = await run('systemctl', ['--user', 'is-active', unitName]).then(r => r.stdout.trim()).catch(() => 'inactive');
      return { platform, enabled: enabled === 'enabled', active: active === 'active' };
    }
  } else {
    const root = path.join(home, '.agents', 'orchestration'); const taskFile = path.join(root, 'inbox-task.xml');
    if (command === 'install') {
      await mkdir(root, { recursive: true });
      await writeFile(taskFile, '\ufeff' + windowsTask(windowsLauncher(nodePath, serverPath, home), user), 'utf16le');
      try {
        if (restart) {
          const installed = await run('schtasks.exe', ['/Query', '/TN', taskName, '/XML']).then(() => true).catch(() => false);
          if (installed) await run('schtasks.exe', ['/End', '/TN', taskName]);
        }
        await run('schtasks.exe', ['/Create', '/TN', taskName, '/XML', taskFile, '/F']); await run('schtasks.exe', ['/Run', '/TN', taskName]);
      }
      finally { await rm(taskFile, { force: true }); }
    } else if (command === 'uninstall') {
      await run('schtasks.exe', ['/End', '/TN', taskName]).catch(() => {}); await run('schtasks.exe', ['/Delete', '/TN', taskName, '/F']);
    } else {
      const installed = await run('schtasks.exe', ['/Query', '/TN', taskName, '/XML']).then(() => true).catch(() => false);
      return { platform, enabled: installed };
    }
  }
  return { platform, action: command, ok: true };
}
