import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROUTE_TYPES,
  defaultGlobalRouting,
  loadRouting,
  saveRouting,
  resolveRoute,
  resolveAll,
  applyLayerPatch,
  writeCatalog,
  loadCatalog,
  validateAgainstCatalog,
  setQuota,
  seedBuiltinRouting,
  hasExplicitHousekeeping,
  persistableGlobal,
  acceptSyncedGlobal,
} from '../routing.mjs';

const importRulesRouting = seedBuiltinRouting;

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-routing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.agents', 'orchestration'), { recursive: true });
  return home;
}

function tier(instanceId, model, optionId = 'thinking', value = 'high') {
  return { instanceId, model, options: [{ id: optionId, value }] };
}

test('catalog refresh refuses to erase known reasoning choices and leaves the snapshot intact', t => {
  const home = tempHome(t);
  const capture = options => ({ providers: [{ providerInstanceId: 'grok', models: [{ id: 'grok-4.7', options }] }] });
  const known = capture([{ id: 'reasoningEffort', values: ['low', 'high'], default: 'high' }]);
  writeCatalog(home, known, { allowMissing: true, capturedAt: 'original' });
  for (const options of [[], [{ id: 'reasoningEffort', values: [] }]]) {
    assert.throws(() => writeCatalog(home, capture(options), { allowMissing: true }), /reasoningEffort/);
    assert.equal(loadCatalog(home).capturedAt, 'original');
    assert.deepEqual(loadCatalog(home).capabilities, known);
  }
  assert.throws(() => writeCatalog(home, { providers: [] }, { allowMissing: true }), /reasoningEffort/);
  assert.throws(() => writeCatalog(home, capture([{ id: 'reasoningEffort', values: ['high'] }]), { allowMissing: true }), /reasoningEffort/);
  assert.deepEqual(loadCatalog(home).capabilities, known);
  const other = capture([{ id: 'variant', values: ['a', 'b'] }, { id: 'mode', values: ['on', 'off'] }]);
  writeCatalog(home, other, { allowMissing: true, allowOptionRemoval: true });
  assert.throws(() => writeCatalog(home, capture([{ id: 'variant', values: ['a'] }]), { allowMissing: true }), /mode/);
  const booleanOption = capture([{ id: 'fastMode', type: 'boolean' }]);
  writeCatalog(home, booleanOption, { allowMissing: true, allowOptionRemoval: true });
  assert.throws(() => writeCatalog(home, capture([]), { allowMissing: true }), /fastMode/);
  const updated = capture([{ id: 'reasoningEffort', values: ['medium', 'high'], default: 'medium' }]);
  writeCatalog(home, updated, { allowMissing: true, allowOptionRemoval: true, capturedAt: 'updated' });
  assert.deepEqual(loadCatalog(home).capabilities, updated);
});

test('default import adds visual while preserving historical routes and limits 8/2', () => {
  const global = defaultGlobalRouting();
  assert.deepEqual([...ROUTE_TYPES], ['discussion', 'design', 'visual', 'research', 'code', 'adjudication', 'review', 'housekeeping']);
  assert.equal(global.limits.execution, 8);
  // housekeeping has no defaults of its own: it is derived from research in memory.
  assert.deepEqual(global.routes.housekeeping, global.routes.research);
  assert.notEqual(global.routes.housekeeping, global.routes.research);
  assert.equal(hasExplicitHousekeeping(global), false);
  assert.equal(Object.hasOwn(persistableGlobal(global).routes, 'housekeeping'), false);
  assert.equal(global.limits.design, 2);
  assert.deepEqual(global.routes.code.tiers.map(t => `${t.instanceId}/${t.model}`), [
    'pi/xai/grok-4.5',
    'pi/cursor/grok-4.5',
    'pi/opencode-go/deepseek-v4.1-flash',
  ]);
  assert.deepEqual(global.routes.discussion.tiers[0], tier('claudeAgent', 'claude-opus-5-5', 'effort', 'high'));
  assert.deepEqual(global.routes.research.tiers[0], tier('pi', 'opencode-go/deepseek-v4.1-flash'));
  assert.deepEqual(global.routes.review.tiers.map(t => t.model), [
    'xai/grok-4.5',
    'cursor/grok-4.5',
    'opencode-go/deepseek-v4.1-flash',
  ]);
});

