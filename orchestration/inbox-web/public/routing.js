import { state, t } from './state.js';
import { esc, icon } from './icons.js';
import { when, onDay } from './format.js';
import { api } from './api.js';
import { toast, setUrl } from './ui.js';
import { render } from './render.js';

// 派票设置（第 44 条）：全局 → 本机 → Campaign 逐层覆盖；改动先记在草稿里，一次保存成一个 patch。
export const ROUTE_TYPES = ['discussion', 'design', 'visual', 'research', 'code', 'adjudication', 'review', 'housekeeping'];
export const RT_LAYERS = ['global', 'machine', 'campaign'];
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 目录快照是 orchestrator_capabilities 原样：providers[].providerInstanceId / models[].id / options[].id。
// 当前 T3 用 options[].values（string|boolean）+ default；旧 options[].options[].id 仍兼容。
function optionIsBoolean(option) {
  if (option?.type === 'boolean') return true;
  return Array.isArray(option?.values) && option.values.length > 0 && option.values.every(v => typeof v === 'boolean');
}
function optionChoices(option) {
  if (optionIsBoolean(option)) return null;
  const defaultId = option.default !== undefined && option.default !== null ? String(option.default) : null;
  if (Array.isArray(option.values) && option.values.length) {
    return option.values.map(value => {
      const id = String(value);
      return { id, label: id, isDefault: defaultId !== null && id === defaultId };
    });
  }
  if (Array.isArray(option.options) && option.options.length) {
    return option.options.map(entry => {
      if (entry && typeof entry === 'object') {
        const id = String(entry.id);
        return {
          id,
          label: entry.label || id,
          isDefault: !!entry.isDefault || (defaultId !== null && id === defaultId),
        };
      }
      const id = String(entry);
      return { id, label: id, isDefault: defaultId !== null && id === defaultId };
    }).filter(entry => entry.id !== undefined && entry.id !== null && entry.id !== 'undefined');
  }
  return null;
}
export function routingCatalog(raw) {
  const list = raw?.capabilities?.providers;
  if (!Array.isArray(list)) return null;
  return list.map(p => ({
    id: p.providerInstanceId, label: p.displayName || p.providerInstanceId,
    models: (p.models || []).filter(m => m?.id).map(m => ({
      id: m.id,
      label: m.label || m.id,
      options: (m.options || []).filter(o => o?.id).map(o => ({
        id: o.id,
        type: optionIsBoolean(o) ? 'boolean' : o.type,
        values: optionChoices(o),
      })),
    })),
  })).filter(p => p.id && p.models.length);
}
// 第三个下拉是推理档位：优先认 effort / thinking / reasoning / variant，其余选项（快速模式、上下文）不在这里改。
export function reasoningOption(model) {
  const selects = (model?.options || []).filter(o => o.values?.length && o.type !== 'boolean');
  return selects.find(o => /effort|thinking|reason|variant/i.test(o.id)) || selects[0] || null;
}
const findProvider = (catalog, id) => catalog?.find(p => p.id === id);
const findModel = (catalog, tier) => findProvider(catalog, tier.instanceId)?.models.find(m => m.id === tier.model);
// 目录里没有的组合不能保存；没有快照时不校验（服务端同样标 missing）。
export function tierProblem(catalog, tier) {
  if (!catalog) return null;
  const provider = findProvider(catalog, tier.instanceId);
  if (!provider) return 'provider';
  const model = provider.models.find(m => m.id === tier.model);
  if (!model) return 'model';
  for (const option of tier.options || []) {
    const known = model.options.find(o => o.id === option.id);
    if (!known || (known.values && !known.values.some(v => v.id === String(option.value)))) return 'option';
  }
  return null;
}
function defaultTier(model, instanceId, previous) {
  const reasoning = reasoningOption(model), keep = (previous?.options || []).filter(o => model.options.some(k => k.id === o.id && (!k.values || k.values.some(v => v.id === String(o.value)))));
  const options = keep.filter(o => o.id !== reasoning?.id);
  if (reasoning) {
    const old = previous?.options?.find(o => /effort|thinking|reason|variant/i.test(o.id))?.value;
    const value = [old, reasoning.values.find(v => v.isDefault)?.id, 'high'].find(v => v !== undefined && reasoning.values.some(x => x.id === String(v))) ?? reasoning.values[0]?.id;
    options.unshift({ id: reasoning.id, value });
  }
  return { instanceId, model: model.id, options };
}

