import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { loadConfig, parseCidrList, privateText, saveConfig } from './config.mjs';
import { autostart } from './autostart.mjs';
import { matchingHealth } from './health.mjs';
import { routingPath, saveCampaignRouting } from './routing.mjs';

export async function configureProject(project) {
  const root = path.resolve(project.root);
  const target = path.join(root, 'docs/agents/orchestration.md');
  const settings = `# Orchestration settings\n\nThis project uses /orchestration.\n\n## Storage\n- Campaign storage: ${project.storage}\n- Disk warning threshold: ${project.diskWarningGB ?? 10} GB\n\n## Owner\n- Owner display name: ${project.owner || 'you'}\n\n## Routing and capacity\nConcurrency limits and dispatch routes live in Inbox routing settings (\`routing.json\` and optional Campaign \`routing.json\` overrides). Run \`node <skill-dir>/inbox-web/inbox.mjs routing-import\` when the global file is missing. Do not copy route tables here.\n\n## Permissions\n${project.permissions}\n\n## Resource pools\n\n\`\`\`json\n${JSON.stringify(project.resources || { resourceNamespace: path.basename(root), resourcePools: {} }, null, 2)}\n\`\`\`\n\n## Tests\n${project.tests}\n`;
  if (!project.storage || !project.permissions || !project.tests) throw new Error('Project needs storage, permissions, and tests; see PROJECT.md.');
  const existing = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing !== null && existing !== settings) throw new Error('Project settings already exist; review/edit them instead of overwriting.');
  await mkdir(path.dirname(target), { recursive: true });
  if (existing === null) await writeFile(target, settings, { flag: 'wx' });
  const agents = path.join(root, 'AGENTS.md');
  const content = await readFile(agents, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (!content.includes('docs/agents/orchestration.md')) await writeFile(agents, `${content}${content.endsWith('\n') || !content ? '' : '\n'}\nOrchestration: read [project settings](docs/agents/orchestration.md).\n`);
  return target;
}

function routingStatus(home) {
  if (existsSync(routingPath(home))) return { present: true };
  return { present: false, fix: 'node <skill-dir>/inbox-web/inbox.mjs routing-import' };
}

// The skill gathers answers. A file makes every step repeatable without shell quoting.
export async function setup(answers, { home = process.env.INBOX_HOME || os.homedir(), startup = autostart, fetchImpl = fetch, install = true, readConfig = loadConfig } = {}) {
  // Baseline for machine answers from the current file.
  const next = { ...readConfig({ home }) };
  for (const key of ['name', 'port', 'remotePort', 'remote', 'lanTrustSubnet', 'lanTrustCidrs', 'lanHttpsUrl']) if (answers.machine && key in answers.machine) next[key] = answers.machine[key];
  if (!next.name || !Number.isInteger(next.port) || next.port < 1 || next.port > 65535 || !Number.isInteger(next.remotePort) || next.remotePort < 1 || next.remotePort > 65535 || next.port === next.remotePort) throw new Error('Choose a machine name and two distinct ports from 1 to 65535.');
  if (!['none', 'tailscale', 'cloudflared', 'url', 'ssh-reverse'].includes(next.remote?.type)) throw new Error('Choose a remote.type from the remote-access guide.');
  if (next.remote.type !== 'none') {
    let url; try { url = new URL(next.remote.publicUrl); } catch { throw new Error('remote.publicUrl needs an absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use a public HTTP(S) entry URL without credentials, query, or fragment.');
    if (next.remote.type === 'ssh-reverse' && (!next.remote.sshHost || !Number.isInteger(next.remote.remoteBindPort))) throw new Error('ssh-reverse needs sshHost and remoteBindPort; see remote-access.md.');
  }
  if (typeof next.lanTrustSubnet !== 'boolean') throw new Error('lanTrustSubnet must be boolean.');
  if ('lanTrustCidrs' in next) next.lanTrustCidrs = parseCidrList(next.lanTrustCidrs);
  // Re-read campaigns/peers immediately before write so hand-edits on disk are kept.
  const fresh = readConfig({ home });
  next.campaigns = fresh.campaigns;
  next.peers = fresh.peers;
  saveConfig(next);
  privateText(next.privateDir, 'admin-token') || privateText(next.privateDir, 'admin-token', randomBytes(32).toString('base64url'));
  if (answers.project) await configureProject(answers.project);
  if (answers.campaignRouting) {
    const { dir, routes, limits } = answers.campaignRouting;
    if (!dir || typeof dir !== 'string') throw new Error('campaignRouting needs dir (Campaign directory).');
    saveCampaignRouting(path.resolve(dir), { routes, limits });
  }
  const routing = routingStatus(home);
  if (!install) return { configured: true, installed: false, routing };
  await startup('install', { home, restart: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await matchingHealth(next, { fetchImpl, timeoutMs: 1000 })) return { configured: true, installed: true, healthy: true, routing };
    if (attempt < 19) await delay(250);
  }
  throw new Error('Configured, but Inbox health did not become ready. Check status; rerun setup after repair.');
}
