import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { loadConfig, saveConfig } from '../config.mjs';
import { Access } from '../access.mjs';
import { createInboxServer } from '../server.mjs';
import {
  STATUS_KEYS, stageStatus, parseTicketDoc, issueMarkers, linkIssues, parseEvents, buildBoard,
  readKanbanSources, githubRepo, loadIssues,
} from '../kanban.mjs';

function campaignDir(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-kanban-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'campaign');
  fs.mkdirSync(path.join(dir, 'tickets'), { recursive: true });
  return { home, dir };
}

test('stage 枚举和旧式自由文本映射到 9 个状态列', () => {
  assert.deepEqual(STATUS_KEYS, ['queued', 'running', 'blocked', 'verify', 'delivered', 'rework', 'merge', 'merged', 'closed']);
  const cases = [
    ['未开始', 'queued'],
    ['执行中', 'running'],
    ['返修', 'rework'],
    ['已交付', 'delivered'],
    ['已合并', 'merged'],
    ['已合入主线 v40', 'merged'],
    ['已合主线', 'merged'],
    ['已关闭', 'closed'],
    ['移出范围', 'closed'],
    ['等你来讨论', 'blocked'],
    ['等你决定 Q12', 'blocked'],
    ['卡住：等 P21 T1', 'blocked'],
    ['待核实', 'verify'],
    ['待合并', 'merge'],
    ['已交付，等主人验收', 'delivered'],
    ['已交付（待合并 HK-47）', 'merge'],
    ['已交付，待核实', 'verify'],
    ['', 'queued'],
    [undefined, 'queued'],
    ['某种没见过的写法', 'queued'],
  ];
  for (const [stage, status] of cases) assert.equal(stageStatus(stage).status, status, String(stage));
  assert.equal(stageStatus('卡住：等 P21 T1').reason, '等 P21 T1');
  assert.equal(stageStatus('等你决定 Q12').reason, '等你决定 Q12');
  assert.equal(stageStatus('执行中').reason, '');
});

test('已交付按字段细分为待合并、待核实；status 字段兜底', () => {
  assert.equal(stageStatus('已交付', { mergeRequest: 'HK-41' }).status, 'merge');
  assert.equal(stageStatus('已交付', { acceptance: 'A3 待主人过目' }).status, 'verify');
  assert.equal(stageStatus('已交付', { deviceAcceptancePending: true }).status, 'verify');
  assert.equal(stageStatus('已交付', { acceptance: 'A3', acceptanceResult: 'pass' }).status, 'delivered');
  assert.equal(stageStatus('已交付', { acceptance: '' }).status, 'delivered');
  assert.equal(stageStatus('已合并', { mergeRequest: 'HK-41' }).status, 'merged');
  assert.equal(stageStatus(undefined, { status: 'closed' }).status, 'closed');
  assert.equal(stageStatus(undefined, { status: 'done' }).status, 'closed');
  assert.equal(stageStatus(undefined, { status: 'merged' }).status, 'merged');
});

test('票面 Markdown：标题去掉票号，说明取首段，版本只认 Campaign 里程碑', () => {
  const text = '# P41：ADR 草稿入库\n草稿来源：V40-01\n\n说明：把编排侧 ADR 草稿写进 docs/adr/。\n\n- Route type: design\n- 规格：docs/specs/v4/0.4.0.md\n\n## 目标\n\n别的 0.4.2 内容\n';
  const doc = parseTicketDoc(text, { milestones: ['0.4.0', '0.4.1', '0.4.2'] });
  assert.equal(doc.title, 'ADR 草稿入库');
  assert.equal(doc.summary, '把编排侧 ADR 草稿写进 docs/adr/。');
  assert.equal(doc.version, '0.4.0');
  const plain = parseTicketDoc('# P9: Fix it\n\nFirst paragraph\nstill first.\n\nSecond.', { milestones: ['0.4.0'] });
  assert.equal(plain.title, 'Fix it');
  assert.equal(plain.summary, 'First paragraph still first.');
  assert.equal(plain.version, null);
  assert.equal(parseTicketDoc('Node 22.1.0 only', { milestones: ['0.4.0'] }).version, null);
});

