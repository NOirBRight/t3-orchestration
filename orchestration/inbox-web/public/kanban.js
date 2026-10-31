import { state, t } from './state.js';
import { esc, icon } from './icons.js';
import { api } from './api.js';
import { overlay } from './ui.js';
import { render } from './render.js';
import { STATUS, COLUMNS, DEFAULT_COLUMNS, KEYS, emptyFilters, matchesFilters, columnTickets, activeFilters, filterOptions, formatUtc8 } from './kanban-model.js';
import { dot, createView } from './kanban-view.js';

// “进度”tab 就是只读工单看板（P107 规范 v2，P109 并进 Inbox）：只发一个 GET，没有拖拽、编辑或状态变更。
// 筛选和列的持久化沿用 pmKanban.v2.* 键；主题、语言跟 Inbox 走。
const view = createView(t);
function saveKanban() {
  try { localStorage.setItem(KEYS.columns, JSON.stringify(state.kanban.columns)); localStorage.setItem(KEYS.filters, JSON.stringify(state.kanban.filters)); }
  catch { /* 存不了就只在本页生效 */ }
}

export async function loadKanban() {
  const board = state.kanban, campaign = state.campaign, sequence = ++board.sequence;
  if (!campaign) return;
  try {
    const result = await api(`api/kanban/${encodeURIComponent(campaign)}`);
    if (sequence !== board.sequence || campaign !== state.campaign) return;
    board.board = result; board.error = null;
    // 抽屉里的票刷新后不在了就关掉抽屉。
    if (!openTicket()) board.drawer = null;
  } catch (error) {
    if (sequence !== board.sequence || campaign !== state.campaign) return;
    if (!board.board) board.error = error.message;
  }
  if (boardShown()) render();
}
// 看板只在进度 tab、且不在派票设置页时显示。
export const boardShown = () => state.tab === 'progress' && state.view !== 'routing';
// 抽屉只在它指向的票还在看板里时才算开着；渲染和上锁都用这一个判断。
const openTicket = () => (state.kanban.drawer && state.kanban.board?.tickets.find(item => item.id === state.kanban.drawer)) || null;
// 筛选面板或抽屉开着时是模态：背后整页 inert，键盘只能在对话框里走。
export const kanbanModal = () => boardShown() && (state.kanban.sheet || !!openTicket());
// 换 Campaign 时清掉上一个的看板和浮层。
export function resetKanban() { Object.assign(state.kanban, { board: null, error: null, pop: null, sheet: false, drawer: null }); state.kanban.sequence++; }

