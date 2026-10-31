import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicJson, readJson } from './config.mjs';

export const ROUTE_TYPES = Object.freeze([
  'discussion', 'design', 'visual', 'research', 'code', 'adjudication', 'review', 'housekeeping',
]);

function tier(instanceId, model, optionId = 'thinking', value = 'high') {
  return { instanceId, model, options: [{ id: optionId, value }] };
}

function baseGlobalRouting() {
  return {
    routes: {
      discussion: {
        tiers: [
          tier('claudeAgent', 'claude-opus-5-5', 'effort', 'high'),
          tier('pi', 'cursor/claude-opus-5-5'),
        ],
      },
      design: {
        tiers: [
          tier('claudeAgent', 'claude-opus-5-5', 'effort', 'high'),
          tier('pi', 'cursor/claude-opus-5-5'),
        ],
      },
      visual: {
        tiers: [
          tier('codex', 'gpt-6.1-sol', 'reasoningEffort', 'high'),
          tier('claudeAgent', 'claude-opus-5-5', 'effort', 'high'),
          tier('pi', 'cursor/claude-opus-5-5'),
        ],
      },
      research: {
        tiers: [
          tier('pi', 'opencode-go/deepseek-v4.1-flash'),
          tier('claudeAgent', 'claude-haiku-5-5', 'effort', 'high'),
        ],
      },
      code: {
        tiers: [
          tier('pi', 'xai/grok-4.5'),
          tier('pi', 'cursor/grok-4.5'),
          tier('pi', 'opencode-go/deepseek-v4.1-flash'),
        ],
      },
      adjudication: {
        tiers: [
          tier('pi', 'xai/grok-4.5'),
          tier('pi', 'cursor/grok-4.5'),
          tier('pi', 'opencode-go/deepseek-v4.1-flash'),
        ],
      },
      review: {
        tiers: [
          tier('pi', 'xai/grok-4.5'),
          tier('pi', 'cursor/grok-4.5'),
          tier('pi', 'opencode-go/deepseek-v4.1-flash'),
        ],
      },
    },
    limits: { execution: 8, design: 2 },
    quota: {},
  };
}

/**
 * Global layer with the in-memory derived housekeeping route (HOUSEKEEPING.md).
 * housekeeping has no defaults of its own: it follows research until the owner
 * overrides it explicitly. Only an explicit override is ever persisted.
 */
export function defaultGlobalRouting() {
  const global = baseGlobalRouting();
  global.routes.housekeeping = structuredClone(global.routes.research);
  return global;
}

export function emptyRoutingDocument() {
  return {
    version: 0,
    updatedAt: null,
    global: defaultGlobalRouting(),
    machines: {},
    sync: { peers: {} },
  };
}

/** Built-in 2026-10-23g defaults for `routing-import` (does not read AGENT_RULES.md). */
export function seedBuiltinRouting() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    global: defaultGlobalRouting(),
    machines: {},
    sync: { peers: {} },
  };
}

export function routingPath(home) {
  return path.join(home, '.agents', 'orchestration', 'routing.json');
}

export function catalogPath(home) {
  return path.join(home, '.agents', 'orchestration', 'catalog.json');
}

export function campaignRoutingPath(campaignDir) {
  return path.join(campaignDir, 'routing.json');
}

function assertTier(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  if (typeof value.instanceId !== 'string' || !value.instanceId) throw new Error(`${label}.instanceId 无效`);
  if (typeof value.model !== 'string' || !value.model) throw new Error(`${label}.model 无效`);
  if (!Array.isArray(value.options) || value.options.length === 0) {
    throw new Error(`${label}.options 必须包含推理档位`);
  }
  for (const [index, option] of value.options.entries()) {
    if (!option || typeof option !== 'object' || typeof option.id !== 'string' || !option.id || !('value' in option)) {
      throw new Error(`${label}.options[${index}] 无效`);
    }
  }
}