test('issue↔P 只认显式标记：ticket.issue、v4:P 标签、Campaign 行；裸 P 号不算', () => {
  const issues = [
    { number: 600, title: 'A', state: 'OPEN', labels: [], marks: [] },
    { number: 455, title: 'V3 P9 旧票', state: 'OPEN', labels: [{ name: 'ready-for-agent' }], marks: [] },
    { number: 700, title: 'B', state: 'OPEN', labels: [{ name: 'v4:P42' }], marks: [] },
    { number: 701, title: 'C', state: 'CLOSED', labels: [], marks: ['P43', 'P44'] },
    { number: 702, title: 'D', state: 'OPEN', labels: [{ name: 'v4:P41' }], marks: [] },
  ];
  assert.deepEqual(issueMarkers({ labels: [{ name: 'v4:P42' }, { name: 'wayfinder:task' }], body: 'P9 修复\nCampaign: pm/P43\nCampaign: other/P50\n' }, 'pm'), ['P42', 'P43']);
  const tickets = [{ ticket: 'P41', issue: 600 }, { ticket: 'P42' }, { ticket: 'P43' }, { ticket: 'P44' }, { ticket: 'P9' }, { ticket: 'P45', issue: '#999' }];
  const links = linkIssues(tickets, issues);
  assert.equal(links.get('P41').number, 600, 'explicit field beats a label on another issue');
  assert.equal(links.get('P42').number, 700);
  assert.equal(links.get('P43').number, 701);
  assert.equal(links.get('P44').number, 701, 'one issue may back several P tickets');
  assert.equal(links.has('P9'), false, 'bare P numbers in V3 bodies are ignored');
  assert.deepEqual(links.get('P45'), { number: 999, missing: true }, 'issue field without fetched data still names the issue');
});

test('events.log 尾部：每张票取最新一条，忽略坏行', () => {
  const text = [
    'garbage line',
    '2026-10-29T10:00:00+08:00\tP41\t派发\t',
    '2026-10-29T12:20:22+08:00\tP41\t交付 abc\tdeliveries/P41/',
    '2026-10-29T11:00:00+08:00\tP42\t卡住',
  ].join('\n');
  const events = parseEvents(text);
  assert.equal(events.get('P41').text, '交付 abc');
  assert.equal(events.get('P41').at, '2026-10-29T04:20:22.000Z');
  assert.equal(events.get('P42').text, '卡住');
  assert.equal(events.has('garbage line'), false);
});