const layerOf = (data, layer) => layer === 'global' ? data.global : layer === 'machine' ? data.machine?.layer || {} : data.campaign?.layer || {};
// 选中层的草稿只作用在这一层；null 表示撤销本层覆盖、回到上一层。
export function resolveTiers(rt, type, upto = rt.layer, withDraft = true) {
  let found = null;
  for (const layer of RT_LAYERS.slice(0, RT_LAYERS.indexOf(upto) + 1)) {
    const drafted = withDraft && layer === rt.layer && type in rt.draft.routes;
    const tiers = drafted ? rt.draft.routes[type] : layerOf(rt.data, layer).routes?.[type]?.tiers;
    if (tiers) found = { tiers, source: layer };
  }
  return found;
}
export function limitAt(rt, key, upto = rt.layer, withDraft = true) {
  let found = null;
  for (const layer of RT_LAYERS.slice(0, RT_LAYERS.indexOf(upto) + 1)) {
    const drafted = withDraft && layer === rt.layer && key in rt.draft.limits;
    const value = drafted ? rt.draft.limits[key] : layerOf(rt.data, layer).limits?.[key];
    if (Number.isInteger(value)) found = { value, source: layer };
  }
  return found;
}
const parentLayer = layer => RT_LAYERS[RT_LAYERS.indexOf(layer) - 1];
export const routingChanges = rt => Object.keys(rt.draft.routes).length + Object.keys(rt.draft.limits).length;
export function routingPatch(rt) {
  const patch = {};
  if (Object.keys(rt.draft.routes).length) patch.routes = Object.fromEntries(Object.entries(rt.draft.routes).map(([type, tiers]) => [type, tiers && { tiers }]));
  if (Object.keys(rt.draft.limits).length) patch.limits = { ...rt.draft.limits };
  return patch;
}
const invalidTiers = rt => Object.values(rt.draft.routes).flatMap(tiers => tiers || []).filter(tier => tierProblem(rt.catalog, tier)).length;
export function quotaState(rt, key) {
  const entry = rt.data?.global?.quota?.[key];
  return entry?.exhausted && (!entry.resumeAt || Date.parse(entry.resumeAt) > Date.now()) ? entry : null;
}
// 恢复时间在将来，写“今天、明天、几月几日”；过去的时间沿用 when()。
export const routingTime = time => !time ? '' : new Date(time) <= new Date() ? when(time) : onDay(new Date(time));

