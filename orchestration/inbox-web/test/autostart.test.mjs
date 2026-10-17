import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { autostart, macosAgent } from '../autostart.mjs';

test('macOS plist preserves arguments and XML characters without a shell', () => {
  const plist = macosAgent('/opt/node & tools/node', '/skill/中文 "test"/server.mjs', '/Users/a & b');
  assert.ok(plist.includes('<string>/opt/node &amp; tools/node</string>'));
  assert.ok(plist.includes('<string>/skill/中文 &quot;test&quot;/server.mjs</string>'));
  assert.ok(plist.includes('<key>INBOX_HOME</key><string>/Users/a &amp; b</string>'));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>5<\/integer>/);
});

test('macOS install, reinstall, status and uninstall use the GUI domain', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-launchd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = []; let state = null;
  const label = 'org.orchestration.inbox.test';
  const service = `gui/501/${label}`;
  const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const options = { home, platform: 'darwin', uid: 501, label, nodePath: '/bin/node', serverPath: '/skill/server.mjs', run: async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'print' && state === null) throw new Error('not loaded');
    if (args[0] === 'bootstrap') state = 'state = running';
    if (args[0] === 'bootout') state = null;
    return { stdout: state || '' };
  } };
  assert.deepEqual(await autostart('status', options), { platform: 'darwin', enabled: false, active: false });
  await autostart('install', options);
  assert.match(await readFile(plist, 'utf8'), /\/skill\/server.mjs/);
  assert.ok(calls.some(c => JSON.stringify(c) === JSON.stringify(['launchctl', 'bootstrap', 'gui/501', plist])));
  assert.deepEqual(await autostart('status', options), { platform: 'darwin', enabled: true, active: true });
  state = 'state = waiting';
  assert.equal((await autostart('status', options)).active, false);
  await autostart('install', options);
  assert.ok(calls.some(c => JSON.stringify(c) === JSON.stringify(['launchctl', 'bootout', service])));
  await autostart('uninstall', options);
  await assert.rejects(readFile(plist), { code: 'ENOENT' });
  await autostart('uninstall', options);
  assert.deepEqual(await autostart('status', options), { platform: 'darwin', enabled: false, active: false });
});

test('macOS bootstrap errors propagate to the caller', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'inbox-launchd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(autostart('install', { home, platform: 'darwin', uid: 501, run: async (_, args) => {
    if (args[0] === 'print') throw new Error('not loaded');
    if (args[0] === 'bootstrap') throw new Error('GUI session unavailable');
    return { stdout: '' };
  } }), /GUI session unavailable/);
});