function sampleInput(overrides = {}) {
  return {
    campaignId: 'pm',
    machine: 'desk',
    campaign: {
      milestones: { '0.4.0': 'GB', '0.4.1': 'SFC', '0.4.2': 'PS1' },
      tickets: [
        { ticket: 'P21', title: '基础', kind: '代码', stage: '执行中', blockedBy: [], since: '2026-10-29T01:00:00Z', machine: 'DESK', thread: 't21', branch: 'ticket/P21', commit: '0123456789abcdef', issue: 600 },
        { ticket: 'P41', title: 'P41：ADR 入库', kind: '交付', stage: '卡住：等 P21 T1', blockedBy: ['P21'], since: '2026-10-29T02:00:00Z', issue: 601 },
        { ticket: 'P42', title: '已关的票', kind: '代码', stage: '执行中', blockedBy: ['P21', '0.4.0 定版'], since: '2026-10-29T02:00:00Z', issue: 602 },
        { ticket: 'P43', title: '合了但 issue 开着', kind: '代码', stage: '已合并', blockedBy: [], since: '2026-10-29T02:00:00Z', issue: 603 },
        { ticket: 'P44', title: '调研', kind: '调研', routeType: 'research', stage: '已交付', blockedBy: [], since: '2026-10-29T02:00:00Z' },
        { ticket: 'P45', title: '缺 issue 的交付票', kind: '交付', stage: '未开始', blockedBy: [], since: '2026-10-29T02:00:00Z' },
        { ticket: 'P46', title: '工具票', kind: '代码', repo: 'tools-repo', stage: '已交付', mergeRequest: 'HK-1', blockedBy: [], since: '2026-10-29T02:00:00Z' },
        { ticket: 'P47', title: '早已关闭的交付票', kind: '交付', stage: '已关闭', blockedBy: [], since: '2026-10-20T02:00:00Z' },
        { ticket: 'P48', title: '和 P43 共用 issue', kind: '代码', stage: '执行中', blockedBy: [], since: '2026-10-29T02:00:00Z', issue: 603 },
      ],
    },
    inbox: { items: [
      { id: 'Q1', ticket: 'P41', status: 'open', title: '选 A 还是 B' },
      { id: 'Q2', ticket: 'P41', status: 'open', title: '第二题' },
      { id: 'Q3', ticket: 'P42', status: 'saved', title: '已答' },
      { id: 'Q4', ticket: 'P43', status: 'closed', title: '已结' },
      { id: 'Q5', ticket: 'P99', status: 'open', title: '不在票表里的题' },
    ], messages: [] },
    events: parseEvents('2026-10-29T12:00:00+08:00\tP21\t合并策略完成\t\n'),
    docs: new Map([['P41', { title: 'ADR 入库', summary: '把草稿写进 docs/adr/。', version: '0.4.1' }], ['P45', { title: '', summary: '', version: '0.4.2' }]]),
    github: {
      repo: 'owner/demo-app',
      fetchedAt: '2026-10-29T04:00:00.000Z',
      stale: false,
      issues: [
        { number: 600, title: 'Base', state: 'OPEN', milestone: { title: '0.4.0 GB 平台' }, labels: [{ name: 'ready-for-agent' }], assignees: [{ login: 'bot' }], url: 'https://github.com/owner/demo-app/issues/600', marks: [] },
        { number: 601, title: 'P41：GitHub 上的标题', state: 'OPEN', milestone: null, labels: [], assignees: [], url: 'u601', marks: [] },
        { number: 602, title: 'Closed', state: 'CLOSED', milestone: { title: '0.4.1 SFC 公开可玩' }, labels: [], assignees: [], url: 'u602', marks: [] },
        { number: 603, title: 'Open', state: 'OPEN', milestone: null, labels: [], assignees: [], url: 'u603', marks: [] },
      ],
    },
    ...overrides,
  };
}

test('看板模型：字段映射、待你确认计数、依赖推导', () => {
  const board = buildBoard(sampleInput());
  const by = Object.fromEntries(board.tickets.map(x => [x.id, x]));
  assert.equal(board.tickets.length, 9);
  assert.equal(by.P41.title, 'GitHub 上的标题', 'GitHub title wins, without a duplicated id');
  assert.equal(by.P21.title, 'Base');
  assert.equal(by.P43.title, '合了但 issue 开着', 'an issue shared by several tickets keeps each Campaign title');
  assert.equal(by.P48.title, '和 P43 共用 issue');
  assert.equal(by.P45.title, '缺 issue 的交付票', 'no issue: Campaign title');
  assert.equal(by.P41.summary, '把草稿写进 docs/adr/。');
  assert.equal(by.P41.status, 'blocked');
  assert.equal(by.P41.blockedReason, '等 P21 T1');
  assert.deepEqual(by.P41.dependsOn, ['P21']);
  assert.equal(by.P41.needsOwner, true);
  assert.deepEqual(by.P41.ownerItems.map(x => x.id), ['Q1', 'Q2']);
  assert.equal(by.P42.needsOwner, false, 'answered (saved) items no longer wait for the owner');
  assert.equal(board.ownerCount, 1, 'notice counts tickets that wait for the owner');
  assert.equal(by.P42.blocked, true, 'running ticket with an unfinished dependency is blocked');
  assert.match(by.P42.blockedReason, /0\.4\.0 定版/);
  assert.equal(by.P21.blocked, false);
  assert.equal(by.P21.commit, '0123456');
  assert.equal(by.P21.branch, 'ticket/P21');
  assert.equal(by.P21.machine, 'DESK');
  assert.equal(by.P41.machine, 'DESK', 'missing machine falls back to this Inbox machine, matching existing spelling');
  assert.equal(by.P21.threadState, 'running');
  assert.equal(by.P45.threadState, 'notStarted');
  assert.equal(by.P43.threadState, 'ended');
  assert.equal(by.P21.lastReport, '合并策略完成');
  assert.equal(by.P21.lastReportAt, '2026-10-29T04:00:00.000Z');
  assert.equal(by.P41.lastReport, null);
  assert.equal(by.P21.updatedAt, '2026-10-29T01:00:00Z');
  assert.equal(by.P46.status, 'merge');
  assert.ok(board.generatedAt);
});