export async function loadRoutingData({ keepDraft = false } = {}) {
  const rt = state.routing ||= { layer: 'global', draft: { routes: {}, limits: {} } };
  const key = `${state.machine}|${state.campaign || ''}`;
  if (rt.key !== key && !keepDraft) { rt.draft = { routes: {}, limits: {} }; if (rt.layer === 'campaign' && !state.campaign) rt.layer = 'global'; }
  rt.key = key; rt.loading = !rt.data; rt.error = null; render();
  try {
    const query = state.campaign ? `?campaign=${encodeURIComponent(state.campaign)}` : '';
    const [data, catalog] = await Promise.all([api(`api/routing${query}`), api('api/catalog').catch(() => null)]);
    if (rt.key !== key) return;
    rt.data = data; rt.catalog = routingCatalog(catalog); rt.catalogAt = catalog?.capturedAt || data.catalog?.capturedAt || null;
    if (!keepDraft) rt.draft = { routes: {}, limits: {} };
    rt.conflict = false;
  } catch (error) { if (rt.key === key) rt.error = error.message; }
  finally { if (rt.key === key) { rt.loading = false; render(); } }
}
export function openRouting() {
  state.view = 'routing'; state.menu = false; state.settings = false;
  const url = new URL(location.href); url.searchParams.set('view', 'routing'); url.hash = ''; setUrl(url);
  scrollTo(0, 0); return loadRoutingData();
}
export function closeRouting() {
  if (state.routing && routingChanges(state.routing) && !confirm(t('rtDiscard'))) return;
  if (state.routing) state.routing.draft = { routes: {}, limits: {} };
  state.view = 'inbox';
  const url = new URL(location.href); url.searchParams.delete('view'); setUrl(url);
  render(); scrollTo(0, 0);
}
export async function saveRoutingDraft() {
  const rt = state.routing;
  if (!rt || rt.busy || !routingChanges(rt) || invalidTiers(rt)) return;
  rt.busy = true; render();
  try {
    const body = { layer: rt.layer, expectedVersion: rt.data.version, patch: routingPatch(rt) };
    if (rt.layer === 'machine') body.machine = rt.data.machine.name;
    if (rt.layer === 'campaign') body.campaign = state.campaign;
    const result = await api('api/routing', body, undefined, 'PUT');
    const missed = Object.entries(result.sync?.peers || {}).filter(([, peer]) => peer.status !== 'ok').map(([name]) => name);
    rt.draft = { routes: {}, limits: {} };
    toast(missed.length ? t('rtSavedUnsynced', missed.join(', ')) : t('rtSaved'), missed.length ? 'error' : 'ok');
    rt.busy = false; await loadRoutingData();
  } catch (error) {
    if (error.status === 409) rt.conflict = true; else toast(error.message, 'error');
  } finally { rt.busy = false; render(); }
}
export async function setRoutingQuota(key, exhausted, resumeAt = null) {
  const rt = state.routing;
  if (!rt || rt.busy) return;
  rt.busy = true; render();
  try {
    await api('api/quota', exhausted ? { key, exhausted: true, resumeAt, markedBy: 'owner', expectedVersion: rt.data.version } : { key, action: 'clear', expectedVersion: rt.data.version });
    rt.quotaForm = null; rt.busy = false;
    toast(exhausted ? t('rtQuotaMarked') : t('rtQuotaCleared'), 'ok');
    // 额度只改全局层的 quota，本页其他草稿保留，基于新版本继续编辑。
    await loadRoutingData({ keepDraft: true });
  } catch (error) {
    if (error.status === 409) rt.conflict = true; else toast(error.message, 'error');
  } finally { rt.busy = false; render(); }
}

