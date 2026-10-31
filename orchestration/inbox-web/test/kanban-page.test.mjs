import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STATUS, COLUMNS, DEFAULT_COLUMNS, KEYS, readColumns, readFilters, matchesFilters, columnTickets, ownerCount,
  activeFilters, formatUtc8, cardTitle, filterOptions, blocks, noticeState,
} from '../public/kanban-model.js';
import { messages, translate } from '../public/i18n.js';
import { createView } from '../public/kanban-view.js';
import { STATUS_KEYS } from '../kanban.mjs';
import vm from 'node:vm';

const ticket = (id, status, extra = {}) => ({ id, title: `${id} 标题`, status, version: '0.4.1', machine: 'DESK', needsOwner: false, dependsOn: [], ...extra });
const board = [
  ticket('P1', 'running'),
  ticket('P2', 'verify', { needsOwner: true, version: '0.4.0' }),
  ticket('P3', 'blocked', { needsOwner: true, machine: 'LAB' }),
  ticket('P4', 'rework', { version: '0.4.2', dependsOn: ['P1'] }),
  ticket('P5', 'merged', { version: null }),
];
const emptyFilters = { status: [], version: [], machine: [], ownerOnly: false };

test('列：待你确认视图列 + 9 个状态列，默认 4 列', () => {
  assert.deepEqual(STATUS, ['queued', 'running', 'blocked', 'verify', 'delivered', 'rework', 'merge', 'merged', 'closed']);
  assert.deepEqual(COLUMNS, ['owner', ...STATUS]);
  assert.deepEqual(DEFAULT_COLUMNS, ['owner', 'running', 'blocked', 'rework']);
  assert.equal(STATUS_KEYS, STATUS, 'server and page share one status list');
  assert.deepEqual(KEYS, { columns: 'pmKanban.v2.columns', filters: 'pmKanban.v2.filters' }, 'theme follows the Inbox theme now');
});

test('持久化读取：非法或读取失败回退默认值', () => {
  assert.deepEqual(readColumns(null), DEFAULT_COLUMNS);
  assert.deepEqual(readColumns('not json'), DEFAULT_COLUMNS);
  assert.deepEqual(readColumns('{"a":1}'), DEFAULT_COLUMNS);
  assert.deepEqual(readColumns('["owner","bogus"]'), DEFAULT_COLUMNS);
  assert.deepEqual(readColumns('[]'), [], 'all columns hidden is a valid choice');
  assert.deepEqual(readColumns('["merged","owner"]'), ['owner', 'merged'], 'kept in board order');
  assert.deepEqual(readFilters(null), emptyFilters);
  assert.deepEqual(readFilters('[1]'), emptyFilters);
  assert.deepEqual(readFilters('{"status":"running"}'), emptyFilters);
  assert.deepEqual(readFilters('{"status":["bogus"],"version":[],"machine":[],"ownerOnly":false}'), emptyFilters);
  assert.deepEqual(readFilters('{"status":["running"],"version":["0.4.1"],"machine":["LAB"],"ownerOnly":true}'), { status: ['running'], version: ['0.4.1'], machine: ['LAB'], ownerOnly: true });
  assert.deepEqual(readFilters('{"status":[],"version":[3],"machine":[],"ownerOnly":false}'), emptyFilters);
  assert.deepEqual(readFilters('{"status":[],"version":[],"machine":[],"ownerOnly":"yes"}'), emptyFilters);
});

test('筛选：维度之间 AND，维度内 OR，空维度不限制', () => {
  const ids = filters => board.filter(x => matchesFilters(x, { ...emptyFilters, ...filters })).map(x => x.id);
  assert.deepEqual(ids({}), ['P1', 'P2', 'P3', 'P4', 'P5']);
  assert.deepEqual(ids({ status: ['running', 'rework'] }), ['P1', 'P4']);
  assert.deepEqual(ids({ status: ['running', 'blocked'], machine: ['LAB'] }), ['P3']);
  assert.deepEqual(ids({ version: ['0.4.0', '0.4.2'] }), ['P2', 'P4']);
  assert.deepEqual(ids({ version: [''] }), ['P5'], 'tickets without a version can be selected');
  assert.deepEqual(ids({ ownerOnly: true }), ['P2', 'P3']);
  assert.deepEqual(ids({ ownerOnly: true, status: ['verify'] }), ['P2']);
});

test('列内容：待你确认按 needsOwner 聚合，同一票也出现在状态列', () => {
  assert.deepEqual(columnTickets(board, 'owner').map(x => x.id), ['P2', 'P3']);
  assert.deepEqual(columnTickets(board, 'blocked').map(x => x.id), ['P3']);
  assert.deepEqual(columnTickets(board, 'queued'), []);
});

