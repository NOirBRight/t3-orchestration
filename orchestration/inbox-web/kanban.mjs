import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { atomicJson, readJson } from './config.mjs';
import { STATUS } from './public/kanban-model.js';

// 只读工单看板：Campaign 数据叠加 GitHub issue；GitHub 为准，失败回退缓存。
export const STATUS_KEYS = STATUS;
const FINISHED = new Set(['merged', 'closed', 'delivered']);
const DELIVERABLE_KINDS = new Set(['交付', '代码', '设计']);
const DELIVERABLE_ROUTES = new Set(['code', 'design']);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const ISSUE_FIELDS = 'number,title,state,milestone,labels,assignees,updatedAt,closedAt,body,url';
export const ISSUE_LIMIT = 2000;
const CACHE_MAX_AGE = 5 * 60 * 1000;
const RETRY_AFTER = 60 * 1000;
const REPORT_MAX = 280;

// STATE.md 的 stage 枚举（含旧式自由文本）→ 9 个状态列。顺序即优先级。
const STAGE_RULES = [
  [/^卡住[：:]?\s*/, 'blocked', 'rest'],
  [/^等你决定/, 'blocked', 'stage'],
  [/^等你来讨论/, 'blocked', 'stage'],
  [/^(已合并|已合入|已合主线)/, 'merged'],
  [/^(已关闭|移出范围)/, 'closed'],
  [/^待合并/, 'merge'],
  [/^待核实/, 'verify'],
  [/^已交付/, 'delivered'],
  [/^返修/, 'rework'],
  [/^执行中/, 'running'],
  [/^未开始/, 'queued'],
];
const STATUS_FIELD = { closed: 'closed', done: 'closed', merged: 'merged' };

export function stageStatus(stage, ticket = {}) {
  const text = typeof stage === 'string' ? stage.trim() : '';
  for (const [pattern, status, reason] of STAGE_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    // 旧式“已交付（待合并 HK-47）”这类附注仍按附注归列。
    if (status === 'delivered' && /待合并/.test(text)) return { status: 'merge', reason: '' };
    if (status === 'delivered' && /待核实/.test(text)) return { status: 'verify', reason: '' };
    if (status === 'delivered' && text === '已交付') {
      if (ticket.mergeRequest) return { status: 'merge', reason: '' };
      if ((ticket.deviceAcceptancePending || (typeof ticket.acceptance === 'string' && ticket.acceptance.trim())) && !ticket.acceptanceResult) return { status: 'verify', reason: '' };
    }
    return { status, reason: reason === 'rest' ? text.slice(match[0].length).trim() : reason === 'stage' ? text : '' };
  }
  const fallback = STATUS_FIELD[String(ticket.status || '').toLowerCase()];
  return { status: fallback || 'queued', reason: '' };
}

function findVersion(text, versions) {
  let best = null;
  for (const version of versions) {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?<![\\d.]|\\d\\.)${escaped}(?!\\d|\\.\\d)`).exec(text);
    if (match && (!best || match.index < best.index)) best = { version, index: match.index };
  }
  return best?.version ?? null;
}

export function parseTicketDoc(text, { milestones = [] } = {}) {
  const lines = String(text).split(/\r?\n/);
  const headingIndex = lines.findIndex(line => /^#\s+/.test(line));
  const title = headingIndex >= 0 ? lines[headingIndex].replace(/^#\s+/, '').replace(/^[A-Za-z]+-?\d+\s*[：:]\s*/, '').trim() : '';
  let summary = lines.map(line => /^说明[：:]\s*(.+)$/.exec(line.trim())?.[1]).find(Boolean) || '';
  if (!summary) {
    const paragraphs = lines.slice(headingIndex + 1).join('\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const first = paragraphs.find(p => !/^(#|-|\*|>|\||```)/.test(p));
    summary = first ? first.split(/\r?\n/).map(x => x.trim()).join(' ') : '';
  }
  return { title, summary, version: findVersion(String(text), milestones) };
}