test('GitHub 为准：版本先看 milestone，冲突两向标黄并汇总，无 issue 进编排侧', () => {
  const board = buildBoard(sampleInput());
  const by = Object.fromEntries(board.tickets.map(x => [x.id, x]));
  assert.equal(by.P21.version, '0.4.0'); assert.equal(by.P21.versionSource, 'milestone');
  assert.equal(by.P41.version, '0.4.1'); assert.equal(by.P41.versionSource, 'spec', 'no milestone: fall back to the ticket spec');
  assert.equal(by.P42.version, '0.4.1', 'milestone beats the spec');
  assert.equal(by.P44.version, null);
  assert.equal(by.P21.issue.number, 600);
  assert.deepEqual(by.P21.issue.labels, ['ready-for-agent']);
  assert.deepEqual(by.P21.issue.assignees, ['bot']);
  assert.equal(by.P42.conflict, 'issueClosed', 'issue closed but stage still running');
  assert.equal(by.P43.conflict, 'issueOpen', 'stage merged but issue still open');
  assert.equal(by.P21.conflict, null);
  assert.equal(board.conflictCount, 2);
  assert.equal(by.P44.orchestratorSide, true); assert.equal(by.P44.missingIssue, false, 'research needs no issue');
  assert.equal(by.P45.orchestratorSide, true); assert.equal(by.P45.missingIssue, true, 'deliverable without issue');
  assert.equal(by.P46.orchestratorSide, true); assert.equal(by.P46.missingIssue, false, 'other repo tickets are not tracked in this GitHub repo');
  assert.equal(by.P47.orchestratorSide, true); assert.equal(by.P47.missingIssue, false, 'finished history needs no new issue');
  assert.equal(by.P21.orchestratorSide, false);
  assert.deepEqual(board.github, { repo: 'owner/demo-app', fetchedAt: '2026-10-29T04:00:00.000Z', stale: false, error: null });
});

test('GitHub 不可用时降级：只用 Campaign 数据，不标冲突也不标缺 issue', () => {
  const board = buildBoard(sampleInput({ github: { repo: 'owner/demo-app', fetchedAt: null, stale: true, error: 'gh failed', issues: [] } }));
  const by = Object.fromEntries(board.tickets.map(x => [x.id, x]));
  assert.equal(by.P42.conflict, null);
  assert.equal(by.P45.missingIssue, false);
  assert.equal(by.P21.issue.number, 600, 'explicit issue number is still shown');
  assert.equal(by.P21.issue.state, null);
  assert.equal(by.P41.version, '0.4.1');
  assert.equal(by.P41.title, 'ADR 入库', 'without GitHub data the Campaign title stays');
  assert.equal(board.conflictCount, 0);
  assert.equal(board.github.error, 'gh failed');
});

test('GitHub 成功但没有 issue 也算真实数据：交付票标缺 issue', () => {
  const board = buildBoard(sampleInput({ github: { repo: 'owner/demo-app', fetchedAt: '2026-10-29T04:00:00.000Z', stale: false, error: null, issues: [] } }));
  const by = Object.fromEntries(board.tickets.map(x => [x.id, x]));
  assert.equal(by.P45.missingIssue, true);
  assert.equal(by.P21.issue.state, null, 'explicit issue not in the result stays a stub');
  const stale = buildBoard(sampleInput({ github: { ...sampleInput().github, stale: true, error: 'github-unavailable' } }));
  assert.equal(stale.tickets.find(x => x.id === 'P45').missingIssue, true, 'cached data still counts');
});