test('layers merge global → machine → campaign; each tier records its source', t => {
  const home = tempHome(t);
  const routing = {
    version: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
    global: {
      routes: {
        code: { tiers: [tier('pi', 'xai/grok-4.5'), tier('pi', 'cursor/grok-4.5')] },
        design: { tiers: [tier('claudeAgent', 'claude-opus-5-5', 'effort', 'high')] },
        discussion: { tiers: [tier('claudeAgent', 'claude-opus-5-5', 'effort', 'high')] },
        research: { tiers: [tier('pi', 'opencode-go/deepseek-v4.1-flash')] },
        adjudication: { tiers: [tier('pi', 'xai/grok-4.5')] },
        review: { tiers: [tier('pi', 'xai/grok-4.5')] },
      },
      limits: { execution: 8, design: 2 },
      quota: {},
    },
    machines: {
      'workstation-a': {
        routes: { code: { tiers: [tier('pi', 'cursor/grok-4.5')] } },
        limits: { execution: 4 },
      },
    },
    sync: { peers: {} },
  };
  saveRouting(home, routing);
  const campaignDir = path.join(home, 'camp');
  fs.mkdirSync(campaignDir);
  fs.writeFileSync(path.join(campaignDir, 'routing.json'), JSON.stringify({
    routes: { code: { tiers: [tier('pi', 'opencode-go/deepseek-v4.1-flash')] } },
    limits: { execution: 2, design: 1 },
  }));

  const resolved = resolveRoute({ home, machine: 'workstation-a', campaignDir, type: 'code' });
  assert.equal(resolved.tiers.length, 1);
  assert.equal(resolved.tiers[0].model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(resolved.tiers[0].source, 'campaign');
  assert.deepEqual(resolved.limits, { execution: 2, design: 1, sources: { execution: 'campaign', design: 'campaign' } });

  const machineOnly = resolveRoute({ home, machine: 'workstation-a', type: 'code' });
  assert.equal(machineOnly.tiers[0].model, 'cursor/grok-4.5');
  assert.equal(machineOnly.tiers[0].source, 'machine');
  assert.equal(machineOnly.limits.execution, 4);
  assert.equal(machineOnly.limits.sources.execution, 'machine');
  assert.equal(machineOnly.limits.sources.design, 'global');
});

test('exhausted quota tiers are skipped; clear restores them', t => {
  const home = tempHome(t);
  const routing = importRulesRouting();
  routing.global.quota['pi/xai/grok-4.5'] = {
    exhausted: true,
    resumeAt: '2099-01-01T00:00:00.000Z',
    markedBy: 'orchestrator',
    markedAt: '2026-10-23T12:00:00.000Z',
  };
  saveRouting(home, routing);
  const resolved = resolveRoute({ home, machine: 'workstation-a', type: 'code' });
  assert.equal(resolved.tiers[0].model, 'cursor/grok-4.5');
  assert.equal(resolved.skipped[0].model, 'xai/grok-4.5');
  assert.equal(resolved.skipped[0].reason, 'exhausted');

  setQuota(home, { key: 'pi/xai/grok-4.5', exhausted: false, markedBy: 'owner', expectedVersion: loadRouting(home).version });
  const restored = resolveRoute({ home, machine: 'workstation-a', type: 'code' });
  assert.equal(restored.tiers[0].model, 'xai/grok-4.5');
  assert.equal(restored.skipped.length, 0);
});

test('limits may only tighten across layers', t => {
  const home = tempHome(t);
  saveRouting(home, importRulesRouting());
  fs.mkdirSync(path.join(home, 'camp'));
  assert.throws(
    () => applyLayerPatch(home, { layer: 'machine', machine: 'workstation-a', expectedVersion: 1, patch: { limits: { execution: 9 } } }),
    /收紧|tighten|上限/,
  );
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'campaign',
      campaignDir: path.join(home, 'camp'),
      patch: { limits: { design: 3 } },
    }),
    /收紧|tighten|上限/,
  );
  applyLayerPatch(home, { layer: 'machine', machine: 'workstation-a', expectedVersion: 1, patch: { limits: { execution: 3 } } });
  applyLayerPatch(home, {
    layer: 'campaign',
    campaignDir: path.join(home, 'camp'),
    patch: { limits: { execution: 2, design: 1 } },
  });
  const all = resolveAll({ home, machine: 'workstation-a', campaignDir: path.join(home, 'camp') });
  assert.equal(all.limits.execution, 2);
  assert.equal(all.limits.design, 1);
});