const labelName = label => (typeof label === 'string' ? label : label?.name) || '';
export function issueMarkers(issue, campaignId) {
  const marks = [];
  for (const label of issue.labels || []) {
    const match = /^v\d+:([A-Za-z]+-?\d+)$/.exec(labelName(label));
    if (match) marks.push(match[1]);
  }
  for (const match of String(issue.body || '').matchAll(/^\s*Campaign:\s*(\S+?)\/([A-Za-z]+-?\d+)\s*$/gm)) {
    if (match[1] === campaignId) marks.push(match[2]);
  }
  return [...new Set(marks)];
}

function issueNumber(value) {
  const match = /^#?(\d+)$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
}

// 顺序：ticket.issue 字段 → issue 的 v4:P 标签 → 正文 Campaign 行。不认裸 P 号。
export function linkIssues(tickets, issues) {
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const byLabel = new Map(), byBody = new Map();
  for (const issue of issues) {
    const labelled = issueMarkers({ labels: issue.labels }, null);
    for (const id of labelled) if (!byLabel.has(id)) byLabel.set(id, issue);
    for (const id of issue.marks || []) if (!labelled.includes(id) && !byBody.has(id)) byBody.set(id, issue);
  }
  const links = new Map();
  for (const ticket of tickets) {
    const id = String(ticket.ticket), number = issueNumber(ticket.issue);
    if (number !== null) links.set(id, byNumber.get(number) || { number, missing: true });
    else if (byLabel.has(id)) links.set(id, byLabel.get(id));
    else if (byBody.has(id)) links.set(id, byBody.get(id));
  }
  return links;
}

export function parseEvents(text) {
  const events = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const time = Date.parse(fields[0]), ticket = fields[1].trim();
    if (!Number.isFinite(time) || !ticket) continue;
    const previous = events.get(ticket);
    if (previous && Date.parse(previous.at) > time) continue;
    events.set(ticket, { at: new Date(time).toISOString(), text: fields[2].trim() });
  }
  return events;
}