// 改某一档前先把这一行复制到本层草稿；改完和已保存的一样就去掉草稿。
function editTiers(rt, type, change) {
  const current = resolveTiers(rt, type);
  const tiers = clone(current?.tiers || []);
  change(tiers);
  const saved = layerOf(rt.data, rt.layer).routes?.[type]?.tiers;
  if (saved && same(saved, tiers)) delete rt.draft.routes[type]; else rt.draft.routes[type] = tiers;
}
function stepLimit(rt, key, delta) {
  const current = limitAt(rt, key)?.value ?? 0, parent = parentLayer(rt.layer) ? limitAt(rt, key, parentLayer(rt.layer), false)?.value : Infinity;
  const next = Math.max(0, Math.min(parent, current + delta)), saved = layerOf(rt.data, rt.layer).limits?.[key];
  if (next === current) return;
  if (saved === next) delete rt.draft.limits[key]; else rt.draft.limits[key] = next;
}
export function routingAction(action, button) {
  const rt = state.routing, { type, key } = button.dataset, index = Number(button.dataset.index);
  if (action === 'rt-open') return openRouting();
  if (action === 'rt-back') return closeRouting();
  if (!rt?.data) return action === 'rt-reload' ? loadRoutingData() : undefined;
  switch (action) {
    case 'rt-layer': {
      const layer = button.dataset.layer;
      if (layer === rt.layer || (layer === 'campaign' && !rt.data.campaign)) break;
      if (routingChanges(rt) && !confirm(t('rtDiscard'))) break;
      rt.layer = layer; rt.draft = { routes: {}, limits: {} }; rt.conflict = false; break;
    }
    case 'rt-override': rt.draft.routes[type] = clone(resolveTiers(rt, type, parentLayer(rt.layer), false).tiers); break;
    case 'rt-revert': if (layerOf(rt.data, rt.layer).routes?.[type]) rt.draft.routes[type] = null; else delete rt.draft.routes[type]; break;
    case 'rt-undo': delete rt.draft.routes[type]; break;
    case 'rt-up': editTiers(rt, type, tiers => tiers.splice(index - 1, 0, ...tiers.splice(index, 1))); break;
    case 'rt-down': editTiers(rt, type, tiers => tiers.splice(index + 1, 0, ...tiers.splice(index, 1))); break;
    case 'rt-remove': editTiers(rt, type, tiers => { if (tiers.length > 1) tiers.splice(index, 1); }); break;
    case 'rt-add': editTiers(rt, type, tiers => {
      const used = new Set(tiers.map(tier => `${tier.instanceId}/${tier.model}`));
      const pick = rt.catalog?.flatMap(p => p.models.map(m => [p, m])).find(([p, m]) => !used.has(`${p.id}/${m.id}`));
      if (pick) tiers.push(defaultTier(pick[1], pick[0].id));
    }); break;
    case 'rt-limit': stepLimit(rt, key, Number(button.dataset.delta)); break;
    case 'rt-limit-revert': if (Number.isInteger(layerOf(rt.data, rt.layer).limits?.[key])) rt.draft.limits[key] = null; else delete rt.draft.limits[key]; break;
    case 'rt-discard': rt.draft = { routes: {}, limits: {} }; break;
    case 'rt-save': return saveRoutingDraft();
    case 'rt-reload': return loadRoutingData({ keepDraft: true });
    case 'rt-reload-discard': return loadRoutingData();
    case 'rt-quota-mark': rt.quotaForm = key; break;
    case 'rt-quota-cancel': rt.quotaForm = null; break;
    case 'rt-quota-all': rt.quotaAll = !rt.quotaAll; break;
    case 'rt-quota-confirm': {
      const value = document.querySelector(`[data-rt-resume="${CSS.escape(key)}"]`)?.value;
      return setRoutingQuota(key, true, value ? new Date(value).toISOString() : null);
    }
    case 'rt-quota-clear': return setRoutingQuota(key, false);
  }
  render();
}
// 下拉改动：换 harness 取该 harness 的第一个模型，换模型尽量保留原推理档位。
export function routingChange(select) {
  const rt = state.routing; if (!rt?.data || !rt.catalog) return;
  const { type, field } = select.dataset, index = Number(select.dataset.index), value = select.value;
  editTiers(rt, type, tiers => {
    const tier = tiers[index]; if (!tier) return;
    if (field === 'harness') { const model = findProvider(rt.catalog, value)?.models[0]; if (model) tiers[index] = defaultTier(model, value, tier); }
    if (field === 'model') { const model = findProvider(rt.catalog, tier.instanceId)?.models.find(m => m.id === value); if (model) tiers[index] = defaultTier(model, tier.instanceId, tier); }
    if (field === 'effort') {
      const reasoning = reasoningOption(findModel(rt.catalog, tier)); if (!reasoning) return;
      const option = tier.options.find(o => o.id === reasoning.id);
      if (option) option.value = value; else tier.options.unshift({ id: reasoning.id, value });
    }
  });
  render();
}