test('version conflict rejects stale writes', t => {
  const home = tempHome(t);
  const first = importRulesRouting();
  saveRouting(home, first);
  const loaded = loadRouting(home);
  applyLayerPatch(home, {
    layer: 'global',
    expectedVersion: loaded.version,
    patch: { limits: { execution: 7 } },
  });
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'global',
      expectedVersion: loaded.version,
      patch: { limits: { execution: 6 } },
    }),
    /版本|version|重新加载/,
  );
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'machine',
      machine: 'workstation-a',
      patch: { limits: { execution: 3 } },
    }),
    /expectedVersion|版本/,
  );
  const afterGlobal = loadRouting(home);
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'machine',
      machine: 'workstation-a',
      expectedVersion: loaded.version,
      patch: { limits: { execution: 3 } },
    }),
    /版本|version|重新加载/,
  );
  applyLayerPatch(home, {
    layer: 'machine',
    machine: 'workstation-a',
    expectedVersion: afterGlobal.version,
    patch: { limits: { execution: 3 } },
  });
  assert.equal(loadRouting(home).machines['workstation-a'].limits.execution, 3);
  assert.equal(loadRouting(home).version, afterGlobal.version);
});

test('tiers require a non-empty options list for reasoning level', t => {
  const home = tempHome(t);
  saveRouting(home, importRulesRouting());
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'global',
      expectedVersion: 1,
      patch: { routes: { code: { tiers: [{ instanceId: 'pi', model: 'cursor/grok-4.5', options: [] }] } } },
    }),
    /options|推理|档位/,
  );
});

/** Sanitized sample matching live orchestrator_capabilities shape (no real account ids).
 *  Current T3 catalog uses options[].values (string|boolean) + default; legacy options[].options kept for fixtures that still use it. */
function realShapeCapabilities() {
  return {
    providers: [{
      providerInstanceId: 'codex',
      driverKind: 'codex',
      displayName: 'Codex',
      models: [{
        id: 'gpt-6.1-sol',
        options: [{
          id: 'reasoningEffort',
          values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          default: 'low',
        }, {
          id: 'serviceTier',
          values: ['default', 'priority'],
          default: 'default',
        }],
      }],
    }, {
      providerInstanceId: 'pi',
      driverKind: 'pi',
      displayName: 'Pi',
      models: [{
        id: 'openai/chat-latest',
        label: 'Chat Latest',
        options: [{
          id: 'thinking',
          values: ['off', 'minimal', 'low', 'medium', 'high'],
          default: 'medium',
        }],
      }, {
        id: 'cursor/grok-4.5',
        label: 'Grok 4.5',
        options: [{
          id: 'thinking',
          values: ['low', 'medium', 'high'],
          default: 'high',
        }],
      }, {
        id: 'xai/grok-4.5',
        label: 'Grok 4.5',
        options: [{
          id: 'thinking',
          values: ['low', 'high'],
        }],
      }],
    }, {
      providerInstanceId: 'claudeAgent',
      driverKind: 'claudeAgent',
      displayName: 'Claude',
      models: [{
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        options: [{
          id: 'effort',
          values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
          default: 'medium',
        }, {
          id: 'fastMode',
          values: [false, true],
        }],
      }],
    }],
  };
}

/** Older nested options[].options shape still accepted alongside values. */
function legacyOptionsCapabilities() {
  return {
    providers: [{
      providerInstanceId: 'pi',
      driverKind: 'pi',
      displayName: 'Pi',
      models: [{
        id: 'cursor/grok-4.5',
        label: 'Grok 4.5',
        options: [{
          id: 'thinking',
          label: 'Thinking',
          type: 'select',
          options: [
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
          ],
        }],
      }],
    }],
  };
}