// 四个下拉：状态、版本、机器是筛选，列是显隐；各自的选项、读写和底部按钮放在一处。
const MENUS = {
  status: { label: 'kb.status', items: () => STATUS.map(key => [key, view.label(key), dot(key)]), get: () => state.kanban.filters.status, set: values => { state.kanban.filters.status = values; } },
  version: { label: 'kb.version', items: () => filterOptions(state.kanban.board?.tickets || []).version.map(value => [value, view.versionLabel(value)]), get: () => state.kanban.filters.version, set: values => { state.kanban.filters.version = values; } },
  machine: { label: 'kb.machine', items: () => filterOptions(state.kanban.board?.tickets || []).machine.map(value => [value, view.machineLabel(value)]), get: () => state.kanban.filters.machine, set: values => { state.kanban.filters.machine = values; } },
  columns: { label: 'kb.columns', items: () => COLUMNS.map(key => [key, view.label(key), dot(key)]), get: () => state.kanban.columns, set: values => { state.kanban.columns = COLUMNS.filter(key => values.includes(key)); }, all: 'kb.showAll', none: ['kb-reset', 'kb.resetCols'], count: () => `${state.kanban.columns.length}/${COLUMNS.length}`, plain: true },
};
function setSelected(id, values) { MENUS[id].set(values); saveKanban(); }
function pop(id) {
  const menu = MENUS[id], open = state.kanban.pop === id, values = menu.get(), [noneAction, noneLabel] = menu.none || ['kb-none', 'kb.selectNone'];
  return `<div class="kb-pop${open ? ' open' : ''}"><button class="kb-btn${!menu.plain && values.length ? ' on' : ''}" type="button" data-action="kb-pop" data-pop="${id}" aria-expanded="${open}">${esc(t(menu.label))}<span class="c num">${menu.count ? menu.count() : values.length || ''}</span>${icon('down', 14)}</button>`
    + `<div class="kb-menu${menu.plain ? ' right' : ''}" role="group" aria-label="${esc(t(menu.label))}">${menu.items().map(([value, text, color]) => `<label><input type="checkbox" data-kb-field="${id}" value="${esc(value)}"${values.includes(value) ? ' checked' : ''}>${color ? `<span class="kb-dot" style="--d:${color}"></span>` : ''}<span>${esc(text)}</span></label>`).join('')}`
    + `<div class="kb-ft"><button type="button" data-action="kb-all" data-pop="${id}">${t(menu.all || 'kb.selectAll')}</button><button type="button" data-action="${noneAction}" data-pop="${id}">${t(noneLabel)}</button></div></div></div>`;
}
function toolbar(lock) {
  const { filters, sheet } = state.kanban;
  return `<div class="kb-bar${sheet ? ' on' : ''}"${sheet ? ` role="dialog" aria-modal="true" aria-label="${esc(t('kb.sheet'))}"` : ''}${lock}><div class="kb-sheet-h"><b>${esc(t('kb.sheet'))}</b><button class="icon-button" id="kb-sheet-x" type="button" data-action="kb-close" aria-label="${esc(t('kb.close'))}">${icon('x', 18)}</button></div>`
    + `${pop('status')}${pop('version')}${pop('machine')}`
    + `<button class="kb-btn" type="button" data-action="kb-owner-only" aria-pressed="${filters.ownerOnly}"><span class="kb-sw"></span>${t('kb.ownerOnly')}</button><span class="spacer"></span>`
    + `<button class="kb-btn" type="button" data-action="kb-clear">${t('kb.clear')}</button><span class="kb-sep"></span>${pop('columns')}</div>`;
}
function columnsHtml(board) {
  const { filters, columns } = state.kanban, list = board.tickets.filter(ticket => matchesFilters(ticket, filters));
  const visible = COLUMNS.filter(key => columns.includes(key));
  if (!visible.length) return `<div class="kb-allhidden">${esc(t('kb.allHidden'))}</div>`;
  return visible.map(key => {
    const items = columnTickets(list, key);
    return `<section class="kb-col" aria-label="${esc(view.label(key))}"><div class="kb-col-h"><span class="kb-dot" style="--d:${dot(key)}"></span>${esc(view.label(key))}<span class="n num">${items.length}</span><button class="kb-hide" type="button" data-action="kb-hide" data-key="${key}" title="${esc(t('kb.hideCol'))}" aria-label="${esc(t('kb.hideColLabel', view.label(key)))}">${icon('x', 14)}</button></div>`
      + `<div class="kb-list">${items.map(view.card).join('') || `<div class="kb-empty">${esc(t('kb.empty'))}</div>`}</div></section>`;
  }).join('');
}
export function renderKanban() {
  const { board, error, sheet } = state.kanban, active = activeFilters(state.kanban.filters);
  const ticket = openTicket(), lock = sheet || ticket ? ' inert' : '';
  const head = `<div class="lane-header kb-head"${lock}><h2>${t('进度')}</h2><span class="kb-sub"><span class="kb-stamp">${board ? esc(t('kb.readonly', formatUtc8(board.generatedAt))) : ''}</span>${view.source(board?.github)}${view.conflicts(board?.conflictCount || 0)}</span>`
    + `<button class="kb-btn kb-sheet-btn" type="button" data-action="kb-sheet" aria-haspopup="dialog" aria-expanded="${sheet}">${icon('sliders', 16)}<span>${esc(t('kb.sheet'))}</span>${active ? `<span class="c">${t('kb.sheetCount', active)}</span>` : ''}</button></div>`;
  const body = board ? columnsHtml(board) : `<div class="kb-allhidden">${esc(error ? t('kb.loadFailed', error) : t('kb.loading'))}</div>`;
  const layer = sheet || ticket ? `<div class="kb-scrim" data-action="kb-close"></div>${ticket ? view.drawer(ticket, board.tickets) : ''}` : '';
  return `<section class="lane kb" id="sec-progress">${head}${view.notice(board).replace(/^<button class="[^"]*"/, match => match + lock)}${toolbar(ticket ? lock : '')}<div class="kb-board" data-keep="kb-board"${lock}>${body}</div>${layer}</section>`;
}

// 抽屉、筛选面板、下拉菜单按层关闭；关抽屉后焦点回到原来的卡片。
export function closeKanban() {
  const board = state.kanban, opener = board.drawer ? `.kb-card[data-id="${CSS.escape(board.drawer)}"]` : board.sheet ? '[data-action="kb-sheet"]' : null;
  if (!board.drawer && !board.sheet && !board.pop) return false;
  if (board.drawer) board.drawer = null; else if (board.sheet) { board.sheet = false; board.pop = null; } else board.pop = null;
  render();
  if (opener) document.querySelector(opener)?.focus();
  return true;
}
export function kanbanAction(action, button) {
  const board = state.kanban, id = button.dataset.pop;
  switch (action) {
    case 'kb-pop': board.pop = board.pop === id ? null : id; break;
    case 'kb-all': setSelected(id, MENUS[id].items().map(([value]) => value)); break;
    case 'kb-none': setSelected(id, []); break;
    case 'kb-reset': setSelected(id, DEFAULT_COLUMNS); break;
    case 'kb-owner-only': board.filters.ownerOnly = !board.filters.ownerOnly; saveKanban(); break;
    case 'kb-clear': board.filters = emptyFilters(); saveKanban(); break;
    case 'kb-hide': setSelected('columns', board.columns.filter(key => key !== button.dataset.key)); break;
    case 'kb-sheet': board.sheet = true; board.pop = null; overlay(); break;
    case 'kb-open': board.drawer = button.dataset.id; board.pop = null; overlay(); break;
    case 'kb-close': closeKanban(); return;
    default: return;
  }
  render();
  if (action === 'kb-open') document.getElementById('kb-x')?.focus();
  if (action === 'kb-sheet') document.getElementById('kb-sheet-x')?.focus();
}
export function kanbanChange(input) {
  const id = input.dataset.kbField, current = MENUS[id].get();
  setSelected(id, input.checked ? [...new Set([...current, input.value])] : current.filter(value => value !== input.value));
  render();
}