test('数据源：只读 campaign.json、inbox.json、events.log 尾部和 tickets/*.md，跳过 .bak', t => {
  const { dir } = campaignDir(t);
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ tickets: [{ ticket: 'P1', title: 'x', stage: '执行中' }], milestones: { '0.4.0': '' } }));
  fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify({ items: [{ id: 'Q1', ticket: 'P1', status: 'open' }] }));
  const filler = 'x'.repeat(200) + '\n';
  fs.writeFileSync(path.join(dir, 'events.log'), `2026-10-01T00:00:00Z\tP0\told\t\n${filler.repeat(2000)}2026-10-29T00:00:00Z\tP1\tnew\t\n`);
  fs.writeFileSync(path.join(dir, 'tickets', 'P1.md'), '# P1：现行\n\n说明：现行说明\n');
  fs.writeFileSync(path.join(dir, 'tickets', 'P1.md.bak-20261029'), '# P1：旧备份\n\n说明：旧\n');
  fs.writeFileSync(path.join(dir, 'tickets', 'P2.bak-1.md'), '# P2：备份\n');
  const sources = readKanbanSources(dir, { eventsTailBytes: 64 * 1024 });
  assert.equal(sources.campaign.tickets.length, 1);
  assert.equal(sources.inbox.items.length, 1);
  assert.equal(sources.events.get('P1').text, 'new');
  assert.equal(sources.events.has('P0'), false, 'only the tail is read');
  assert.equal(sources.docs.get('P1').title, '现行');
  assert.equal(sources.docs.has('P2'), false);
  assert.equal(sources.docs.size, 1);
  fs.rmSync(path.join(dir, 'inbox.json')); fs.rmSync(path.join(dir, 'events.log'));
  const bare = readKanbanSources(dir);
  assert.deepEqual(bare.inbox.items, []); assert.equal(bare.events.size, 0);
});

test('GitHub 仓库只认显式写法', () => {
  assert.equal(githubRepo({ github: 'Owner/repo' }), 'Owner/repo');
  assert.equal(githubRepo({ project: 'DemoApp-v4 (~/Workstation/DemoApp-v4/repo, clone of Owner/demo-app; mainline v40)' }), 'Owner/demo-app');
  assert.equal(githubRepo({ project: 'see https://github.com/a/b.git for code' }), 'a/b');
  assert.equal(githubRepo({ project: 'DemoApp-v4/repo placeholder' }), null);
  assert.equal(githubRepo({ github: 'not a repo; rm -rf' }), null);
  assert.equal(githubRepo({}), null);
});

test('gh 只读拉取、缓存不存正文；失败回退缓存并标数据时间', async t => {
  const { home } = campaignDir(t);
  const cacheFile = path.join(home, 'cache', 'pm.json');
  const calls = [];
  let now = Date.parse('2026-10-29T04:00:00Z');
  const ok = async args => {
    calls.push(args);
    return JSON.stringify([{ number: 1, title: 'T', state: 'OPEN', milestone: null, labels: [{ name: 'v4:P1' }], assignees: [], updatedAt: 'x', closedAt: null, url: 'u', body: 'secret-ish body\nCampaign: pm/P2' }]);
  };
  const first = await loadIssues({ repo: 'o/r', campaignId: 'pm', cacheFile, run: ok, now: () => now });
  assert.equal(first.stale, false); assert.equal(first.error, null);
  assert.equal(first.fetchedAt, '2026-10-29T04:00:00.000Z');
  assert.deepEqual(first.issues[0].marks, ['P1', 'P2']);
  assert.equal('body' in first.issues[0], false);
  assert.deepEqual(calls[0].slice(0, 2), ['issue', 'list']);
  assert.ok(calls[0].includes('--repo') && calls[0].includes('o/r'));
  assert.ok(calls[0].includes('--state') && calls[0].includes('all'));
  assert.ok(Number(calls[0][calls[0].indexOf('--limit') + 1]) > 400, 'pages past the default 400');
  assert.ok(!calls[0].some(arg => /^(create|edit|close|reopen|comment|delete|lock|transfer|api)$/.test(arg)), 'read-only gh call');
  assert.doesNotMatch(fs.readFileSync(cacheFile, 'utf8'), /secret-ish/);

  now += 60 * 1000;
  const cached = await loadIssues({ repo: 'o/r', campaignId: 'pm', cacheFile, run: ok, now: () => now });
  assert.equal(calls.length, 1, 'fresh cache is reused');
  assert.equal(cached.fetchedAt, first.fetchedAt);

  now += 60 * 60 * 1000;
  const failed = await loadIssues({ repo: 'o/r', campaignId: 'pm', cacheFile, run: async () => { throw new Error('gh: HTTP 502 token=abc'); }, now: () => now });
  assert.equal(failed.stale, true);
  assert.equal(failed.fetchedAt, '2026-10-29T04:00:00.000Z');
  assert.equal(failed.issues.length, 1);
  assert.equal(failed.error, 'github-unavailable', 'raw gh errors never reach the page');

  const none = await loadIssues({ repo: 'o/r', campaignId: 'pm', cacheFile: path.join(home, 'cache', 'none.json'), run: async () => { throw new Error('offline'); }, now: () => now });
  assert.deepEqual(none, { repo: 'o/r', issues: [], fetchedAt: null, stale: true, error: 'github-unavailable' });
  const noRepo = await loadIssues({ repo: null, campaignId: 'pm', cacheFile, run: ok, now: () => now });
  assert.equal(noRepo.error, 'no-repo'); assert.equal(calls.length, 1);
});