test('catalog validation rejects unknown combinations; missing catalog does not block', t => {
  const home = tempHome(t);
  saveRouting(home, importRulesRouting());
  const unchecked = applyLayerPatch(home, {
    layer: 'global',
    expectedVersion: 1,
    patch: { routes: { code: { tiers: [tier('pi', 'unknown/model')] } } },
  });
  assert.equal(unchecked.catalogCheck, 'missing');

  writeCatalog(home, realShapeCapabilities(), { allowMissing: true });
  assert.equal(loadCatalog(home).capturedAt.length > 10, true);
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'global',
      expectedVersion: 2,
      patch: { routes: { code: { tiers: [tier('pi', 'unknown/model')] } } },
    }),
    /目录|catalog|模型/,
  );
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'global',
      expectedVersion: 2,
      patch: { routes: { code: { tiers: [tier('pi', 'cursor/grok-4.5', 'thinking', 'ultra')] } } },
    }),
    /option|选项/,
  );
  const ok = applyLayerPatch(home, {
    layer: 'global',
    expectedVersion: 2,
    patch: { routes: { code: { tiers: [tier('pi', 'cursor/grok-4.5')] } } },
  });
  assert.equal(ok.catalogCheck, 'ok');
  assert.equal(validateAgainstCatalog(home, [tier('pi', 'cursor/grok-4.5')]).ok, true);
  assert.equal(validateAgainstCatalog(home, [tier('pi', 'xai/grok-4.5')]).status, 'ok');
});

test('catalog values+default shape: codex effort low..ultra and pi chat-latest off..high; rejects unknown effort', t => {
  const home = tempHome(t);
  saveRouting(home, importRulesRouting());
  writeCatalog(home, realShapeCapabilities(), { allowMissing: true });

  assert.equal(
    validateAgainstCatalog(home, [tier('codex', 'gpt-6.1-sol', 'reasoningEffort', 'low')]).status,
    'ok',
  );
  assert.equal(
    validateAgainstCatalog(home, [tier('codex', 'gpt-6.1-sol', 'reasoningEffort', 'ultra')]).status,
    'ok',
  );
  assert.equal(
    validateAgainstCatalog(home, [tier('pi', 'openai/chat-latest', 'thinking', 'off')]).status,
    'ok',
  );
  assert.equal(
    validateAgainstCatalog(home, [tier('pi', 'openai/chat-latest', 'thinking', 'high')]).status,
    'ok',
  );
  assert.throws(
    () => validateAgainstCatalog(home, [tier('codex', 'gpt-6.1-sol', 'reasoningEffort', 'ludicrous')]),
    /选项|option|值/,
  );
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'global',
      expectedVersion: 1,
      patch: { routes: { code: { tiers: [tier('codex', 'gpt-6.1-sol', 'reasoningEffort', 'not-a-level')] } } },
    }),
    /选项|option|值/,
  );
  // boolean values arrays are accepted as true/false strings
  assert.equal(
    validateAgainstCatalog(home, [{
      instanceId: 'claudeAgent', model: 'claude-opus-5-5',
      options: [{ id: 'effort', value: 'high' }, { id: 'fastMode', value: true }],
    }]).status,
    'ok',
  );
});

test('legacy options[].options catalog shape still validates', t => {
  const home = tempHome(t);
  saveRouting(home, importRulesRouting());
  writeCatalog(home, legacyOptionsCapabilities(), { allowMissing: true });
  assert.equal(validateAgainstCatalog(home, [tier('pi', 'cursor/grok-4.5')]).status, 'ok');
  assert.throws(
    () => validateAgainstCatalog(home, [tier('pi', 'cursor/grok-4.5', 'thinking', 'ultra')]),
    /选项|option|值/,
  );
});

test('legacy providerInstances catalog shape is not accepted as a validation catalog', t => {
  const home = tempHome(t);
  saveRouting(home, importRulesRouting());
  writeCatalog(home, {
    providerInstances: [{
      id: 'pi',
      models: [{
        id: 'cursor/grok-4.5',
        options: [{ id: 'thinking', values: ['low', 'medium', 'high'] }],
      }],
    }],
  });
  // Same silent-missing behavior as an empty/unrecognized snapshot: no false "ok".
  assert.equal(validateAgainstCatalog(home, [tier('pi', 'cursor/grok-4.5')]).status, 'missing');
});

