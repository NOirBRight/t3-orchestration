import { esc, icon } from './icons.js';
import { cardTitle, blocks, ownerCount, noticeState, formatUtc8 } from './kanban-model.js';

// 进度 tab 里看板的 HTML 片段（卡片、chip、提示条、抽屉），不碰 DOM，便于单测。
// tr 是调用方传入的翻译函数（单测直接给 translate），不叫 t，免得和 state.js 的 t 混成同一个依赖。
// 状态色只给圆点和 chip 的浅底、描边用，颜色来自 style.css 的 --st-* 令牌。
export const dot = key => `var(--st-${key})`;

export function createView(tr) {
  const label = key => tr(`kb.s.${key}`);
  const versionLabel = value => (value ? `v${value}` : tr('kb.noVersion'));
  const machineLabel = value => value || tr('kb.noMachine');
  const chip = (cls, text, color) => `<span class="kb-chip${cls ? ` ${cls}` : ''}"${color ? ` style="--d:${color}"` : ''}><span class="kb-dot"></span>${esc(text)}</span>`;
  // 中性标签：无圆点，不是状态（缺 issue、编排侧）。
  const tag = (cls, text) => `<span class="kb-chip tag ${cls}">${esc(text)}</span>`;
  // 卡片和抽屉共用一排：状态、待你确认、被阻塞、状态不一致，再接中性标签。
  const chips = ticket => `${chip('', label(ticket.status), dot(ticket.status))}${ticket.needsOwner ? chip('owner', label('owner')) : ''}${ticket.blocked && ticket.status !== 'blocked' ? chip('blk', tr('kb.blockedBy')) : ''}`
    + `${ticket.conflict ? chip('warn', tr('kb.conflict')) : ''}${ticket.missingIssue ? tag('miss', tr('kb.missingIssue')) : ''}${ticket.orchestratorSide ? tag('side', tr('kb.side')) : ''}`;
  const card = ticket => {
    const meta = [machineLabel(ticket.machine), ticket.version ? `v${ticket.version}` : ''].filter(Boolean).join(' · ');
    return `<button class="kb-card" type="button" data-action="kb-open" data-id="${esc(ticket.id)}" title="${esc(cardTitle(ticket, tr('kb.idSep')))}"><div class="t"><span class="kb-id">${esc(ticket.id)}</span>${esc(tr('kb.idSep'))}${esc(ticket.title)}</div>`
      + `<div class="kb-row">${chips(ticket)}<span class="kb-meta">${esc(meta)}</span></div></button>`;
  };
  // 提示条：加载中占位不显示，高度不变；有待确认时点一下跳到收件箱里那一题。
  const notice = board => {
    if (!board) return `<button class="kb-notice pending" type="button" disabled aria-hidden="true"><span class="kb-n num">0</span><span>&nbsp;</span></button>`;
    const n = ownerCount(board.tickets), state = noticeState(n);
    return `<button class="kb-notice${state.tone === 'none' ? ' none' : ''}" type="button" data-action="kb-owner"${n ? '' : ' disabled'}><span class="kb-n num">${n}</span><span>${tr(state.key, `<b>${n}</b>`)}</span>${n ? `<span class="kb-go">${esc(tr('kb.goOwner'))}</span>` : ''}</button>`;
  };
  const conflicts = count => (count ? chip('warn kb-conflict', tr('kb.conflicts', count)) : '');
  const source = github => {
    if (!github) return '';
    const text = github.error === 'github-unavailable' ? (github.fetchedAt ? tr('kb.ghCached', formatUtc8(github.fetchedAt)) : tr('kb.ghOffline')) : github.error === 'no-repo' ? tr('kb.ghNone') : '';
    return text ? tag('source', text) : '';
  };
  const drawer = (ticket, tickets) => {
    const blocked = blocks(tickets, ticket.id), issue = ticket.issue;
    const issueText = issue ? `${issue.url ? `<a href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">#${esc(issue.number)} ↗</a>` : `#${esc(issue.number)}`}${[issue.state ? tr(issue.state === 'CLOSED' ? 'kb.issueClosed' : 'kb.issueOpen') : '', issue.milestone || (issue.state ? tr('kb.noMilestone') : '')].filter(Boolean).map(x => ` · ${esc(x)}`).join('')}` : '—';
    const meta = [ticket.id, machineLabel(ticket.machine), ticket.version ? `v${ticket.version}` : ''].filter(Boolean).join(' · ');
    const list = values => esc(values.join(tr('kb.listSep')) || tr('kb.none'));
    const owner = ticket.needsOwner ? `<div class="kb-sec"><h3>${esc(label('owner'))}</h3>${(ticket.ownerItems || []).map(item => `<button class="kb-goto" type="button" data-action="kb-goto" data-id="${esc(item.id)}"><span>${esc(item.id)} · ${esc(item.title)}</span>${icon('right', 16)}</button>`).join('')}</div>` : '';
    return `<aside class="kb-drawer" role="dialog" aria-modal="true" aria-labelledby="kb-dtitle"><div class="kb-d-h"><span class="kb-d-meta">${esc(meta)}</span>`
      + `<h2 id="kb-dtitle">${esc(cardTitle(ticket, tr('kb.idSep')))}</h2><div class="kb-row">${chips(ticket)}</div>`
      + `<button class="icon-button kb-x" id="kb-x" type="button" data-action="kb-close" aria-label="${esc(tr('kb.close'))}">${icon('x', 18)}</button></div>`
      + `<div class="kb-d-b" data-keep="kb-drawer">${owner}`
      + `<div class="kb-sec"><h3>${esc(tr('kb.summary'))}</h3><p>${esc(ticket.summary || tr('kb.noSummary'))}</p></div>`
      + `<div class="kb-sec"><h3>${esc(tr('kb.thread'))}</h3><dl class="kb-kv"><dt>${esc(tr('kb.threadState'))}</dt><dd>${esc(tr(`kb.ts.${ticket.threadState}`))}</dd><dt>${esc(tr('kb.stage'))}</dt><dd>${esc(ticket.stage || '—')}</dd><dt>${esc(tr('kb.branch'))}</dt><dd>${ticket.branch ? `<code>${esc(ticket.branch)}</code>` : '—'}</dd><dt>${esc(tr('kb.commit'))}</dt><dd>${ticket.commit ? `<code>${esc(ticket.commit)}</code>` : '—'}</dd><dt>${esc(tr('kb.issue'))}</dt><dd>${issueText}</dd></dl></div>`
      + `<div class="kb-sec"><h3>${esc(ticket.lastReportAt ? tr('kb.lastReportAt', formatUtc8(ticket.lastReportAt)) : tr('kb.lastReport'))}</h3><p>${esc(ticket.lastReport || tr('kb.noReport'))}</p></div>`
      + `<div class="kb-sec"><h3>${esc(tr('kb.deps'))}</h3><dl class="kb-kv"><dt>${esc(tr('kb.dependsOn'))}</dt><dd>${list(ticket.dependsOn || [])}</dd><dt>${esc(tr('kb.blocksOthers'))}</dt><dd>${list(blocked)}</dd>${ticket.blockedReason ? `<dt>${esc(tr('kb.reason'))}</dt><dd>${esc(ticket.blockedReason)}</dd>` : ''}</dl></div>`
      + `<p class="kb-ro">${esc(tr('kb.readonlyHint'))}</p></div></aside>`;
  };
  return { label, versionLabel, machineLabel, chips, card, notice, conflicts, source, drawer };
}