test('待确认计数不受筛选影响；筛选项计数含开关', () => {
  assert.equal(ownerCount(board), 2);
  assert.equal(activeFilters(emptyFilters), 0);
  assert.equal(activeFilters({ status: ['running', 'blocked'], version: ['0.4.1'], machine: [], ownerOnly: true }), 4);
});

test('卡片标题 id：说明，全角冒号；时间按 UTC+8', () => {
  assert.equal(cardTitle({ id: 'P41', title: 'ADR 入库' }), 'P41：ADR 入库');
  assert.equal(formatUtc8('2026-10-29T00:30:00Z'), '2026-10-29 08:30');
  assert.equal(formatUtc8('2026-10-28T23:15:00+08:00'), '2026-10-28 23:15');
  assert.equal(formatUtc8('2026-10-29T16:05:00Z'), '2026-10-30 00:05');
  assert.equal(formatUtc8(null), '');
  assert.equal(formatUtc8('bogus'), '');
});

test('筛选选项来自数据，版本排序，无版本放最后', () => {
  const options = filterOptions(board);
  assert.deepEqual(options.version, ['0.4.0', '0.4.1', '0.4.2', '']);
  assert.deepEqual(options.machine, ['DESK', 'LAB']);
});

test('被阻塞反向关系', () => {
  assert.deepEqual(blocks(board, 'P1'), ['P4']);
  assert.deepEqual(blocks(board, 'P4'), []);
});