test('machine and campaign patches delete overrides with null; global rejects null', t => {
  const home = tempHome(t);
  saveRouting(home, importRulesRouting());
  const campaignDir = path.join(home, 'camp');
  fs.mkdirSync(campaignDir);

  applyLayerPatch(home, {
    layer: 'machine',
    machine: 'workstation-a',
    expectedVersion: 1,
    patch: {
      routes: { code: { tiers: [tier('pi', 'cursor/grok-4.5')] } },
      limits: { execution: 4 },
    },
  });
  applyLayerPatch(home, {
    layer: 'campaign',
    campaignDir,
    patch: {
      routes: { code: { tiers: [tier('pi', 'opencode-go/deepseek-v4.1-flash')] } },
      limits: { execution: 2, design: 1 },
    },
  });

  let resolved = resolveRoute({ home, machine: 'workstation-a', campaignDir, type: 'code' });
  assert.equal(resolved.tiers[0].model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(resolved.tiers[0].source, 'campaign');
  assert.equal(resolved.limits.execution, 2);
  assert.equal(resolved.limits.sources.execution, 'campaign');
  assert.equal(resolved.limits.design, 1);
  assert.equal(resolved.limits.sources.design, 'campaign');

  applyLayerPatch(home, {
    layer: 'campaign',
    campaignDir,
    patch: { routes: { code: null }, limits: { execution: null } },
  });
  resolved = resolveRoute({ home, machine: 'workstation-a', campaignDir, type: 'code' });
  assert.equal(resolved.tiers[0].model, 'cursor/grok-4.5');
  assert.equal(resolved.tiers[0].source, 'machine');
  assert.equal(resolved.limits.execution, 4);
  assert.equal(resolved.limits.sources.execution, 'machine');
  assert.equal(resolved.limits.design, 1);
  assert.equal(resolved.limits.sources.design, 'campaign');

  applyLayerPatch(home, {
    layer: 'campaign',
    campaignDir,
    patch: { limits: { design: null } },
  });
  applyLayerPatch(home, {
    layer: 'machine',
    machine: 'workstation-a',
    expectedVersion: 1,
    patch: { routes: { code: null }, limits: { execution: null } },
  });
  resolved = resolveRoute({ home, machine: 'workstation-a', campaignDir, type: 'code' });
  assert.equal(resolved.tiers[0].model, 'xai/grok-4.5');
  assert.equal(resolved.tiers[0].source, 'global');
  assert.equal(resolved.limits.execution, 8);
  assert.equal(resolved.limits.sources.execution, 'global');
  assert.equal(resolved.limits.design, 2);
  assert.equal(resolved.limits.sources.design, 'global');

  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'global',
      expectedVersion: 1,
      patch: { routes: { code: null } },
    }),
    /null|不能|拒绝|撤销|global/,
  );
  assert.throws(
    () => applyLayerPatch(home, {
      layer: 'global',
      expectedVersion: 1,
      patch: { limits: { execution: null } },
    }),
    /null|不能|拒绝|非负|global/,
  );
});

test('pre-visual documents resolve visual defaults without rewriting existing routes or version', t => {
  const home = tempHome(t);
  const legacy = seedBuiltinRouting();
  delete legacy.global.routes.visual;
  legacy.version = 22;
  const file = path.join(home, '.agents', 'orchestration', 'routing.json');
  const original = JSON.stringify(legacy);
  fs.writeFileSync(file, original);
  const visual = resolveRoute({ home, type: 'visual' });
  assert.deepEqual(visual.tiers, [
    { ...tier('codex', 'gpt-6.1-sol', 'reasoningEffort', 'high'), source: 'global' },
    { ...tier('claudeAgent', 'claude-opus-5-5', 'effort', 'high'), source: 'global' },
    { ...tier('pi', 'cursor/claude-opus-5-5'), source: 'global' },
  ]);
  assert.equal(visual.version, 22);
  assert.deepEqual(loadRouting(home).global.routes.code, legacy.global.routes.code);
  assert.deepEqual(loadRouting(home).global.routes.design, legacy.global.routes.design);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  // A later sanctioned write intentionally serializes the normalized route.
  applyLayerPatch(home, { layer: 'machine', machine: 'desk', expectedVersion: 22, patch: { limits: { execution: 4 } } });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 22);
  assert.equal(saved.global.routes.visual.tiers[0].model, 'gpt-6.1-sol');
  for (const [type, block] of Object.entries(legacy.global.routes)) {
    if (type === 'housekeeping') continue; // derived, never persisted unless overridden
    assert.deepEqual(saved.global.routes[type], block);
  }
  assert.equal(Object.hasOwn(saved.global.routes, 'housekeeping'), false);
});