const layerName = (rt, layer) => layer === 'global' ? t('全局') : layer === 'machine' ? t('本机') : 'Campaign';
const sourceTag = (rt, source) => `<span class="rt-source ${source}">${source === 'global' ? t('来自全局') : source === 'machine' ? t('本机覆盖') : t('Campaign 覆盖')}</span>`;
function tierSelects(rt, type, tier, index, editable) {
  const problem = tierProblem(rt.catalog, tier), provider = findProvider(rt.catalog, tier.instanceId), model = findModel(rt.catalog, tier);
  const reasoning = reasoningOption(model), effort = tier.options.find(o => o.id === reasoning?.id) || tier.options[0];
  const missing = value => `<option selected disabled>${esc(value)}</option>`;
  const choose = (field, label, current, options, stale) => `<label class="rt-field rt-${field}"><span class="sr">${label}</span><select data-rt-field data-field="${field}" data-type="${type}" data-index="${index}" aria-label="${label}" ${editable && rt.catalog ? '' : 'disabled'}>${stale ? missing(current) : ''}${options.map(o => `<option value="${esc(o.id)}" ${!stale && o.id === current ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${icon('down', 16)}</label>`;
  if (!editable || !rt.catalog) {
    return `<span class="rt-cell rt-harness">${esc(provider?.label || tier.instanceId)}</span><span class="rt-cell rt-model">${esc(model?.label || tier.model)}</span><span class="rt-cell rt-effort">${esc(reasoning?.values.find(v => v.id === String(effort?.value))?.label || effort?.value || '')}</span>${problem ? `<span class="rt-problem">${icon('warn', 14)}${t('不在目录里')}</span>` : ''}`;
  }
  return choose('harness', t('Harness'), tier.instanceId, rt.catalog.map(p => ({ id: p.id, label: p.label })), problem === 'provider')
    + choose('model', t('模型'), tier.model, (provider?.models || []).map(m => ({ id: m.id, label: m.label || m.id })), problem === 'provider' || problem === 'model')
    + (reasoning ? choose('effort', t('推理档位'), String(effort?.value ?? ''), reasoning.values, problem !== null)
      : `<label class="rt-field rt-effort"><span class="sr">${t('推理档位')}</span><select data-rt-field data-field="effort" data-type="${type}" data-index="${index}" aria-label="${t('推理档位')}" disabled><option>${t('目录未提供推理档位')}</option></select>${icon('down', 16)}</label>`);
}
function routeCard(rt, type) {
  const editableLayer = state.summary?.canManage, here = resolveTiers(rt, type), drafted = type in rt.draft.routes, reverting = drafted && rt.draft.routes[type] === null;
  const own = here?.source === rt.layer, editable = editableLayer && (own || rt.layer === 'global');
  const tiers = here?.tiers || [];
  const actions = rt.layer === 'global' || !editableLayer ? '' : reverting ? `<button class="text-button" data-action="rt-undo" data-type="${type}">${icon('undo', 15)}${t('不撤销了')}</button>`
    : own ? `<button class="text-button" data-action="rt-revert" data-type="${type}">${icon('undo', 15)}${t('rtRevertTo', layerName(rt, parentLayer(rt.layer)))}</button>`
    : `<button class="text-button" data-action="rt-override" data-type="${type}">${icon('pen', 15)}${t('在本层覆盖')}</button>`;
  const rows = tiers.map((tier, index) => {
    const quota = quotaState(rt, `${tier.instanceId}/${tier.model}`), problem = tierProblem(rt.catalog, tier);
    return `<li class="rt-tier ${quota ? 'exhausted' : ''} ${problem ? 'invalid' : ''}"><span class="rt-rank"><span class="key num">${index + 1}</span><span class="rt-rank-label">${index ? t('备用') : t('首选')}</span></span><span class="rt-fields ${editable && rt.catalog ? '' : 'static'}">${tierSelects(rt, type, tier, index, editable)}</span>${editable ? `<span class="rt-moves"><button class="icon-button" data-action="rt-up" data-type="${type}" data-index="${index}" aria-label="${t('上移')}" ${index ? '' : 'disabled'}>${icon('up', 18)}</button><button class="icon-button" data-action="rt-down" data-type="${type}" data-index="${index}" aria-label="${t('下移')}" ${index < tiers.length - 1 ? '' : 'disabled'}>${icon('down', 18)}</button><button class="icon-button" data-action="rt-remove" data-type="${type}" data-index="${index}" aria-label="${t('删掉这一档')}" ${tiers.length > 1 ? '' : 'disabled'}>${icon('x', 18)}</button></span>` : ''}${quota ? `<span class="rt-quota-note">${icon('clock', 14)}${t('rtSkipped', quota.resumeAt ? routingTime(quota.resumeAt) : t('恢复时间未知'))}</span>` : ''}${problem && editable ? `<span class="rt-quota-note bad">${icon('warn', 14)}${t('rtNotInCatalog')}</span>` : ''}</li>`;
  }).join('');
  const add = editable && rt.catalog ? `<button class="rt-add" data-action="rt-add" data-type="${type}">${icon('plus', 16)}${t('添加备用')}</button>` : '';
  const note = reverting ? `<p class="rt-pending">${t('rtWillRevert', layerName(rt, parentLayer(rt.layer)))}</p>` : drafted ? `<p class="rt-pending">${t('未保存')}</p>` : '';
  return `<article class="card rt-route ${drafted ? 'dirty' : ''} ${own && rt.layer !== 'global' ? 'own' : ''}" id="rt-route-${type}"><header class="rt-route-head"><div><h3>${t(`route.${type}`)}</h3><p>${t(`routeHelp.${type}`)}</p></div>${here && rt.layer !== 'global' ? sourceTag(rt, here.source) : ''}</header><ol class="rt-tiers ${editable ? '' : 'inherited'}">${rows}</ol>${add}${note}${actions ? `<div class="actions">${actions}</div>` : ''}</article>`;
}
function limitsCard(rt) {
  const canEdit = state.summary?.canManage, parent = parentLayer(rt.layer);
  const row = key => {
    const current = limitAt(rt, key), max = parent ? limitAt(rt, key, parent, false)?.value : null, own = current?.source === rt.layer && rt.layer !== 'global';
    const drafted = key in rt.draft.limits, value = current?.value ?? 0;
    return `<div class="rt-limit ${drafted ? 'dirty' : ''}"><div class="rt-limit-text"><b>${t(`limit.${key}`)}</b><span>${t(`limitHelp.${key}`)}</span><span class="rt-limit-meta">${current ? sourceTag(rt, current.source) : ''}${parent ? `<span>${t('rtTightenOnly', max)}</span>` : ''}</span></div><div class="rt-stepper"><button class="icon-button" data-action="rt-limit" data-key="${key}" data-delta="-1" aria-label="${t('减少')}" ${canEdit && value > 0 ? '' : 'disabled'}>${icon('minus', 18)}</button><output class="num" aria-label="${t(`limit.${key}`)}">${value}</output><button class="icon-button" data-action="rt-limit" data-key="${key}" data-delta="1" aria-label="${t('增加')}" ${canEdit && (max === null || value < max) ? '' : 'disabled'}>${icon('plus', 18)}</button></div>${canEdit && rt.layer !== 'global' && (own || rt.draft.limits[key] === null) ? `<div class="actions">${rt.draft.limits[key] === null ? `<span class="rt-pending">${t('rtWillRevert', layerName(rt, parent))}</span>` : `<button class="text-button" data-action="rt-limit-revert" data-key="${key}">${icon('undo', 15)}${t('rtRevertTo', layerName(rt, parent))}</button>`}</div>` : ''}</div>`;
  };
  return `<article class="card panel rt-panel" id="rt-limits"><header class="panel-head"><h4>${t('并发上限')}</h4><span class="panel-sub">${t('rtLimitsSub')}</span></header>${row('execution')}${row('design')}</article>`;
}
function quotaCard(rt) {
  const keys = new Set(Object.keys(rt.data.global.quota || {}));
  for (const layer of RT_LAYERS) for (const block of Object.values(layerOf(rt.data, layer).routes || {})) for (const tier of block.tiers || []) keys.add(`${tier.instanceId}/${tier.model}`);
  for (const tiers of Object.values(rt.draft.routes)) for (const tier of tiers || []) keys.add(`${tier.instanceId}/${tier.model}`);
  const sorted = [...keys].sort((a, b) => !!quotaState(rt, b) - !!quotaState(rt, a) || a.localeCompare(b)), canEdit = state.summary?.canManage;
  // 用尽的模型直接列出；正常的收在分隔线下，要标记时再展开（标记表单开着时保持展开）。
  const out = sorted.filter(key => quotaState(rt, key)), fine = sorted.filter(key => !quotaState(rt, key)), open = rt.quotaAll || fine.includes(rt.quotaForm);
  const row = key => {
    const entry = quotaState(rt, key), [instance, ...rest] = key.split('/'), label = findProvider(rt.catalog, instance)?.label || instance;
    const form = rt.quotaForm === key ? `<div class="rt-quota-form"><label><span>${t('预计恢复（可不填）')}</span><input type="datetime-local" data-rt-resume="${esc(key)}"></label><button class="button primary" data-action="rt-quota-confirm" data-key="${esc(key)}">${t('标记用尽')}</button><button class="text-button" data-action="rt-quota-cancel">${t('取消')}</button></div>` : '';
    const detail = entry ? `${entry.resumeAt ? t('rtResume', routingTime(entry.resumeAt)) : t('恢复时间未知')} · ${t(entry.markedBy === 'owner' ? '你标的' : '编排标的')}${entry.markedAt ? ` · <span class="num">${when(entry.markedAt)}</span>` : ''}` : '';
    return `<li class="rt-quota ${entry ? 'out' : ''}"><div class="rt-quota-main"><span class="rt-quota-name"><b>${esc(label)}</b><span>${esc(rest.join('/'))}</span></span><span class="rt-state ${entry ? 'out' : 'ok'}">${entry ? t('用尽') : t('正常')}</span>${canEdit && !form ? (entry ? `<button class="link rt-quota-action" data-action="rt-quota-clear" data-key="${esc(key)}">${t('清除标记')}</button>` : `<button class="link rt-quota-action" data-action="rt-quota-mark" data-key="${esc(key)}">${t('标记用尽')}</button>`) : ''}</div>${detail ? `<p class="rt-quota-detail">${detail}</p>` : ''}${form}</li>`;
  };
  return `<article class="card panel rt-panel" id="rt-quota"><header class="panel-head"><h4>${t('额度')}</h4><span class="panel-sub">${t('rtQuotaSub')}</span></header>${out.length ? `<ul class="rt-quota-list">${out.map(row).join('')}</ul>` : `<p class="panel-empty">${t('rtQuotaAllOk')}</p>`}${fine.length ? `<button class="closed-toggle ${open ? 'expanded' : ''}" data-action="rt-quota-all" aria-expanded="${open}"><span>${t('正常')}</span><span class="num">${fine.length}</span>${icon('down', 15)}</button>${open ? `<ul class="rt-quota-list">${fine.map(row).join('')}</ul>` : ''}` : ''}</article>`;
}
function syncCard(rt) {
  const peers = Object.entries(rt.data.sync?.peers || {});
  for (const peer of state.summary?.peers || []) if (!peers.some(([name]) => name === peer.name)) peers.push([peer.name, { status: 'never' }]);
  const label = peer => peer.status === 'ok' && peer.version >= rt.data.version ? ['ok', t('已同步')] : peer.status === 'ok' ? ['late', t('不是最新')] : peer.status === 'rejected' ? ['late', t('拒收')] : peer.status === 'never' ? ['wait', t('还没推送过')] : ['off', t('连不上')];
  const self = `<li class="rt-sync-row"><span class="dot ok"></span><b>${esc(rt.data.machine?.name || state.machine)}</b><span class="rt-sync-state">${t('本机')} · v<span class="num">${rt.data.version}</span></span></li>`;
  return `<article class="card panel rt-panel" id="rt-sync"><header class="panel-head"><h4>${t('同步')}</h4><span class="panel-sub">${t('rtSyncSub')}</span></header><ul class="rt-sync">${self}${peers.map(([name, peer]) => { const [tone, text] = label(peer); return `<li class="rt-sync-row"><span class="dot ${tone}"></span><b>${esc(name)}</b><span class="rt-sync-state">${text}${peer.version != null ? ` · v<span class="num">${peer.version}</span>` : ''}${peer.at ? ` · <span class="num">${when(peer.at)}</span>` : ''}</span></li>`; }).join('')}</ul>${peers.length ? '' : `<p class="panel-empty">${t('rtSyncAlone')}</p>`}</article>`;
}
export function renderRouting() {
  const rt = state.routing;
  const head = `<div class="rt-head"><button class="text-button rt-back" data-action="rt-back">${icon('left', 16)}Inbox</button><h1>${t('派票设置')}</h1>${rt?.data ? `<p class="rt-meta">${rt.catalog ? `${icon('list', 14)}${t('rtCatalogAt', routingTime(rt.catalogAt))}` : `<span class="rt-warn">${icon('warn', 14)}${t('rtNoCatalog')}</span>`}<span>·</span><span>${t('rtVersion')} <span class="num">${rt.data.version}</span></span></p>` : ''}</div>`;
  if (!rt || rt.loading) return `<main class="board-wrap"><div class="wrap rt-page" aria-busy="true">${head}<div class="card sk-card"><span class="sk sk-line short"></span><span class="sk sk-line"></span><span class="sk sk-block"></span></div></div></main>`;
  if (!rt.data) return `<main class="board-wrap"><div class="wrap rt-page">${head}<div class="state">${icon('offline', 36)}<h2>${t('派票设置打不开')}</h2><p>${esc(rt.error || '')}</p><div class="state-actions"><button class="button primary" data-action="rt-reload">${icon('refresh', 16)}${t('重试')}</button></div></div></div></main>`;
  const exhausted = [...new Set(Object.keys(rt.data.global.quota || {}))].filter(key => quotaState(rt, key)).length;
  const layers = `<div class="rt-layers" role="radiogroup" aria-label="${t('层级')}">${RT_LAYERS.map(layer => `<button role="radio" aria-checked="${rt.layer === layer}" class="${rt.layer === layer ? 'selected' : ''}" data-action="rt-layer" data-layer="${layer}" ${layer === 'campaign' && !rt.data.campaign ? 'disabled' : ''}><b>${layerName(rt, layer)}</b><span>${esc(layer === 'global' ? t('所有机器') : layer === 'machine' ? rt.data.machine?.name || state.machine : state.data?.campaign?.title || state.campaign || t('未选 Campaign'))}</span></button>`).join('')}</div><p class="rt-layer-help">${t(`layerHelp.${rt.layer}`)} ${t('rtOnlyNew')}</p>`;
  const banner = !state.summary?.canManage ? `<div class="alert late" role="status">${icon('warn', 16)}<span class="alert-text">${t('rtReadOnly')}</span></div>` : '';
  const conflict = rt.conflict ? `<div class="alert failed" role="alert">${icon('warn', 16)}<span class="alert-text">${t('rtConflict')}</span><span class="rt-alert-actions"><button class="alert-action" data-action="rt-reload">${t('载入最新，保留我的改动')}</button><button class="alert-action quiet" data-action="rt-reload-discard">${t('放弃我的改动')}</button></span></div>` : '';
  const changes = routingChanges(rt), invalid = invalidTiers(rt);
  const tabs = `<nav class="tabs" aria-label="${t('分区')}"><a href="#rt-routes" class="active">${icon('route', 18)}<span>${t('路由')}</span></a><a href="#rt-limits">${icon('gauge', 18)}<span>${t('上限')}</span></a><a href="#rt-quota">${icon('clock', 18)}<span>${t('额度')}</span>${exhausted ? `<span class="count num hot">${exhausted}</span>` : ''}</a><a href="#rt-sync">${icon('server', 18)}<span>${t('同步')}</span></a></nav>`;
  // 冲突时托盘就地说明并给“载入最新”，不用滚回页顶找提示。
  const trayBody = rt.conflict ? `<span class="tray-count">${icon('warn', 15)}${t('别处改过了')}</span><button class="submit" data-action="rt-reload" ${rt.busy ? 'disabled' : ''}>${icon('refresh', 16)}<span>${t('载入最新')}</span></button>`
    : `<span class="tray-count">${invalid ? `${icon('warn', 15)}${t('rtInvalid', invalid)}` : `<b class="num">${changes}</b> ${t('处改动')}`}</span><button class="tray-clear" data-action="rt-discard">${t('放弃')}</button><button class="submit" data-action="rt-save" ${rt.busy || invalid ? 'disabled' : ''}>${icon('ok', 16)}<span>${rt.busy ? t('保存中…') : t('保存')}</span></button>`;
  const tray = `<div class="tray ${changes || rt.conflict ? 'show' : ''}" ${changes || rt.conflict ? '' : 'inert'}>${trayBody}</div>`;
  return `${tabs}<main class="board-wrap"><div class="wrap rt-page">${head}${layers}${banner}${conflict}<div class="rt-board"><section class="lane rt-main" id="rt-routes"><div class="lane-header"><h2>${t('任务类型')}</h2></div><div class="lane-body">${ROUTE_TYPES.map(type => routeCard(rt, type)).join('')}</div></section><section class="lane side rt-side"><div class="lane-body">${limitsCard(rt)}${quotaCard(rt)}${syncCard(rt)}</div></section></div></div></main>${tray}`;
}
