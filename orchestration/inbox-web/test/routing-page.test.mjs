import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadAppSource } from './load-app.mjs';

const tier = (instanceId, model, id = 'thinking', value = 'high') => ({ instanceId, model, options: [{ id, value }] });
// Live T3 catalog shape: options[].values (string|boolean arrays) + default. Legacy options[].options still accepted by routingCatalog.
const valuesOpt = (id, values, defaultValue) => {
  const option = { id, values: [...values] };
  if (defaultValue !== undefined) option.default = defaultValue;
  return option;
};
const catalog = { capturedAt: '2026-10-29T03:00:00.000Z', capabilities: { providers: [
  { providerInstanceId: 'codex', displayName: 'Codex', models: [
    { id: 'gpt-6.1-sol', options: [
      valuesOpt('reasoningEffort', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low'),
      valuesOpt('serviceTier', ['default', 'priority'], 'default'),
    ] },
  ] },
  { providerInstanceId: 'claudeAgent', displayName: 'Claude', models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', options: [
      valuesOpt('effort', ['low', 'high', 'max'], 'high'),
      { id: 'fastMode', values: [false, true] },
    ] },
  ] },
  { providerInstanceId: 'pi', displayName: 'Pi', models: [
    { id: 'xai/grok-4.5', label: 'Grok 4.5', options: [valuesOpt('thinking', ['low', 'high', 'xhigh'], 'high')] },
    { id: 'cursor/grok-4.5', label: 'Grok 4.5 Medium', options: [valuesOpt('thinking', ['low', 'medium', 'high'], 'medium')] },
    { id: 'openai/chat-latest', label: 'Chat Latest', options: [valuesOpt('thinking', ['off', 'minimal', 'low', 'medium', 'high'], 'medium')] },
  ] },
] } };
function view() {
  const routes = Object.fromEntries(['discussion', 'design', 'research', 'code', 'adjudication', 'review'].map(type => [type, { tiers: [tier('pi', 'xai/grok-4.5'), tier('pi', 'cursor/grok-4.5')] }]));
  return {
    version: 12, updatedAt: '2026-10-23T08:00:00.000Z',
    global: { routes, limits: { execution: 8, design: 2 }, quota: {} },
    machine: { name: 'desk', layer: { routes: {}, limits: { execution: 6 } } }, machines: {},
    campaign: { dir: 'x', layer: { routes: { design: { tiers: [tier('claudeAgent', 'claude-opus-5-5', 'effort'), tier('grok', 'grok-4.5', 'reasoningEffort')] } }, limits: {} } },
    catalog: { present: true, capturedAt: catalog.capturedAt }, sync: { peers: {} },
  };
}

async function pageContext() {
  const requests = [];
  const context = vm.createContext({
    navigator: { language: 'zh-CN' },
    document: { getElementById: () => ({}), documentElement: { dataset: {} }, querySelector: () => null, querySelectorAll: () => [], body: { classList: { toggle() {} } } },
    location: { href: 'https://example.test/?campaign=demo&view=routing' }, URL, scrollY: 0, scrollTo() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
    requests, responses: [],
  });
  context.fetch = async (url, options = {}) => {
    const request = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const route = new URL(request.url).pathname;
    const reply = context.responses.find(r => r.method === request.method && route.endsWith(r.path));
    const status = reply?.status ?? 200, body = reply?.body ?? (route.endsWith('api/catalog') ? catalog : view());
    return { ok: status < 400, status, json: async () => body };
  };
  await loadAppSource(context, { stopBefore: "document.addEventListener('click'" });
  vm.runInContext(`toast = (message, tone) => { toasted = [message, tone]; };
    summary = { name: 'desk', canManage: true, campaigns: [], peers: [] }; machine = 'desk'; campaign = 'demo';
    routing = { layer: 'global', key: 'desk|demo', data: fixture, catalog: routingCatalog(rawCatalog), catalogAt: rawCatalog.capturedAt, draft: { routes: {}, limits: {} } };`,
  Object.assign(context, { fixture: view(), rawCatalog: catalog }));
  return context;
}
const press = (context, action, dataset = {}) => { context.button = { dataset }; return vm.runInContext(`routingAction(${JSON.stringify(action)}, button)`, context); };

