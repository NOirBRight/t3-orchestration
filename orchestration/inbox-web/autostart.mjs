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
// systemd treats $VAR and $$ in unit values; escape $ so paths like /home/$user stay literal.
// replaceAll's string replacement treats $$ as one $, so emit $$ via a replacer function.
const unitQuote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', () => '$$').replaceAll('%', '%%')}"`;

function windowsStop(home, launcherFile) {
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  return `$ErrorActionPreference = 'Stop'
$launcherPattern = '(?i)-File\\s+"?' + [regex]::Escape(${literal(launcherFile)}) + '"?(?:\\s|$)'
$legacyHome = ${literal(`$env:INBOX_HOME = ${literal(home)}`)}
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | ForEach-Object {
  $candidate = $_
  $matchesLauncher = $candidate.CommandLine -match $launcherPattern
  if (-not $matchesLauncher -and $candidate.CommandLine -match '(?i)-EncodedCommand\\s+([A-Za-z0-9+/=]+)') {
    try {
      $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
      $matchesLauncher = $decoded.Contains($legacyHome) -and $decoded.Contains('$inboxProcess.WaitForExit()')
    } catch { $matchesLauncher = $false }
  }
  if ($candidate.ProcessId -ne $PID -and $matchesLauncher) {
    taskkill.exe /PID $candidate.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue)) { throw 'Could not stop Inbox watchdog' }
  }
}
`;
}

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
  // Task Scheduler starts tasks BelowNormal and children inherit it; on a busy machine that starved Inbox for seconds per request.
  // Ending the task only stops conhost, so a reinstall left the old watchdog restarting its own Node; replace it by its recorded PID.
  // WaitForExit waits for Node alone; Start-Process -Wait also waits for the SSH descendants.
  const pidFile = path.win32.join(home, '.agents', 'orchestration', 'inbox-watchdog.pid');
  return `$ErrorActionPreference = 'Stop'\n(Get-Process -Id $PID).PriorityClass = 'Normal'\n$env:INBOX_HOME = ${literal(home)}\n$watchdogFile = ${literal(pidFile)}\n$previous = Get-Content -LiteralPath $watchdogFile -ErrorAction SilentlyContinue | Select-Object -First 1\nif ($previous -match '^\\d+$') {\n  $old = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $previous) -ErrorAction SilentlyContinue\n  if ($old -and $old.ProcessId -ne $PID -and $old.Name -eq 'powershell.exe' -and $old.CommandLine.Contains($PSCommandPath)) { taskkill.exe /PID $previous /T /F | Out-Null }\n}\nNew-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $watchdogFile) | Out-Null\nSet-Content -LiteralPath $watchdogFile -Value $PID\nwhile ($true) {\n  $inboxExitCode = 1\n  try {\n    $inboxProcess = Start-Process -FilePath ${literal(nodePath)} -ArgumentList ${literal(`"${serverPath}"`)} -WindowStyle Hidden -PassThru\n    $inboxProcess.WaitForExit()\n    $inboxExitCode = $inboxProcess.ExitCode\n    Get-CimInstance Win32_Process -Filter (\"ParentProcessId = \" + $inboxProcess.Id + \" AND Name = 'ssh.exe'\") -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\n  } catch { $inboxExitCode = 1 }\n  if ($inboxExitCode -eq 0) { exit 0 }\n  Start-Sleep -Seconds 5\n}\n`;
}

// ConHost 的 headless 控制台独立于默认终端，不创建可被关闭的窗口。
// 启动器放在文件里：Defender 把 conhost --headless 加 -EncodedCommand 的命令行当作木马（ConAtt）拦下。
export function windowsTask(launcherFile, user) {
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Orchestration Inbox</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ${xml(`"${launcherFile}"`)}</Arguments></Exec></Actions></Task>`;
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
    const root = path.join(home, '.agents', 'orchestration'); const taskFile = path.join(root, 'inbox-task.xml'); const launcherFile = path.join(root, 'inbox-launcher.ps1');
    const stop = async () => {
      const installed = await run('schtasks.exe', ['/Query', '/TN', taskName, '/XML']).then(() => true).catch(() => false);
      if (installed) await run('schtasks.exe', ['/End', '/TN', taskName]);
      await mkdir(root, { recursive: true });
      const stopFile = path.join(root, 'inbox-stop.ps1');
      await writeFile(stopFile, '\ufeff' + windowsStop(home, launcherFile));
      try { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'RemoteSigned', '-File', stopFile]); }
      finally { await rm(stopFile, { force: true }); }
    };
    if (command === 'install') {
      await stop();
      await mkdir(root, { recursive: true });
      // Windows PowerShell 5.1 needs the BOM to read non-ASCII paths as UTF-8.
      await writeFile(launcherFile, '\ufeff' + windowsLauncher(nodePath, serverPath, home));
      await writeFile(taskFile, '\ufeff' + windowsTask(launcherFile, user), 'utf16le');
      try {
        await run('schtasks.exe', ['/Create', '/TN', taskName, '/XML', taskFile, '/F']); await run('schtasks.exe', ['/Run', '/TN', taskName]);
      }
      finally { await rm(taskFile, { force: true }); }
    } else if (command === 'uninstall') {
      await stop(); await run('schtasks.exe', ['/Delete', '/TN', taskName, '/F']); await rm(launcherFile, { force: true });
      await rm(path.join(root, 'inbox-watchdog.pid'), { force: true });
    } else {
      const installed = await run('schtasks.exe', ['/Query', '/TN', taskName, '/XML']).then(() => true).catch(() => false);
      return { platform, enabled: installed };
    }
  }
  return { platform, action: command, ok: true };
}