function normalizeRouteBlock(block, label, { allowNull = false } = {}) {
  if (block === undefined) return undefined;
  if (block === null) {
    if (allowNull) return null;
    throw new Error(`${label} 不能为 null（全局层不可撤销）`);
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error(`${label} 必须是对象`);
  if (!Array.isArray(block.tiers) || block.tiers.length === 0) throw new Error(`${label}.tiers 不能为空`);
  block.tiers.forEach((item, index) => assertTier(item, `${label}.tiers[${index}]`));
  return { tiers: block.tiers.map(item => ({ instanceId: item.instanceId, model: item.model, options: item.options.map(o => ({ id: o.id, value: o.value })) })) };
}

function normalizeLimits(limits, label, { allowNull = false } = {}) {
  if (limits === undefined) return undefined;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error(`${label} 必须是对象`);
  const next = {};
  for (const key of ['execution', 'design']) {
    if (!(key in limits)) continue;
    const value = limits[key];
    if (value === null) {
      if (allowNull) {
        next[key] = null;
        continue;
      }
      throw new Error(`${label}.${key} 不能为 null（全局层不可撤销）`);
    }
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label}.${key} 必须是非负整数`);
    next[key] = value;
  }
  return next;
}

function normalizeQuota(quota) {
  if (quota === undefined) return {};
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) throw new Error('quota 必须是对象');
  const next = {};
  for (const [key, entry] of Object.entries(quota)) {
    if (!entry || typeof entry !== 'object') throw new Error(`quota.${key} 无效`);
    next[key] = {
      exhausted: Boolean(entry.exhausted),
      resumeAt: entry.resumeAt ?? null,
      markedBy: entry.markedBy ?? null,
      markedAt: entry.markedAt ?? null,
    };
  }
  return next;
}

const routingWarnings = new Set();
function warnRouting(message) {
  if (routingWarnings.has(message)) return;
  routingWarnings.add(message);
  process.emitWarning(message, { code: 'ROUTING_UNKNOWN_TYPE' });
}

function sameBlock(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** True when a layer's housekeeping route is an explicit owner choice (not just a copy of research). */
export function hasExplicitHousekeeping(layer) {
  const routes = layer?.routes;
  if (!routes?.housekeeping) return false;
  return !sameBlock(routes.housekeeping, routes.research);
}

/**
 * Global layer as written to disk or sent to peers: drops a housekeeping route
 * that only mirrors research, so pre-0.1.3 readers (which reject unknown route
 * types) still accept the document. Explicit overrides are kept.
 */
export function persistableGlobal(global) {
  if (!global?.routes || hasExplicitHousekeeping(global) || !Object.hasOwn(global.routes, 'housekeeping')) return global;
  const { housekeeping, ...routes } = global.routes;
  return { ...global, routes };
}

function normalizeLayer(layer, label, { requireAllRoutes = false, allowNullDeletes = false } = {}) {
  if (layer === undefined || layer === null) return requireAllRoutes ? { routes: {}, limits: {}, quota: {} } : {};
  if (typeof layer !== 'object' || Array.isArray(layer)) throw new Error(`${label} 必须是对象`);
  const routes = {};
  if (layer.routes !== undefined) {
    if (!layer.routes || typeof layer.routes !== 'object' || Array.isArray(layer.routes)) throw new Error(`${label}.routes 必须是对象`);
    for (const type of Object.keys(layer.routes)) {
      if (!ROUTE_TYPES.includes(type)) {
        // Forward compatibility: a newer version may add route types. Keep a
        // well-formed unknown block so a round trip does not lose it, but never
        // fail the whole document over it.
        try {
          routes[type] = normalizeRouteBlock(layer.routes[type], `${label}.routes.${type}`, { allowNull: allowNullDeletes });
          warnRouting(`${label}.routes.${type} 不是已知类型，已保留但不会使用`);
        } catch (error) {
          warnRouting(`${label}.routes.${type} 不是已知类型且格式无效，已忽略：${error.message}`);
        }
        continue;
      }
      routes[type] = normalizeRouteBlock(layer.routes[type], `${label}.routes.${type}`, { allowNull: allowNullDeletes });
    }
  }
  if (requireAllRoutes) {
    for (const type of ROUTE_TYPES) {
      if (!routes[type]) throw new Error(`${label}.routes.${type} 缺失`);
    }
  }
  const limits = normalizeLimits(layer.limits, `${label}.limits`, { allowNull: allowNullDeletes }) || {};
  if (requireAllRoutes) {
    if (!Number.isInteger(limits.execution) || !Number.isInteger(limits.design)) {
      throw new Error(`${label}.limits 需要 execution 与 design`);
    }
  }
  const next = { routes, limits };
  if ('quota' in layer || requireAllRoutes) next.quota = normalizeQuota(layer.quota);
  return next;
}

function backfillGlobalRoutes(global) {
  if (!global || typeof global !== 'object' || Array.isArray(global)) return global;
  const routes = global.routes;
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) return global;
  const defaults = defaultGlobalRouting().routes;
  const next = { ...routes };
  if (!Object.hasOwn(next, 'visual')) next.visual = defaults.visual;
  if (!Object.hasOwn(next, 'housekeeping') || next.housekeeping === undefined) {
    next.housekeeping = next.research?.tiers ? structuredClone(next.research) : defaults.housekeeping;
  }
  return next.visual === routes.visual && next.housekeeping === routes.housekeeping ? global : { ...global, routes: next };
}

export function normalizeRoutingDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('routing.json 必须是对象');
  if (!Number.isInteger(raw.version) || raw.version < 0) throw new Error('routing.version 无效');
  // Older documents predate visual and housekeeping. Supply only the missing
  // routes in memory; keep existing owner choices and the optimistic-concurrency
  // version untouched. A missing housekeeping route copies the document's own
  // research route (what the HK session used before it had a route type).
  const globalInput = backfillGlobalRoutes(raw.global);
  const global = normalizeLayer(globalInput, 'global', { requireAllRoutes: true });
  const machines = {};
  if (raw.machines !== undefined) {
    if (!raw.machines || typeof raw.machines !== 'object' || Array.isArray(raw.machines)) throw new Error('machines 必须是对象');
    for (const [name, layer] of Object.entries(raw.machines)) {
      if (!name) throw new Error('machines 键无效');
      machines[name] = normalizeLayer(layer, `machines.${name}`);
    }
  }
  const sync = raw.sync && typeof raw.sync === 'object' ? raw.sync : { peers: {} };
  if (!sync.peers || typeof sync.peers !== 'object' || Array.isArray(sync.peers)) throw new Error('sync.peers 必须是对象');
  return {
    version: raw.version,
    updatedAt: raw.updatedAt ?? null,
    global,
    machines,
    sync: { peers: { ...sync.peers } },
  };
}

export function loadRouting(home = process.env.INBOX_HOME || os.homedir()) {
  const file = routingPath(home);
  const raw = readJson(file, null);
  if (!raw) return emptyRoutingDocument();
  return normalizeRoutingDocument(raw);
}

export function saveRouting(home, document) {
  const normalized = normalizeRoutingDocument(document);
  atomicJson(routingPath(home), { ...normalized, global: persistableGlobal(normalized.global) });
  return normalized;
}

export function loadCampaignRouting(campaignDir) {
  if (!campaignDir) return {};
  const raw = readJson(campaignRoutingPath(campaignDir), null);
  if (!raw) return {};
  return normalizeLayer(raw, 'campaign');
}

export function saveCampaignRouting(campaignDir, layer) {
  fs.mkdirSync(campaignDir, { recursive: true });
  const normalized = normalizeLayer(layer, 'campaign');
  atomicJson(campaignRoutingPath(campaignDir), normalized);
  return normalized;
}

export function quotaKey(tier) {
  return `${tier.instanceId}/${tier.model}`;
}

function cloneTier(tierValue, source) {
  return {
    instanceId: tierValue.instanceId,
    model: tierValue.model,
    options: tierValue.options.map(o => ({ id: o.id, value: o.value })),
    source,
  };
}

function effectiveLimits(globalLimits, machineLimits = {}, campaignLimits = {}) {
  const sources = { execution: 'global', design: 'global' };
  const limits = { execution: globalLimits.execution, design: globalLimits.design };
  for (const key of ['execution', 'design']) {
    if (Number.isInteger(machineLimits[key])) {
      if (machineLimits[key] > limits[key]) throw new Error(`并发上限只能收紧：${key} 机器层 ${machineLimits[key]} 超过上层 ${limits[key]}`);
      limits[key] = machineLimits[key];
      sources[key] = 'machine';
    }
    if (Number.isInteger(campaignLimits[key])) {
      if (campaignLimits[key] > limits[key]) throw new Error(`并发上限只能收紧：${key} Campaign 层 ${campaignLimits[key]} 超过上层 ${limits[key]}`);
      limits[key] = campaignLimits[key];
      sources[key] = 'campaign';
    }
  }
  return { ...limits, sources };
}

function assertTighten(baseLimits, patchLimits, label) {
  if (!patchLimits) return;
  for (const key of ['execution', 'design']) {
    if (!Number.isInteger(patchLimits[key])) continue;
    if (patchLimits[key] > baseLimits[key]) {
      throw new Error(`并发上限只能收紧：${label}.${key}=${patchLimits[key]} 超过上层 ${baseLimits[key]}`);
    }
  }
}

export function resolveRoute({
  home = process.env.INBOX_HOME || os.homedir(),
  machine = os.hostname(),
  campaignDir,
  type,
  routing = loadRouting(home),
  campaign = loadCampaignRouting(campaignDir),
  now = Date.now,
} = {}) {
  if (!ROUTE_TYPES.includes(type)) throw new Error(`未知路由类型 ${type}`);
  const machineLayer = routing.machines[machine] || {};
  if (type === 'housekeeping') {
    // housekeeping follows research at every layer unless a layer sets it
    // explicitly (most specific explicit choice wins).
    const explicit = campaign.routes?.housekeeping ? ['campaign', campaign.routes.housekeeping]
      : machineLayer.routes?.housekeeping ? ['machine', machineLayer.routes.housekeeping]
        : hasExplicitHousekeeping(routing.global) ? ['global', routing.global.routes.housekeeping]
          : null;
    if (!explicit) {
      const research = resolveRoute({ home, machine, campaignDir, type: 'research', routing, campaign, now });
      return { ...research, type, derivedFrom: 'research' };
    }
  }
  let source = 'global';
  let block = routing.global.routes[type];
  if (machineLayer.routes?.[type]) {
    block = machineLayer.routes[type];
    source = 'machine';
  }
  if (campaign.routes?.[type]) {
    block = campaign.routes[type];
    source = 'campaign';
  }
  const quota = routing.global.quota || {};
  const tiers = [];
  const skipped = [];
  for (const item of block.tiers) {
    const key = quotaKey(item);
    const entry = quota[key];
    const exhausted = entry?.exhausted === true && (!entry.resumeAt || Date.parse(entry.resumeAt) > now());
    if (exhausted) skipped.push({ ...cloneTier(item, source), reason: 'exhausted', resumeAt: entry.resumeAt ?? null });
    else tiers.push(cloneTier(item, source));
  }
  const limits = effectiveLimits(routing.global.limits, machineLayer.limits, campaign.limits);
  return { type, tiers, skipped, limits, version: routing.version, updatedAt: routing.updatedAt };
}

export function resolveAll(options = {}) {
  const routes = {};
  for (const type of ROUTE_TYPES) routes[type] = resolveRoute({ ...options, type });
  const sample = routes.code || Object.values(routes)[0];
  return {
    routes,
    limits: sample.limits,
    version: sample.version,
    updatedAt: sample.updatedAt,
    machine: options.machine || os.hostname(),
    campaignDir: options.campaignDir || null,
  };
}

export function loadCatalog(home = process.env.INBOX_HOME || os.homedir()) {
  return readJson(catalogPath(home), null);
}

function missingOptionLists(previous, next) {
  const missing = [];
  const choices = option => (Array.isArray(option?.values) ? option.values : Array.isArray(option?.options) ? option.options : option?.type === 'boolean' ? [false, true] : []).map(v => JSON.stringify(v && typeof v === 'object' ? v.id : v));
  for (const provider of previous?.providers || []) {
    const nextProvider = next?.providers?.find(p => p.providerInstanceId === provider.providerInstanceId);
    for (const model of provider.models || []) {
      const nextModel = nextProvider?.models?.find(m => m.id === model.id);
      for (const option of model.options || []) {
        if (!option.id) continue;
        const before = choices(option);
        const after = choices(nextModel?.options?.find(o => o.id === option.id));
        if (before.some(value => !after.includes(value))) missing.push(`${provider.providerInstanceId}/${model.id}/${option.id}`);
      }
    }
  }
  return missing;
}

export function writeCatalog(home, input, { capturedAt = new Date().toISOString(), campaignDirs = [], allowMissing = false, allowOptionRemoval = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('catalog capabilities 必须是对象');
  const capabilities = mergeCapabilities(input);
  const incomplete = missingOptionLists(loadCatalog(home)?.capabilities, capabilities);
  if (incomplete.length && !allowOptionRemoval) {
    const error = new Error(`目录缺少此前已知的选项，拒绝写入（未写 catalog.json）：${incomplete.join(', ')}。重新查询模型并检查结果`);
    error.incomplete = incomplete;
    throw error;
  }
  const missing = missingRoutedModels(home, capabilities, campaignDirs);
  if (missing.length && !allowMissing) {
    const error = new Error(`目录缺少路由使用的模型，拒绝写入（未写 catalog.json）：${missing.join(', ')}。逐个用 orchestrator_capabilities 的 search 查找，把基础抓取和查找结果作为 JSON 数组一起传给 catalog-write；确认模型已下线才用 --allow-missing`);
    error.missing = missing;
    throw error;
  }
  const document = { capturedAt, capabilities };
  atomicJson(catalogPath(home), document);
  return missing.length ? { ...document, missing } : document;
}

// orchestrator_capabilities without `search` returns a short, varying model list.
// Accept one capture or an array of captures (base + per-model search results)
// and union providers[].models[] by id so lookups can be merged in.
export function mergeCapabilities(input) {
  const captures = Array.isArray(input) ? input : [input];
  if (!captures.length || captures.some(c => !c || typeof c !== 'object' || Array.isArray(c))) throw new Error('catalog capabilities 必须是对象或对象数组');
  if (captures.length === 1) return captures[0];
  const merged = { ...captures[0], providers: [] };
  const byId = new Map();
  for (const capture of captures) {
    for (const provider of capture.providers || []) {
      const id = provider?.providerInstanceId;
      if (!id) continue;
      let target = byId.get(id);
      if (!target) { target = { ...provider, models: [] }; byId.set(id, target); merged.providers.push(target); }
      for (const model of provider.models || []) {
        if (model?.id && !target.models.some(m => m.id === model.id)) target.models.push(model);
      }
    }
  }
  return merged;
}

// Every instanceId/model referenced by global, machine and given Campaign layers.
export function routedModels(home, campaignDirs = []) {
  const routing = loadRouting(home);
  const layers = [routing.global, ...Object.values(routing.machines || {}), ...campaignDirs.map(dir => loadCampaignRouting(dir))];
  const keys = new Set();
  for (const layer of layers) {
    for (const block of Object.values(layer?.routes || {})) {
      for (const item of block?.tiers || []) if (item?.instanceId && item?.model) keys.add(`${item.instanceId}/${item.model}`);
    }
  }
  return [...keys];
}

export function missingRoutedModels(home, capabilities, campaignDirs = []) {
  const models = catalogModels({ capabilities });
  if (!models) return [];
  return routedModels(home, campaignDirs).filter(key => {
    const slash = key.indexOf('/');
    return !models.get(key.slice(0, slash))?.has(key.slice(slash + 1));
  });
}

function catalogModels(catalog) {
  // Live orchestrator_capabilities shape: providers[].providerInstanceId,
  // models[].id, models[].options[].id, and for selects either
  // options[].values (string|boolean arrays, with optional default) or the
  // legacy options[].options[].id nested list. Booleans also accept type=boolean.
  // The #26 invented top-level providerInstances[].id shape is not accepted.
  const instances = catalog?.capabilities?.providers;
  if (!Array.isArray(instances)) return null;
  const map = new Map();
  for (const instance of instances) {
    const id = instance.providerInstanceId;
    if (!id || !Array.isArray(instance.models)) continue;
    const models = new Map();
    for (const model of instance.models) {
      const modelId = model.id;
      if (!modelId) continue;
      const options = new Map();
      for (const option of model.options || []) {
        if (!option?.id) continue;
        let values = null;
        if (Array.isArray(option.values) && option.values.length) {
          values = option.values.map(entry => String(entry));
        } else if (Array.isArray(option.options)) {
          values = option.options
            .map(entry => (entry && typeof entry === 'object' ? entry.id : entry))
            .filter(entry => entry !== undefined && entry !== null)
            .map(String);
        } else if (option.type === 'boolean') {
          values = ['true', 'false'];
        }
        options.set(option.id, values && values.length ? values : null);
      }
      models.set(modelId, options);
    }
    map.set(id, models);
  }
  return map;
}

export function validateAgainstCatalog(home, tiers) {
  const catalog = loadCatalog(home);
  if (!catalog) return { ok: true, status: 'missing' };
  const models = catalogModels(catalog);
  if (!models) return { ok: true, status: 'missing' };
  for (const item of tiers) {
    const instance = models.get(item.instanceId);
    if (!instance) throw new Error(`目录中没有 provider ${item.instanceId}`);
    const optionMap = instance.get(item.model);
    if (!optionMap) throw new Error(`目录中没有模型 ${item.instanceId}/${item.model}`);
    for (const option of item.options || []) {
      if (!optionMap.has(option.id)) throw new Error(`目录中没有选项 ${option.id}`);
      const allowed = optionMap.get(option.id);
      if (allowed && !allowed.map(String).includes(String(option.value))) {
        throw new Error(`选项 ${option.id} 的值 ${option.value} 不在目录中`);
      }
    }
  }
  return { ok: true, status: 'ok', capturedAt: catalog.capturedAt };
}

function collectPatchTiers(patch) {
  const tiers = [];
  for (const block of Object.values(patch.routes || {})) {
    if (!block || typeof block !== 'object') continue;
    for (const item of block.tiers || []) tiers.push(item);
  }
  return tiers;
}

function mergeLayer(base, patch) {
  const next = {
    routes: { ...(base.routes || {}) },
    limits: { ...(base.limits || {}) },
  };
  if (base.quota || patch.quota) next.quota = { ...(base.quota || {}), ...(patch.quota || {}) };
  if (patch.routes) {
    for (const [type, block] of Object.entries(patch.routes)) {
      if (block === null) delete next.routes[type];
      else next.routes[type] = block;
    }
  }
  if (patch.limits) {
    for (const [key, value] of Object.entries(patch.limits)) {
      if (value === null) delete next.limits[key];
      else next.limits[key] = value;
    }
  }
  if (patch.quota) Object.assign(next.quota, patch.quota);
  return next;
}

function assertDocumentVersion(routing, expectedVersion) {
  if (!Number.isInteger(expectedVersion)) {
    const error = new Error('写入 routing.json 需要 expectedVersion');
    error.status = 400;
    throw error;
  }
  if (expectedVersion !== routing.version) {
    const error = new Error('路由版本冲突，请重新加载后再改');
    error.status = 409;
    throw error;
  }
}

export function applyLayerPatch(home, {
  layer,
  machine,
  campaignDir,
  patch,
  expectedVersion,
} = {}) {
  if (!patch || typeof patch !== 'object') throw new Error('patch 必须是对象');
  const allowNullDeletes = layer === 'machine' || layer === 'campaign';
  const normalizedPatch = normalizeLayer(patch, 'patch', { allowNullDeletes });
  const catalogCheck = validateAgainstCatalog(home, collectPatchTiers(normalizedPatch));
  const routing = loadRouting(home);

  if (layer === 'global') {
    assertDocumentVersion(routing, expectedVersion);
    const nextGlobal = mergeLayer(routing.global, normalizedPatch);
    // A derived housekeeping route keeps following research through the edit.
    if (!hasExplicitHousekeeping(routing.global) && !Object.hasOwn(normalizedPatch.routes || {}, 'housekeeping')) {
      nextGlobal.routes.housekeeping = structuredClone(nextGlobal.routes.research);
    }
    if (!Number.isInteger(nextGlobal.limits.execution) || !Number.isInteger(nextGlobal.limits.design)) {
      throw new Error('global.limits 需要 execution 与 design');
    }
    for (const type of ROUTE_TYPES) {
      if (!nextGlobal.routes[type]) throw new Error(`global.routes.${type} 缺失`);
    }
    for (const [name, machineLayer] of Object.entries(routing.machines)) {
      assertTighten(nextGlobal.limits, machineLayer.limits, `machines.${name}`);
    }
    routing.global = nextGlobal;
    routing.version += 1;
    routing.updatedAt = new Date().toISOString();
    saveRouting(home, routing);
    return { layer: 'global', version: routing.version, updatedAt: routing.updatedAt, catalogCheck: catalogCheck.status, routing };
  }

  if (layer === 'machine') {
    if (!machine || typeof machine !== 'string') throw new Error('machine 名无效');
    assertDocumentVersion(routing, expectedVersion);
    assertTighten(routing.global.limits, normalizedPatch.limits, 'machine');
    const current = routing.machines[machine] || { routes: {}, limits: {} };
    const merged = mergeLayer(current, normalizedPatch);
    // Drop empty quota on machine layer — quota is global-only.
    delete merged.quota;
    routing.machines[machine] = merged;
    routing.updatedAt = new Date().toISOString();
    // Host-layer edits stay local and do not bump the shared global version used for hub sync.
    saveRouting(home, routing);
    return { layer: 'machine', machine, version: routing.version, updatedAt: routing.updatedAt, catalogCheck: catalogCheck.status, routing };
  }

  if (layer === 'campaign') {
    if (!campaignDir) throw new Error('campaignDir 无效');
    const machineLayer = routing.machines[machine || os.hostname()] || {};
    const parentLimits = effectiveLimits(routing.global.limits, machineLayer.limits, {});
    assertTighten(parentLimits, normalizedPatch.limits, 'campaign');
    const current = loadCampaignRouting(campaignDir);
    const merged = mergeLayer(current, normalizedPatch);
    delete merged.quota;
    saveCampaignRouting(campaignDir, merged);
    return { layer: 'campaign', campaignDir, version: routing.version, catalogCheck: catalogCheck.status, campaign: merged };
  }

  throw new Error('layer 必须是 global、machine 或 campaign');
}

export function setQuota(home, {
  key,
  exhausted,
  resumeAt = null,
  markedBy = 'orchestrator',
  markedAt = new Date().toISOString(),
  expectedVersion,
} = {}) {
  if (typeof key !== 'string' || !key.includes('/')) throw new Error('quota key 必须是 instanceId/model');
  const routing = loadRouting(home);
  assertDocumentVersion(routing, expectedVersion);
  if (!routing.global.quota) routing.global.quota = {};
  if (exhausted) {
    routing.global.quota[key] = { exhausted: true, resumeAt, markedBy, markedAt };
  } else {
    delete routing.global.quota[key];
  }
  routing.version += 1;
  routing.updatedAt = new Date().toISOString();
  saveRouting(home, routing);
  return { key, exhausted: Boolean(exhausted), version: routing.version, updatedAt: routing.updatedAt, quota: routing.global.quota };
}

export function acceptSyncedGlobal(home, incoming) {
  if (!incoming || typeof incoming !== 'object') throw new Error('同步负载无效');
  const local = loadRouting(home);
  const remoteVersion = Number(incoming.version);
  if (!Number.isInteger(remoteVersion)) throw new Error('同步版本无效');
  if (remoteVersion < local.version) {
    return { accepted: false, reason: 'stale', version: local.version };
  }
  if (remoteVersion === local.version) {
    return { accepted: true, reason: 'same', version: local.version };
  }
  const global = normalizeLayer(backfillGlobalRoutes(incoming.global), 'sync.global', { requireAllRoutes: true });
  local.global = global;
  local.version = remoteVersion;
  local.updatedAt = incoming.updatedAt || new Date().toISOString();
  saveRouting(home, local);
  return { accepted: true, reason: 'updated', version: local.version, updatedAt: local.updatedAt };
}

export function routingView({
  home = process.env.INBOX_HOME || os.homedir(),
  machine = os.hostname(),
  campaignDir,
} = {}) {
  const routing = loadRouting(home);
  const campaign = loadCampaignRouting(campaignDir);
  const catalog = loadCatalog(home);
  const effective = resolveAll({ home, machine, campaignDir, routing, campaign });
  return {
    version: routing.version,
    updatedAt: routing.updatedAt,
    global: routing.global,
    machine: { name: machine, layer: routing.machines[machine] || { routes: {}, limits: {} } },
    machines: routing.machines,
    campaign: campaignDir ? { dir: campaignDir, layer: campaign } : null,
    effective,
    catalog: catalog ? { capturedAt: catalog.capturedAt, present: true } : { capturedAt: null, present: false },
    sync: routing.sync || { peers: {} },
  };
}
