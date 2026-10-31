import path from 'node:path';
import { spawn } from 'node:child_process';

export class ReverseTunnel {
  constructor(config, spawnProcess = spawn) { this.config = config; this.spawnProcess = spawnProcess; this.state = 'disabled'; this.attempt = 0; }
  start() {
    if (this.config.remote.type !== 'ssh-reverse' || this.stopped) return;
    const remote = this.config.remote;
    if (typeof remote.sshHost !== 'string' || remote.sshHost.startsWith('-') || !Number.isInteger(remote.remoteBindPort) || remote.remoteBindPort < 1 || remote.remoteBindPort > 65535) throw new Error('ssh-reverse 配置不完整');
    this.state = 'connecting';
    if (remote.remoteBindHost !== undefined && (typeof remote.remoteBindHost !== 'string' || /[\s\r\n]/.test(remote.remoteBindHost))) throw new Error('remoteBindHost 必须是有效监听地址');
    const bind = remote.remoteBindHost ? `${remote.remoteBindHost}:` : '';
    if (process.platform === 'win32' && !process.env.SystemRoot) throw new Error('缺少 SystemRoot，无法定位系统 OpenSSH');
    const executable = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
    clearTimeout(this.stableTimer);
    this.child = this.spawnProcess(executable, ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'BatchMode=yes', '-R', `${bind}${remote.remoteBindPort}:127.0.0.1:${this.config.remotePort}`, remote.sshHost], { windowsHide: true, stdio: 'ignore' });
    this.child.once('spawn', () => {
      this.state = 'running';
      this.stableTimer = setTimeout(() => { this.attempt = 0; }, 60000);
      this.stableTimer.unref?.();
    });
    let ended = false;
    const reconnect = () => {
      if (ended || this.stopped) return;
      ended = true;
      clearTimeout(this.stableTimer);
      this.state = 'reconnecting';
      this.timer = setTimeout(() => this.start(), Math.min(60000, 1000 * 2 ** Math.min(this.attempt++, 6)));
      this.timer.unref();
    };
    this.child.once('error', reconnect); this.child.once('exit', reconnect);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.stableTimer); this.child?.kill(); this.state = 'stopped'; }
}