function tail(file, bytes) {
  let handle;
  try { handle = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  try {
    const size = fs.fstatSync(handle).size, start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(handle); }
}

export function readKanbanSources(dir, { eventsTailBytes = 256 * 1024, docMaxBytes = 256 * 1024 } = {}) {
  const campaign = readJson(path.join(dir, 'campaign.json'), {});
  if (!Array.isArray(campaign.tickets)) campaign.tickets = [];
  const inbox = readJson(path.join(dir, 'inbox.json'), {});
  if (!Array.isArray(inbox.items)) inbox.items = [];
  const milestones = Object.keys(campaign.milestones || {});
  const docs = new Map(), ticketsDir = path.join(dir, 'tickets');
  let entries = [];
  try { entries = fs.readdirSync(ticketsDir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    // *.bak-* 等备份不是现行票面；符号链接不跟。
    const match = /^([A-Za-z0-9_-]+)\.md$/.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const file = path.join(ticketsDir, entry.name);
    if (fs.statSync(file).size > docMaxBytes) continue;
    docs.set(match[1], parseTicketDoc(fs.readFileSync(file, 'utf8'), { milestones }));
  }
  return { campaign, inbox, events: parseEvents(tail(path.join(dir, 'events.log'), eventsTailBytes)), docs };
}

export function githubRepo(campaign = {}) {
  if (typeof campaign.github === 'string') return REPO.test(campaign.github.trim()) ? campaign.github.trim() : null;
  const project = String(campaign.project || '');
  const match = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(project) || /\bclone of ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(project);
  return match ? match[1].replace(/\.git$/, '').replace(/\.+$/, '') : null;
}

const normalizeRepoName = name => String(name).split('/').pop().toLowerCase().replace(/-v\d+$/, '').replace(/[^a-z0-9]/g, '');
function versionOfMilestone(title, versions) {
  if (!title) return null;
  return findVersion(title, versions) || /\b\d+\.\d+(?:\.\d+)?\b/.exec(title)?.[0] || null;
}
function threadState(status, ticket, waitingOwner) {
  if (status === 'running' || status === 'rework') return ticket.thread ? 'running' : 'notStarted';
  if (status === 'queued') return 'notStarted';
  if (status === 'blocked') return waitingOwner ? 'waiting' : 'suspended';
  if (status === 'verify') return 'waiting';
  if (status === 'delivered' || status === 'merge') return 'idle';
  return 'ended';
}
const shortSha = value => (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 7) : value || null);
const sameTicket = (a, b) => String(a).replace(/^#/, '') === String(b).replace(/^#/, '');

export function buildBoard({ campaignId, title = campaignId, machine = '', campaign, inbox, events, docs, github, now = Date.now }) {
  const tickets = campaign.tickets.filter(t => t && t.ticket !== undefined);
  const versions = Object.keys(campaign.milestones || {});
  const ids = new Set(tickets.map(t => String(t.ticket)));
  const knownMachines = tickets.map(t => t.machine).filter(Boolean);
  const localMachine = knownMachines.find(name => name.toLowerCase() === String(machine).toLowerCase()) || machine || null;
  // 成功拉取（哪怕为空）或有缓存才算有 GitHub 数据；否则不标冲突和缺 issue。
  const haveGithub = github.error == null || github.issues.length > 0;
  const links = linkIssues(tickets, github.issues);
  const openItems = (inbox.items || []).filter(item => item.status === 'open');
  const sharing = new Map();
  for (const link of links.values()) sharing.set(link.number, (sharing.get(link.number) || 0) + 1);
  const rows = tickets.map(ticket => {
    const id = String(ticket.ticket), doc = docs.get(id) || {};
    const { status, reason } = stageStatus(ticket.stage, ticket);
    const blockers = Array.isArray(ticket.blockedBy) ? ticket.blockedBy.map(String) : [];
    const dependsOn = blockers.filter(x => ids.has(x) && x !== id);
    const freeBlockers = blockers.filter(x => !ids.has(x));
    const ownerItems = openItems.filter(item => sameTicket(item.ticket, id)).map(item => ({ id: item.id, title: item.title || '' }));
    const link = links.get(id);
    const issue = link ? {
      number: link.number,
      title: link.missing ? null : link.title,
      state: link.missing ? null : link.state,
      url: link.missing ? (github.repo ? `https://github.com/${github.repo}/issues/${link.number}` : null) : link.url,
      milestone: link.milestone?.title || null,
      labels: (link.labels || []).map(labelName).filter(Boolean),
      assignees: (link.assignees || []).map(a => a?.login).filter(Boolean),
    } : null;
    const milestoneVersion = versionOfMilestone(issue?.milestone, versions);
    const specVersion = ticket.milestone || doc.version || null;
    let conflict = null;
    if (issue?.state === 'CLOSED' && !['merged', 'closed'].includes(status)) conflict = 'issueClosed';
    else if (issue?.state === 'OPEN' && ['merged', 'closed'].includes(status)) conflict = 'issueOpen';
    const deliverable = DELIVERABLE_KINDS.has(ticket.kind) || DELIVERABLE_ROUTES.has(ticket.routeType);
    const inRepo = !ticket.repo || !github.repo || normalizeRepoName(ticket.repo) === normalizeRepoName(github.repo);
    const event = events.get(id);
    const withoutId = text => String(text || '').replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`), '').trim();
    // 标题以 GitHub 为准；一个 issue 对应多张票时各票保留自己的标题。
    const githubTitle = issue?.title && sharing.get(issue.number) === 1 ? withoutId(issue.title) : '';
    return {
      id,
      title: githubTitle || withoutId(ticket.title) || doc.title || '',
      summary: doc.summary || '',
      kind: ticket.kind || null,
      stage: typeof ticket.stage === 'string' ? ticket.stage : '',
      version: milestoneVersion || specVersion,
      versionSource: milestoneVersion ? 'milestone' : specVersion ? 'spec' : null,
      machine: ticket.machine || localMachine,
      status,
      needsOwner: ownerItems.length > 0,
      ownerItems,
      blockedReason: [reason, ...freeBlockers].filter(Boolean).join('；'),
      dependsOn,
      threadState: threadState(status, ticket, /^等你/.test(ticket.stage || '')),
      branch: ticket.branch || null,
      commit: shortSha(ticket.candidate || ticket.commit || ticket.mergeCommit || ticket.mergeSha),
      lastReport: event ? (event.text.length > REPORT_MAX ? `${event.text.slice(0, REPORT_MAX)}…` : event.text) : null,
      lastReportAt: event?.at || null,
      updatedAt: ticket.since || null,
      issue,
      conflict: haveGithub ? conflict : null,
      orchestratorSide: !issue,
      missingIssue: haveGithub && !issue && deliverable && inRepo && !['merged', 'closed'].includes(status),
    };
  });
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) row.blocked = row.status === 'blocked' || row.dependsOn.some(dep => !FINISHED.has(byId.get(dep)?.status));
  return {
    campaign: { id: campaignId, title },
    generatedAt: new Date(now()).toISOString(),
    github: { repo: github.repo ?? null, fetchedAt: github.fetchedAt ?? null, stale: !!github.stale, error: github.error ?? null },
    ownerCount: rows.filter(row => row.needsOwner).length,
    conflictCount: rows.filter(row => row.conflict).length,
    tickets: rows,
  };
}

function runGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 20000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}
function normalizeIssue(issue, campaignId) {
  return {
    number: issue.number,
    title: String(issue.title || ''),
    state: String(issue.state || '').toUpperCase(),
    milestone: issue.milestone?.title ? { title: issue.milestone.title } : null,
    labels: (issue.labels || []).map(label => ({ name: labelName(label) })).filter(label => label.name),
    assignees: (issue.assignees || []).map(a => ({ login: a?.login })).filter(a => a.login),
    updatedAt: issue.updatedAt || null,
    closedAt: issue.closedAt || null,
    url: issue.url || null,
    marks: issueMarkers(issue, campaignId),
  };
}

const inflight = new Map(), failures = new Map();
// gh 只读拉取（issue list 自带分页到 --limit），正文只用来提取 Campaign 行，不进缓存。
export async function loadIssues({ repo, campaignId, cacheFile, run = runGh, now = Date.now, maxAge = CACHE_MAX_AGE }) {
  if (!repo) return { repo: null, issues: [], fetchedAt: null, stale: false, error: 'no-repo' };
  const cache = readJson(cacheFile, null);
  const cached = cache?.repo === repo && Array.isArray(cache.issues) ? cache : null;
  const fallback = () => ({ repo, issues: cached?.issues || [], fetchedAt: cached?.fetchedAt || null, stale: true, error: 'github-unavailable' });
  if (cached && now() - Date.parse(cached.fetchedAt) < maxAge) return { repo, issues: cached.issues, fetchedAt: cached.fetchedAt, stale: false, error: null };
  if (now() - (failures.get(cacheFile) || -Infinity) < RETRY_AFTER) return fallback();
  if (!inflight.has(cacheFile)) {
    const args = ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', String(ISSUE_LIMIT), '--json', ISSUE_FIELDS];
    inflight.set(cacheFile, (async () => {
      try {
        const parsed = JSON.parse(await run(args));
        if (!Array.isArray(parsed)) throw new Error('unexpected gh output');
        const fresh = { repo, fetchedAt: new Date(now()).toISOString(), issues: parsed.map(issue => normalizeIssue(issue, campaignId)) };
        atomicJson(cacheFile, fresh);
        failures.delete(cacheFile);
        return { ...fresh, stale: false, error: null };
      } catch {
        failures.set(cacheFile, now());
        return null;
      } finally { inflight.delete(cacheFile); }
    })());
  }
  return (await inflight.get(cacheFile)) || fallback();
}

export function shortTitle(title, id) {
  const head = String(title || '').split(/\s+on\s+|[：:(（]/)[0].trim();
  return head || id;
}

export async function kanbanView({ config, campaignId, run, now = Date.now }) {
  const entry = config.campaigns.find(c => c.id === campaignId);
  const sources = readKanbanSources(entry.dir);
  const repo = githubRepo(sources.campaign);
  const cacheFile = path.join(config.rootDir, 'cache', 'kanban', `${encodeURIComponent(campaignId)}.json`);
  const github = await loadIssues({ repo, campaignId, cacheFile, run, now });
  return buildBoard({ campaignId, title: shortTitle(entry.title, campaignId), machine: config.name, ...sources, github, now });
}