test('model without reasoning options shows a disabled explanation instead of a blank selector', async () => {
  const context = await pageContext();
  vm.runInContext(`routing.catalog.push({ id: 'grok', label: 'Grok', models: [{ id: 'grok-build', label: 'Grok Build', options: [] }] });
    routing.draft.routes.code = [{ instanceId: 'grok', model: 'grok-build', options: [] }];`, context);
  const html = vm.runInContext('renderRouting()', context);
  assert.match(html, /data-field="effort" data-type="code" data-index="0"[^>]*disabled[^>]*><option[^>]*>目录未提供推理档位<\/option>/);
});

test('目录外的组合不可选：下拉只列目录项，旧值只读占位，有它就不能保存', async () => {
  const context = await pageContext();
  press(context, 'rt-layer', { layer: 'campaign' });
  const html = vm.runInContext('renderRouting()', context);
  const card = html.slice(html.indexOf('id="rt-route-design"'), html.indexOf('id="rt-route-research"'));
  const harness = [...card.matchAll(/data-field="harness"[^>]*>([\s\S]*?)<\/select>/g)].map(m => m[1]);
  assert.equal(harness.length, 2);
  assert.match(harness[1], /^<option selected disabled>grok<\/option>/);
  assert.deepEqual([...harness[1].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['codex', 'claudeAgent', 'pi']);
  assert.match(card, /class="rt-tier  invalid"/);
  assert.match(card, /不在目录快照里/);
  assert.equal(vm.runInContext("tierProblem(routing.catalog, routing.data.campaign.layer.routes.design.tiers[1])", context), 'provider');
  // 推理档位也只列这个模型在目录里的值。
  const effort = card.match(/data-field="effort" data-type="design" data-index="0"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...effort.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['low', 'high', 'max']);
  // 有目录外的档就不让保存；换成目录里的模型后可以保存。
  press(context, 'rt-up', { type: 'design', index: '1' });
  assert.match(vm.runInContext('renderRouting()', context), /data-action="rt-save" disabled/);
  vm.runInContext(`routingChange({ dataset: { type: 'design', field: 'harness', index: '0' }, value: 'pi' })`, context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(routing.draft.routes.design[0])', context)), tier('pi', 'xai/grok-4.5'));
  assert.match(vm.runInContext('renderRouting()', context), /data-action="rt-save" >/);
});

test('values+default catalog: codex gpt-6.1-sol low..ultra and pi openai/chat-latest off..high, defaults selected, labels shown', async () => {
  const context = await pageContext();
  // Seed a code route draft with the two acceptance models so the dropdowns render.
  vm.runInContext(`routing.draft.routes.code = [
    { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'low' }] },
    { instanceId: 'pi', model: 'openai/chat-latest', options: [{ id: 'thinking', value: 'medium' }] },
  ]`, context);
  const html = vm.runInContext('renderRouting()', context);
  const card = html.slice(html.indexOf('id="rt-route-code"'), html.indexOf('id="rt-route-adjudication"'));

  const codexEffort = card.match(/data-field="effort" data-type="code" data-index="0"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...codexEffort.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.match(codexEffort, /value="low" selected/);

  const chatEffort = card.match(/data-field="effort" data-type="code" data-index="1"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...chatEffort.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['off', 'minimal', 'low', 'medium', 'high']);
  assert.match(chatEffort, /value="medium" selected/);

  // Model list includes search-merged chat-latest and shows catalog labels.
  const modelSelect = card.match(/data-field="model" data-type="code" data-index="1"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...modelSelect.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['xai/grok-4.5', 'cursor/grok-4.5', 'openai/chat-latest']);
  assert.match(modelSelect, />Chat Latest</);

  // routingCatalog maps defaults; switching model picks catalog default.
  const mapped = JSON.parse(vm.runInContext('JSON.stringify(routingCatalog(rawCatalog))', context));
  const sol = mapped.find(p => p.id === 'codex').models.find(m => m.id === 'gpt-6.1-sol');
  const reasoning = sol.options.find(o => o.id === 'reasoningEffort');
  assert.deepEqual(reasoning.values.map(v => v.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(reasoning.values.find(v => v.isDefault).id, 'low');
  const chat = mapped.find(p => p.id === 'pi').models.find(m => m.id === 'openai/chat-latest');
  assert.equal(chat.label, 'Chat Latest');
  assert.equal(chat.options[0].values.find(v => v.isDefault).id, 'medium');

  // Boolean values arrays are not treated as the effort dropdown.
  const claude = mapped.find(p => p.id === 'claudeAgent').models[0];
  assert.equal(claude.options.find(o => o.id === 'fastMode').type, 'boolean');
  assert.equal(claude.options.find(o => o.id === 'fastMode').values, null);

  // Invalid effort is flagged and blocks save.
  vm.runInContext(`routing.draft.routes.code[0].options[0].value = 'ludicrous'`, context);
  assert.equal(vm.runInContext("tierProblem(routing.catalog, routing.draft.routes.code[0])", context), 'option');
  assert.match(vm.runInContext('renderRouting()', context), /data-action="rt-save" disabled/);

  // Picking the model fresh applies catalog default.
  vm.runInContext(`routingChange({ dataset: { type: 'code', field: 'model', index: '0' }, value: 'gpt-6.1-sol' })`, context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(routing.draft.routes.code[0])', context)), {
    instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'low' }],
  });
});

test('legacy options[].options catalog still renders effort list', async () => {
  const context = await pageContext();
  const legacy = { capturedAt: '2026-10-23T08:00:00.000Z', capabilities: { providers: [
    { providerInstanceId: 'pi', displayName: 'Pi', models: [
      { id: 'xai/grok-4.5', options: [{ id: 'thinking', type: 'select', options: [
        { id: 'low', label: 'Low' }, { id: 'high', label: 'High', isDefault: true },
      ] }] },
    ] },
  ] } };
  vm.runInContext('routing.catalog = routingCatalog(legacyCatalog)', Object.assign(context, { legacyCatalog: legacy }));
  vm.runInContext(`routing.draft.routes.code = [{ instanceId: 'pi', model: 'xai/grok-4.5', options: [{ id: 'thinking', value: 'high' }] }]`, context);
  const html = vm.runInContext('renderRouting()', context);
  const effort = html.match(/data-field="effort" data-type="code" data-index="0"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...effort.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['low', 'high']);
  assert.match(effort, /value="high" selected/);
});

test('保存：草稿合成一个 patch，带 expectedVersion 用 PUT 发出，成功后清空草稿并重新载入', async () => {
  const context = await pageContext();
  press(context, 'rt-down', { type: 'code', index: '0' });
  press(context, 'rt-limit', { key: 'design', delta: '1' });
  assert.match(vm.runInContext('renderRouting()', context), /<b class="num">2<\/b> 处改动/);
  await vm.runInContext('saveRoutingDraft()', context);
  const put = context.requests.find(r => r.method === 'PUT');
  assert.equal(new URL(put.url).pathname, '/api/routing');
  assert.deepEqual(put.body, { layer: 'global', expectedVersion: 12, patch: {
    routes: { code: { tiers: [tier('pi', 'cursor/grok-4.5'), tier('pi', 'xai/grok-4.5')] } },
    limits: { design: 3 },
  } });
  assert.equal(vm.runInContext('routingChanges(routing)', context), 0);
  assert.ok(context.requests.some(r => r.method === 'GET' && r.url.includes('api/routing?campaign=demo')));
  assert.match(context.toasted[0], /已保存/);
});

test('本机层只能收紧上限；覆盖和撤销覆盖分别发本层值和 null', async () => {
  const context = await pageContext();
  press(context, 'rt-layer', { layer: 'machine' });
  let html = vm.runInContext('renderRouting()', context);
  assert.match(html, /上层 8，只能收紧/);
  press(context, 'rt-limit', { key: 'execution', delta: '1' });
  press(context, 'rt-limit', { key: 'execution', delta: '1' });
  press(context, 'rt-limit', { key: 'execution', delta: '1' });
  assert.equal(vm.runInContext('limitAt(routing, "execution").value', context), 8);
  html = vm.runInContext('renderRouting()', context);
  assert.match(html, /data-key="execution" data-delta="1" aria-label="增加" disabled/);
  press(context, 'rt-limit-revert', { key: 'execution' });
  press(context, 'rt-override', { type: 'research' });
  await vm.runInContext('saveRoutingDraft()', context);
  const put = context.requests.find(r => r.method === 'PUT');
  assert.deepEqual(put.body, { layer: 'machine', machine: 'desk', expectedVersion: 12, patch: {
    routes: { research: { tiers: [tier('pi', 'xai/grok-4.5'), tier('pi', 'cursor/grok-4.5')] } },
    limits: { execution: null },
  } });
});

test('版本冲突：409 时保留草稿，页顶和托盘都提示，载入最新后草稿还在、可再保存', async () => {
  const context = await pageContext();
  context.responses.push({ method: 'PUT', path: 'api/routing', status: 409, body: { error: '路由版本冲突，请重新加载后再改' } });
  press(context, 'rt-remove', { type: 'review', index: '1' });
  await vm.runInContext('saveRoutingDraft()', context);
  assert.equal(vm.runInContext('routing.conflict', context), true);
  assert.equal(vm.runInContext('routingChanges(routing)', context), 1);
  const html = vm.runInContext('renderRouting()', context);
  assert.match(html, /class="alert failed" role="alert"[\s\S]*别处刚改过派票设置/);
  assert.match(html, /<div class="tray show" >[\s\S]*别处改过了[\s\S]*data-action="rt-reload"/);
  assert.doesNotMatch(html, /data-action="rt-save"/);
  context.fixture = { ...view(), version: 13 };
  context.responses.push({ method: 'GET', path: 'api/routing', body: context.fixture });
  await press(context, 'rt-reload');
  assert.equal(vm.runInContext('routing.conflict', context), false);
  assert.equal(vm.runInContext('routing.data.version', context), 13);
  assert.equal(vm.runInContext('routingChanges(routing)', context), 1);
  context.responses.length = 0;
  await vm.runInContext('saveRoutingDraft()', context);
  assert.equal(context.requests.filter(r => r.method === 'PUT').at(-1).body.expectedVersion, 13);
});

test('额度用尽的档标出恢复时间；标记和清除带版本号发到 /api/quota', async () => {
  const context = await pageContext();
  vm.runInContext(`routing.data.global.quota = { 'pi/xai/grok-4.5': { exhausted: true, resumeAt: new Date(Date.now() + 86400000).toISOString(), markedBy: 'orchestrator', markedAt: new Date().toISOString() } }`, context);
  const html = vm.runInContext('renderRouting()', context);
  assert.match(html, /class="rt-tier exhausted /);
  assert.match(html, /新票跳过这一档，预计 明天 /);
  assert.match(html, /编排标的/);
  assert.match(html, /<span class="count num hot">1<\/span>/);
  // 正常的模型收在“正常”分隔线下，展开后才能标记。
  assert.match(html, /data-action="rt-quota-all" aria-expanded="false"><span>正常<\/span><span class="num">3<\/span>/);
  assert.doesNotMatch(html, /data-action="rt-quota-mark"/);
  press(context, 'rt-quota-all');
  assert.match(vm.runInContext('renderRouting()', context), /data-action="rt-quota-mark" data-key="pi\/cursor\/grok-4\.5"/);
  await vm.runInContext("setRoutingQuota('pi/xai/grok-4.5', false)", context);
  assert.deepEqual(context.requests.find(r => r.method === 'POST').body, { key: 'pi/xai/grok-4.5', action: 'clear', expectedVersion: 12 });
});

test('没有登录也不在受信局域网时只读：不出现可改的控件', async () => {
  const context = await pageContext();
  vm.runInContext('summary.canManage = false', context);
  const html = vm.runInContext('renderRouting()', context);
  assert.match(html, /只读：/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /data-action="rt-(add|up|down|remove|quota-mark|quota-clear)"/);
  assert.match(html, /data-action="rt-limit"[^>]*disabled/);
});

test('英文界面的设置页没有中文，模型和机器名保持原样', async () => {
  const context = await pageContext();
  vm.runInContext("language = 'en'", context);
  for (const layer of ['global', 'machine', 'campaign']) {
    press(context, 'rt-layer', { layer });
    const html = vm.runInContext('renderRouting()', context);
    assert.doesNotMatch(html, /\p{Script=Han}/u, layer);
    assert.match(html, /desk/);
  }
  // Editable global layer keeps catalog model ids as option values and shows labels.
  press(context, 'rt-layer', { layer: 'global' });
  const html = vm.runInContext('renderRouting()', context);
  assert.match(html, /value="cursor\/grok-4\.5"/);
  assert.match(html, /Grok 4\.5 Medium/);
});

test('settings offer visual implementation separately from all design work', async () => {
  const context = await pageContext();
  const html = vm.runInContext('renderRouting()', context);
  assert.match(html, /id="rt-route-visual"/);
  assert.match(html, /3D、材质、渲染、视觉裁决/);
  assert.match(html, /所有设计/);
});

test('settings offer a housekeeping route card', async () => {
  const context = await pageContext();
  const html = vm.runInContext('renderRouting()', context);
  assert.match(html, /id="rt-route-housekeeping"/);
  assert.match(html, /杂务会话/);
});
