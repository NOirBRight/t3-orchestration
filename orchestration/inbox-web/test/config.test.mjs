import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig } from '../config.mjs';
import { createInboxServer } from '../server.mjs';

test('remote modes round-trip through machine.json and use the remote listener', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-remote-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = loadConfig({ home });
  assert.deepEqual(config.remote, { type: 'none' });
  for (const type of ['none', 'tailscale', 'cloudflared', 'url', 'ssh-reverse']) {
    config.remote = type === 'none' ? { type } : { type, publicUrl: 'https://inbox.example.com/' };
    saveConfig(config);
    const loaded = loadConfig({ home });
    assert.deepEqual(loaded.remote, config.remote);
    if (type === 'ssh-reverse') continue; // Existing backend tests cover managed SSH processes.
    loaded.port = 0; loaded.remotePort = 0;
    const server = await createInboxServer({ config: loaded, push: { publicKey: '', start() {}, stop() {} } });
    try {
      await server.start();
      assert.equal(server.remote.address().address, '127.0.0.1');
      assert.equal(server.health().tunnel, 'disabled');
      const response = await fetch(`http://127.0.0.1:${server.health().remotePort}/api/hub`);
      assert.equal(response.status, 401);
    } finally { await server.stop(); }
  }
});

test('remote configuration rejects unknown modes and invalid public URLs', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-remote-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = loadConfig({ home });
  for (const remote of [null, { type: 'other' }, { type: 'tailscale' }, { type: 'url', publicUrl: 'file:///tmp/page' }]) {
    config.remote = remote; saveConfig(config);
    assert.throws(() => loadConfig({ home }), /remote\./);
  }
});