function serverSetup(t) {
  const { home, dir } = campaignDir(t);
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ project: 'x', milestones: { '0.4.0': '' }, tickets: [{ ticket: 'P1', title: '一号', kind: '代码', stage: '执行中', blockedBy: [], since: '2026-10-29T00:00:00Z' }] }));
  fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify({ items: [{ id: 'Q1', ticket: 'P1', status: 'open', title: 'q' }], messages: [] }));
  fs.writeFileSync(path.join(dir, 'events.log'), '2026-10-29T00:00:00Z\tP1\t开工\t\n');
  fs.writeFileSync(path.join(dir, 'tickets', 'P1.md'), '# P1：一号\n\n说明：说明\n');
  const config = loadConfig({ home });
  config.port = 0; config.remotePort = 0;
  config.campaigns = [{ id: 'demo', title: 'Demo', dir }];
  saveConfig(config);
  return { home, dir, config };
}
const digest = dir => Object.fromEntries(['campaign.json', 'inbox.json', 'events.log', 'tickets/P1.md'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));

test('GET /api/kanban 只读；未登录、中继令牌被拒；非 GET 一律 405', async t => {
  const { dir, config } = serverSetup(t);
  const server = await createInboxServer({ config, fetch: async () => new Response(null, { status: 200 }), relaySleep: async () => {}, kanbanGh: async () => { throw new Error('no network in tests'); } });
  await server.start(); t.after(() => server.stop());
  const before = digest(dir);
  const remote = `http://127.0.0.1:${server.health().remotePort}`;
  const cookie = `inbox_session=${new Access(config.privateDir).cookie()}`;

  const anonymous = await fetch(`${remote}/api/kanban/demo`);
  assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
  const page = await fetch(`${remote}/kanban.html`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 401, 'unauthenticated page request gets the login page'); await page.arrayBuffer();

  const ok = await fetch(`${remote}/api/kanban/demo`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const board = await ok.json();
  assert.equal(board.campaign.id, 'demo');
  assert.equal(board.tickets[0].id, 'P1');
  assert.equal(board.tickets[0].needsOwner, true);
  assert.equal(board.ownerCount, 1);
  assert.equal(board.github.error, 'no-repo');

  const missing = await fetch(`${remote}/api/kanban/nope`, { headers: { cookie } });
  assert.equal(missing.status, 404); await missing.arrayBuffer();

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${remote}/api/kanban/demo`, { method, headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET');
    await response.arrayBuffer();
  }
  const head = await fetch(`${remote}/api/kanban/demo`, { method: 'HEAD', headers: { cookie } });
  assert.equal(head.status, 405);

  const secrets = await server.admin('relay-set', { campaign: 'demo', bridgeUrl: 'http://127.0.0.1:9/b' });
  const relay = await fetch(`${remote}/api/kanban/demo`, { headers: { Authorization: `Bearer ${secrets.tokenId}.${secrets.inboundToken}` } });
  assert.equal(relay.status, 403, 'relay principal may not read the board'); await relay.arrayBuffer();
  const relayPage = await fetch(`${remote}/kanban.html`, { headers: { Authorization: `Bearer ${secrets.tokenId}.${secrets.inboundToken}` } });
  assert.equal(relayPage.status, 403); await relayPage.arrayBuffer();

  assert.deepEqual(digest(dir), before, 'Campaign files unchanged');
  assert.equal(fs.readdirSync(dir).some(name => /\.bak|\.tmp/.test(name)), false);
});