test('旧看板链接转到 Inbox 的进度 tab，保留 Campaign 和机器', async () => {
  const html = await readFile(new URL('../public/kanban.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'inline redirect script');
  let target = null;
  const href = 'https://hub.test/ayaneo3/kanban.html?campaign=pocket%20v4&machine=ayaneo3';
  vm.runInNewContext(script, { URL, location: { href, replace: url => { target = String(url); } } });
  assert.equal(target, 'https://hub.test/ayaneo3/?campaign=pocket+v4&machine=ayaneo3&tab=progress');
  assert.match(html, /<a href="\.\/\?tab=progress">/, 'link fallback without scripts');
  assert.doesNotMatch(html, /kanban\.(css|js)/);
});

test('进度 tab 的看板只读：只发一个 GET，没有拖拽、编辑；卡片是 button，抽屉是 dialog，外链 noopener', async () => {
  const js = await readFile(new URL('../public/kanban.js', import.meta.url), 'utf8');
  assert.deepEqual([...js.matchAll(/\bapi\((.*?)\);/g)].map(m => m[1]), ['`api/kanban/${encodeURIComponent(campaign)}`'], 'one GET, no body');
  assert.doesNotMatch(js, /method|draggable|contenteditable/i, 'page never writes');
  const view = createView((key, ...values) => translate('zh', key, ...values));
  assert.match(view.card({ id: 'P1', title: 'x', status: 'queued', dependsOn: [] }), /^<button class="kb-card" type="button" data-action="kb-open" data-id="P1"/);
  const tickets = [
    { id: 'P1', title: '标题', status: 'running', needsOwner: true, ownerItems: [{ id: 'Q1', title: '选哪个' }], dependsOn: [], threadState: 'running', issue: { number: 4, state: 'OPEN', url: 'https://example.test/4' } },
    { id: 'P2', title: '下游', status: 'queued', dependsOn: ['P1'], threadState: 'notStarted' },
  ];
  const drawer = view.drawer(tickets[0], tickets);
  assert.match(drawer, /role="dialog" aria-modal="true" aria-labelledby="kb-dtitle"/);
  assert.match(drawer, /<button class="icon-button kb-x" id="kb-x" type="button" data-action="kb-close"/);
  assert.match(drawer, /data-action="kb-goto" data-id="Q1"/, 'owner items jump to the item inside this Inbox');
  assert.match(drawer, /<dt>阻塞了<\/dt><dd>P2<\/dd>/);
  for (const match of (drawer + js).matchAll(/target="_blank"[^>]*/g)) assert.match(match[0], /rel="noopener noreferrer"/);
  assert.equal([...drawer.matchAll(/class="kb-chip/g)].length, view.chips(tickets[0]).match(/class="kb-chip/g).length, 'drawer reuses the card chip row');
  assert.doesNotMatch(view.drawer({ ...tickets[0], issue: { number: 4 } }, tickets), /未挂 milestone/, '未挂 milestone only for issues fetched from GitHub');
  assert.match(view.drawer({ ...tickets[0], issue: { number: 4, state: 'CLOSED' } }, tickets), /已关 · 未挂 milestone/);
  assert.match(view.drawer({ ...tickets[1], dependsOn: ['P1', 'P3'] }, tickets), /P1、P3/, 'list separator is translated');
});

test('看板页的界面文字都在中英字典里', async () => {
  const js = (await readFile(new URL('../public/kanban.js', import.meta.url), 'utf8')) + (await readFile(new URL('../public/kanban-view.js', import.meta.url), 'utf8'));
  const keys = [...js.matchAll(/\btr?\('([^']+)'/g)].map(m => m[1]);
  assert.ok(keys.length > 20);
  for (const key of keys) assert.ok(messages[key], key);
});

test('返修视觉：提示条 N=0 中性“暂无待你确认”，N>0 强调色', () => {
  assert.deepEqual(noticeState(0), { tone: 'none', key: 'kb.noticeNone' });
  assert.deepEqual(noticeState(3), { tone: 'accent', key: 'kb.notice' });
  assert.equal(messages['kb.noticeNone'][0], '暂无待你确认');
});

test('返修视觉：卡片完整标题进 title；缺 issue/编排侧是无圆点中性标签，不像状态；状态不一致仍是黄点 chip', () => {
  const view = createView((key, ...values) => translate('zh', key, ...values));
  const html = view.card({ id: 'P9', title: '很长的标题 <b>不能注入</b>', status: 'queued', version: '0.4.1', machine: 'DESK', needsOwner: false, blocked: false, dependsOn: [], conflict: 'issueClosed', missingIssue: true, orchestratorSide: true });
  assert.match(html, /title="P9：很长的标题 &lt;b&gt;不能注入&lt;\/b&gt;"/);
  assert.doesNotMatch(html, /<b>不能注入/);
  const spans = [...html.matchAll(/<span class="kb-chip([^"]*)"[^>]*>(.*?)<\/span>(?=<span class="kb-chip|<span class="kb-meta")/g)].map(m => ({ cls: m[1].trim(), dotted: m[2].includes('class="kb-dot"'), text: m[2].replace(/<[^>]+>/g, '') }));
  assert.deepEqual(spans.map(x => [x.cls, x.dotted, x.text]), [
    ['', true, '排队'],
    ['warn', true, '状态不一致'],
    ['tag miss', false, '缺 issue'],
    ['tag side', false, '编排侧'],
  ]);
  assert.equal(html.slice(html.indexOf('tag miss')).includes('style='), false, 'tags carry no status colour');
  const plain = view.chips({ id: 'P1', status: 'running', dependsOn: [] });
  assert.doesNotMatch(plain, /tag/, 'tags only appear when flagged');
});

test('返修视觉（并入进度 tab 后保持）：标题两行截断；中性标签与排队可区分；提示条 N=0 中性且高度不变；冲突数独立 chip；快照不换行', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const rule = selector => css.match(new RegExp(`(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] || '';
  for (const property of ['display:-webkit-box', '-webkit-line-clamp:2', '-webkit-box-orient:vertical', 'overflow:hidden']) assert.ok(rule('.kb-card .t').includes(property), property);
  assert.doesNotMatch(rule('.kb-chip.tag'), /--d/, 'neutral tags have no status colour');
  assert.match(rule('.kb-chip.tag'), /background:transparent/);
  assert.match(rule('.kb-chip.tag.side'), /dashed/, '编排侧 differs from 排队 and from 缺 issue');
  assert.doesNotMatch(css, /\[data-theme="dark"\][^{]*\.kb-/, 'the board uses theme tokens, so dark mode needs no override');
  assert.match(rule('.kb-notice'), /min-height:var\(--tap\)/, 'same height with or without the badge');
  assert.match(rule('.kb-notice.none'), /background:var\(--field\)/);
  assert.match(rule('.kb-notice.none .kb-n'), /display:none/);
  assert.match(rule('.kb-notice.pending'), /visibility:hidden/, 'notice keeps its space while loading');
  assert.match(rule('.kb-stamp'), /white-space:nowrap/);
  assert.match(rule('.kb-stamp'), /text-overflow:ellipsis/);
  assert.doesNotMatch(css, /\.kb-fab|\.fab\b/, 'no floating filter button over the bottom navigation');

  const view = createView((key, ...values) => translate('zh', key, ...values));
  assert.match(view.notice(null), /^<button class="kb-notice pending"[^>]*disabled/);
  assert.match(view.notice({ tickets: [] }), /class="kb-notice none"[\s\S]*暂无待你确认/);
  assert.match(view.notice({ tickets: [{ needsOwner: true }, { needsOwner: true }] }), /class="kb-notice"[\s\S]*<span class="kb-n num">2<\/span>[\s\S]*有 <b>2<\/b> 条待你确认/);
  assert.equal(view.conflicts(0), '');
  assert.match(view.conflicts(3), /^<span class="kb-chip warn kb-conflict"><span class="kb-dot"><\/span>3 条状态不一致<\/span>$/, 'conflict count is its own yellow-dot chip');
});