test('pre-housekeeping documents resolve housekeeping from their own research route', t => {
  const home = tempHome(t);
  const legacy = seedBuiltinRouting();
  delete legacy.global.routes.housekeeping;
  legacy.global.routes.research = { tiers: [tier('pi', 'cursor/grok-4.5'), tier('pi', 'xai/grok-4.5')] };
  legacy.version = 31;
  const file = path.join(home, '.agents', 'orchestration', 'routing.json');
  const original = JSON.stringify(legacy);
  fs.writeFileSync(file, original);
  const hk = resolveRoute({ home, type: 'housekeeping' });
  assert.deepEqual(hk.tiers.map(({ source, ...item }) => item), legacy.global.routes.research.tiers);
  assert.ok(hk.tiers.every(item => item.source === 'global'));
  assert.equal(hk.version, 31);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(resolveAll({ home }).routes.housekeeping);
});

test('housekeeping route takes machine and campaign overrides like other types', t => {
  const home = tempHome(t);
  saveRouting(home, seedBuiltinRouting());
  const before = loadRouting(home);
  applyLayerPatch(home, { layer: 'machine', machine: 'desk', expectedVersion: before.version, patch: { routes: { housekeeping: { tiers: [tier('pi', 'xai/grok-4.5')] } } } });
  const hk = resolveRoute({ home, machine: 'desk', type: 'housekeeping' });
  assert.equal(hk.tiers[0].model, 'xai/grok-4.5');
  assert.equal(hk.tiers[0].source, 'machine');
  assert.equal(resolveRoute({ home, machine: 'other', type: 'housekeeping' }).tiers[0].source, 'global');
});

// Pre-0.1.3 normalizeLayer: rejects unknown route types and requires its own list.
const OLD_ROUTE_TYPES = ['discussion', 'design', 'visual', 'research', 'code', 'adjudication', 'review'];
function oldReaderAccepts(document) {
  for (const type of Object.keys(document.global.routes)) if (!OLD_ROUTE_TYPES.includes(type)) throw new Error(`global.routes.${type} 不是已知类型`);
  for (const type of OLD_ROUTE_TYPES) if (!document.global.routes[type]) throw new Error(`global.routes.${type} missing`);
  for (const layer of Object.values(document.machines || {})) {
    for (const type of Object.keys(layer.routes || {})) if (!OLD_ROUTE_TYPES.includes(type)) throw new Error(`machine ${type}`);
  }
  return true;
}

test('save without an explicit housekeeping override does not emit housekeeping (old readers interop)', t => {
  const home = tempHome(t);
  const file = path.join(home, '.agents', 'orchestration', 'routing.json');
  saveRouting(home, seedBuiltinRouting());
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(saved.global.routes, 'housekeeping'), false);
  assert.ok(oldReaderAccepts(saved));
  // Editing research at the global layer keeps housekeeping derived (still not persisted).
  const research = { tiers: [tier('pi', 'cursor/grok-4.5')] };
  applyLayerPatch(home, { layer: 'global', expectedVersion: saved.version, patch: { routes: { research } } });
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(saved.global.routes, 'housekeeping'), false);
  assert.ok(oldReaderAccepts(saved));
  assert.equal(resolveRoute({ home, type: 'housekeeping' }).tiers[0].model, 'cursor/grok-4.5');
  assert.equal(resolveRoute({ home, type: 'housekeeping' }).derivedFrom, 'research');
});

