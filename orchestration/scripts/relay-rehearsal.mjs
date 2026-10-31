#!/usr/bin/env node
/**
 * Isolated end-to-end rehearsal for chat relay.
 * Uses a temp HOME / INBOX_HOME and non-8780/8781 ports only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig } from '../inbox-web/config.mjs';
import { createInboxServer } from '../inbox-web/server.mjs';
import { verifyRelaySignature } from '../inbox-web/relay.mjs';

const FORBIDDEN_PORTS = new Set([8780, 8781]);

function assertSafeHome(home) {
  const tmp = path.resolve(os.tmpdir());
  const resolved = path.resolve(home);
  if (!resolved.startsWith(tmp + path.sep) && resolved !== tmp) {
    throw new Error(`home must be under os.tmpdir(): ${resolved}`);
  }
}

async function startBridge() {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      events.push({
        signature: req.headers['x-inbox-relay-signature'],
        timestamp: req.headers['x-inbox-relay-timestamp'],
        raw,
        body: JSON.parse(raw),
      });
      res.writeHead(200); res.end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  if (FORBIDDEN_PORTS.has(port)) throw new Error('bridge landed on forbidden port');
  return { events, url: `http://127.0.0.1:${port}/b`, port, stop: () => new Promise(r => server.close(r)) };
}

export async function runRehearsal({ log = console.log } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rehearsal-'));
  assertSafeHome(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.INBOX_HOME = home;

  const lines = [];
  const say = msg => { lines.push(msg); log(msg); };

  let server, bridge;
  try {
    const dir = path.join(home, 'campaign');
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ id: 'rehearse', campaign: 'rehearse', tickets: [] }));
    fs.writeFileSync(path.join(dir, 'media', 'a.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const config = loadConfig({ home });
    config.port = 0;
    config.remotePort = 0;
    config.remote = { type: 'none' };
    config.campaigns = [{ id: 'rehearse', title: 'rehearse', dir }];
    saveConfig(config);
    if (FORBIDDEN_PORTS.has(config.port) || FORBIDDEN_PORTS.has(config.remotePort)) {
      throw new Error('refusing 8780/8781');
    }

    bridge = await startBridge();
    server = await createInboxServer({
      config,
      fetch: (url, init) => String(url).startsWith(bridge.url) ? fetch(url, init) : Promise.resolve(new Response(null, { status: 200 })),
      relaySleep: async () => {},
    });
    await server.start();
    const port = server.health().port;
    if (FORBIDDEN_PORTS.has(port)) throw new Error('server port forbidden');
    say(`server port=${port} bridge port=${bridge.port}`);

    const privateDir = config.privateDir;
    if (!privateDir.startsWith(home)) throw new Error('privateDir escaped temp home');

    const secrets = await server.admin('relay-set', {
      campaign: 'rehearse',
      bridgeUrl: bridge.url,
      mediaBase: 'loopback',
    });
    say(`relay tokenId=${secrets.tokenId}`);

    const item = await server.admin('ask', {
      campaign: 'rehearse',
      item: {
        kind: 'decide',
        title: 'Rehearsal question',
        ticket: '#34',
        askerThreadId: 't',
        askerLabel: 'rehearsal',
        options: [
          { key: 'a', label: 'A', consequence: 'do A' },
          { key: 'b', label: 'B', consequence: 'do B' },
        ],
        media: [{ path: 'media/a.png' }],
      },
    });
    await server.relay.queues.get('rehearse');
    if (bridge.events.length < 1) throw new Error('no opened event');
    const opened = bridge.events[0];
    const cfg = JSON.parse(fs.readFileSync(path.join(privateDir, 'relays', 'rehearse.json'), 'utf8'));
    if (!verifyRelaySignature(cfg.signingSecret, opened.timestamp, opened.raw, opened.signature)) {
      throw new Error('signature failed');
    }
    say('signed question.opened ok');

    const base = `http://127.0.0.1:${port}`;
    const token = `${secrets.tokenId}.${secrets.inboundToken}`;
    const answer = await fetch(`${base}/api/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign: 'rehearse',
        items: [{ id: item.id, expect: { questionId: item.id, status: 'open' }, answer: { choices: ['a'] } }],
      }),
    });
    if (answer.status !== 200) throw new Error(`relay answer ${answer.status}`);
    say('relay answer ok');

    const second = await fetch(`${base}/api/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign: 'rehearse',
        items: [{ id: item.id, answer: { choices: ['b'] } }],
      }),
    });
    if (second.status !== 409) throw new Error(`expected 409 got ${second.status}`);
    say('second relay answer 409 ok');

    const web = await fetch(`${base}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign: 'rehearse',
        items: [{ id: item.id, answer: { choices: ['b'], note: 'web override' } }],
      }),
    });
    if (web.status !== 200) throw new Error(`web override ${web.status}`);
    say('web override ok');

    const submissionId = server.store.load('rehearse').items[0].submissionId;
    const withdraw = await fetch(`${base}/api/item/rehearse/${item.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'withdraw', expect: { submissionId } }),
    });
    if (withdraw.status !== 200) throw new Error(`withdraw ${withdraw.status}`);
    await server.relay.queues.get('rehearse');
    say('withdraw ok');

    await server.admin('pending', { campaign: 'rehearse' });
    say('pending ok');
    say('REHEARSAL_OK');
    return { ok: true, lines, home, port, bridgePort: bridge.port };
  } finally {
    try { await server?.stop(); } catch { /* ignore */ }
    try { await bridge?.stop(); } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRehearsal().then(r => {
    if (!r.ok) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