test('explicit global housekeeping override is persisted and wins over research', t => {
  const home = tempHome(t);
  const file = path.join(home, '.agents', 'orchestration', 'routing.json');
  saveRouting(home, seedBuiltinRouting());
  const v = loadRouting(home).version;
  applyLayerPatch(home, { layer: 'global', expectedVersion: v, patch: { routes: { housekeeping: { tiers: [tier('pi', 'xai/grok-4.5')] } } } });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.global.routes.housekeeping.tiers[0].model, 'xai/grok-4.5');
  applyLayerPatch(home, { layer: 'global', expectedVersion: v + 1, patch: { routes: { research: { tiers: [tier('pi', 'cursor/grok-4.5')] } } } });
  assert.equal(resolveRoute({ home, type: 'housekeeping' }).tiers[0].model, 'xai/grok-4.5');
  assert.equal(resolveRoute({ home, machine: 'desk', type: 'housekeeping' }).tiers[0].source, 'global');
});

test('new reader accepts documents with unknown route types (warns, does not throw)', t => {
  const home = tempHome(t);
  const file = path.join(home, '.agents', 'orchestration', 'routing.json');
  const doc = seedBuiltinRouting();
  doc.global.routes.futuretype = { tiers: [tier('pi', 'xai/grok-4.5')] };
  doc.global.routes.brokenfuture = { nope: true };
  doc.machines = { desk: { routes: { futuretype: { tiers: [tier('pi', 'xai/grok-4.5')] } }, limits: {} } };
  fs.writeFileSync(file, JSON.stringify(doc));
  const warnings = [];
  const onWarning = w => warnings.push(w);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const loaded = loadRouting(home);
  assert.ok(loaded.global.routes.futuretype);
  assert.equal(Object.hasOwn(loaded.global.routes, 'brokenfuture'), false);
  assert.ok(resolveAll({ home, machine: 'desk' }).routes.code);
  assert.throws(() => resolveRoute({ home, type: 'futuretype' }), /未知路由类型/);
});

test('acceptSyncedGlobal accepts an old peer payload without housekeeping', t => {
  const home = tempHome(t);
  saveRouting(home, seedBuiltinRouting());
  const incoming = { version: 99, updatedAt: '2026-10-31T00:00:00.000Z', global: persistableGlobal(defaultGlobalRouting()) };
  incoming.global.routes.research = { tiers: [tier('pi', 'cursor/grok-4.5')] };
  assert.equal(Object.hasOwn(incoming.global.routes, 'housekeeping'), false);
  assert.equal(acceptSyncedGlobal(home, incoming).accepted, true);
  assert.equal(resolveRoute({ home, type: 'housekeeping' }).tiers[0].model, 'cursor/grok-4.5');
  assert.ok(oldReaderAccepts(JSON.parse(fs.readFileSync(path.join(home, '.agents', 'orchestration', 'routing.json'), 'utf8'))));
});

test('housekeeping follows research at machine and campaign layers unless set there', t => {
  const home = tempHome(t);
  saveRouting(home, seedBuiltinRouting());
  const v = loadRouting(home).version;
  applyLayerPatch(home, { layer: 'machine', machine: 'desk', expectedVersion: v, patch: { routes: { research: { tiers: [tier('pi', 'xai/grok-4.5')] } } } });
  let hk = resolveRoute({ home, machine: 'desk', type: 'housekeeping' });
  assert.equal(hk.tiers[0].model, 'xai/grok-4.5');
  assert.equal(hk.tiers[0].source, 'machine');
  const campaignDir = path.join(home, 'camp');
  applyLayerPatch(home, { layer: 'campaign', machine: 'desk', campaignDir, patch: { routes: { research: { tiers: [tier('pi', 'cursor/grok-4.5')] } } } });
  hk = resolveRoute({ home, machine: 'desk', campaignDir, type: 'housekeeping' });
  assert.equal(hk.tiers[0].model, 'cursor/grok-4.5');
  assert.equal(hk.tiers[0].source, 'campaign');
  // An explicit machine housekeeping route beats a derived one from campaign research.
  applyLayerPatch(home, { layer: 'machine', machine: 'desk', expectedVersion: v, patch: { routes: { housekeeping: { tiers: [tier('claudeAgent', 'claude-haiku-5-5', 'effort', 'high')] } } } });
  hk = resolveRoute({ home, machine: 'desk', campaignDir, type: 'housekeeping' });
  assert.equal(hk.tiers[0].model, 'claude-haiku-5-5');
  assert.equal(hk.tiers[0].source, 'machine');
});
