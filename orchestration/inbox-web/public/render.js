import { state, t } from './state.js';
import { esc, icon } from './icons.js';
import { ago, when, waited, asker, letter, mediaKind } from './format.js';
import { draft, hasDraft, isEditing, late, notifyFailed, countDrafts } from './drafts.js';
import { mediaUrl } from './api.js';
import { renderRouting } from './routing.js';
import { renderKanban, kanbanModal } from './kanban.js';

// 安卓状态栏跟随页面底色，颜色取当前主题的 --bg 令牌。
export function applyTheme() {
  const mode = state.theme === 'auto' ? (state.systemTheme.matches ? 'dark' : 'light') : state.theme; document.documentElement.dataset.theme = mode;
  const meta = document.querySelector?.('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
}
applyTheme(); state.systemTheme.addEventListener('change', applyTheme);
export function thumbnails(images, id) {
  return images?.length ? `<div class="thumbs">${images.map((m,index) => `<figure class="thumb"><img src="${esc(mediaUrl(m))}" alt="${t("已附图片")}" data-lightbox="${esc(mediaUrl(m))}">${id ? `<button class="thumb-remove" data-action="remove-image" data-id="${esc(id)}" data-index="${index}" aria-label="${t("移除图片")}">${icon('x',12)}</button>` : ''}${m.size ? `<figcaption class="num">${m.originalSize && m.originalSize !== m.size ? `${Math.round(m.originalSize/1024)}→` : ''}${Math.round(m.size/1024)} KB</figcaption>` : ''}</figure>`).join('')}</div>` : '';
}
export function composer(id, placeholder, required = false) {
  const d = draft(id), tip = state.data.remote ? t('远程会压缩到长边 2048') : t('局域网传原图');
  return `<div class="composer ${required ? 'required' : ''}"><textarea rows="1" data-note="${esc(id)}" aria-label="${esc(placeholder)}" placeholder="${esc(placeholder)}">${esc(d.note)}</textarea>${thumbnails(d.images,id)}<div class="composer-bar"><label class="attach" title="${t("拍照")}${state.language === "zh" ? "（" : " ("}${tip}${state.language === "zh" ? "）" : ")"}">${icon('camera',18)}<span class="sr">${t("拍照")}</span><input hidden type="file" accept="image/*" capture="environment" data-file="${esc(id)}"></label><label class="attach" title="${t("从相册选")}${state.language === "zh" ? "（" : " ("}${tip}${state.language === "zh" ? "）" : ")"}">${icon('image',18)}<span class="sr">${t("从相册选")}</span><input hidden type="file" accept="image/*" multiple data-file="${esc(id)}"></label><span class="paste-hint">${t("可直接粘贴或拖入截图")}</span></div></div>`;
}
export function gallery(media = []) {
  if (!media.length) return '';
  return `<div class="gallery n${Math.min(media.length,3)}">${media.slice(0,3).map((m,index) => {
    const url = mediaUrl(m), kind = mediaKind(m.path);
    const preview = kind === 'video' ? `<video preload="metadata" src="${esc(url)}"></video>` : kind === 'doc' ? `<span class="doc-tile">${icon('doc',30)}<span class="doc-ext num">${esc(String(m.path).split('.').pop().toUpperCase())}</span></span>` : `<img src="${esc(url)}" alt="">`;
    return `<figure><button data-gallery="${index}" data-media="${esc(JSON.stringify(media))}" aria-label="${esc(m.caption || t('查看素材'))}">${preview}${index === 2 && media.length > 3 ? `<span class="more num">+${media.length-3}</span>` : ''}</button>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`;
  }).join('')}</div>`;
}
export function editor(item) {
  const d = draft(item.id), id = esc(item.id);
  let html;
  if (item.kind === 'decide') {
    const picked = item.options.map((o,index) => d.choices.includes(o.key) ? letter(index) : '').filter(Boolean);
    html = `<div class="options ${item.multi ? 'multi' : ''}" role="group">${item.options.map((o, index) => `<button class="option ${d.choices.includes(o.key) ? 'selected' : ''}" data-action="pick" data-id="${id}" data-key="${esc(o.key)}" aria-pressed="${d.choices.includes(o.key)}"><span class="key">${letter(index)}</span><span class="option-text"><span class="option-label">${esc(o.label)}${o.recommended ? `<span class="rec">${t("推荐")}</span>` : ''}</span>${o.consequence ? `<span class="consequence">${esc(o.consequence)}</span>` : ''}</span></button>`).join('')}</div>`;
    html += `<div class="hint">${picked.length ? `<span>${t("selected",picked.join(state.language === "zh" ? "、" : ", "))}</span><button class="link" data-action="clear" data-id="${id}">${t("清空")}</button>` : item.multi ? `<span>${t("可多选")}</span>` : ''}</div>`;
  } else html = `<div class="verdict">${[['pass',t('通过'),'ok'],['rework',t('返修'),'rework']].map(([key,label,i]) => `<button class="${key} ${d.choices.includes(key) ? 'selected' : ''}" data-action="pick" data-id="${id}" data-key="${key}" aria-pressed="${d.choices.includes(key)}">${icon(i,18)}${label}</button>`).join('')}</div>`;
  const rework = item.kind === 'accept' && d.choices[0] === 'rework';
  html += composer(item.id, rework ? t('写下要返修的地方（必填）') : t('补充说明（可选），只写留言也算答复'), rework && !d.note.trim());
  if (state.errors[item.id]) html += `<div class="error" role="alert">${icon('warn',15)}<span>${esc(state.errors[item.id])}</span></div>`;
  if (state.editing.has(item.id)) html += `<div class="actions"><button class="text-button" data-action="cancel-edit" data-id="${id}">${icon('undo',15)}${t("不改了")}</button><span class="aside">${t("改完和其他答复一起提交")}</span></div>`;
  return html;
}
// 送达进度：节点只标状态，时间和说明写在下面一行，异常换成带操作的提醒。
export function track(item) {
  if (item.status === 'open') return '';
  const steps = [['saved',t('已保存')],['notified',t('已通知')],['read',t('编排已读')],['forwarded',t('已转交')],['closed',t('结案')]].slice(0,item.kind ? 5 : 3);
  const current = steps.findIndex(([status]) => status === item.status), failed = notifyFailed(item), slow = late(item);
  let html = `<ol class="track" aria-label="${t("送达进度")}">${steps.map(([key,label],index) => {
    let style = index < current || (index === current && index === steps.length-1) ? 'done' : index === current ? 'current' : '';
    if (failed) style = key === 'notified' ? 'failed' : key === 'saved' ? 'done' : style;
    if (slow) style = key === 'read' ? 'late' : index < 2 ? 'done' : style;
    return `<li class="step ${style}"><span class="step-dot"></span><span class="step-label">${label}</span></li>`;
  }).join('')}</ol>`;
  const at = time => `<span class="num">${when(time)}</span>`;
  if (failed || slow) {
    const text = failed ? t('通知没送到编排。答复已存好，巡检会补查，也可以现在重发。') : t('unreadDetail', ago(item.times.notified));
    html += `<div class="alert ${failed ? 'failed' : 'late'}" role="status">${icon('warn',16)}<span class="alert-text">${text}</span><button class="alert-action" data-action="retry" data-id="${esc(item.id)}">${t("重发通知")}</button></div>`;
  } else {
    const note = {saved: item.notify?.state === 'unconfigured' ? t('已保存。这个 Campaign 没配通知，编排巡检时会看到') : t('已保存，正在通知编排'), notified:t('已通知编排'), read:t('编排已读'), forwarded:t('forwardedTo', esc(item.forwardedTo || t(t('提问会话'))), item.redo ? t(t('（改答）')) : ''), closed:t('已结案')}[item.status];
    html += `<div class="track-note"><span>${note}</span>${at(item.times?.[item.status])}${item.status === 'saved' && item.notify?.state === 'unconfigured' ? `<button class="link" data-action="retry" data-id="${esc(item.id)}">${t("重发通知")}</button>` : ''}</div>`;
  }
  return html;
}
export function card(item) {
  const open = isEditing(item), blocking = item.blocking && item.status === 'open', draftTag = open && hasDraft(item.id);
  let html = `<header class="card-head">${blocking ? `<span class="badge block">${icon('flag',12)}${t("挡票")}</span>` : ''}<span class="ticket num">${esc(item.ticket)}</span><span class="asker">${esc(asker(item))}</span><span class="when num">${item.status === 'open' ? waited(item.createdAt) : when(item.times?.saved || item.createdAt)}</span>${draftTag ? `<span class="badge draft">${t("草稿")}</span>` : ''}</header><h3 class="card-title">${esc(item.title)}</h3>`;
  if (open) {
    const long = (item.background || []).join('').length > 240, folded = long && !state.expanded.has(item.id);
    html += item.background?.length ? `<div class="background${folded ? ' folded' : ''}">${item.background.map(p => `<p>${esc(p)}</p>`).join('')}</div>${long ? `<button class="link bg-toggle" data-action="more" data-id="${esc(item.id)}">${folded ? t('展开全文') : t('收起')}</button>` : ''}` : '';
    if (item.recommendation) html += `<div class="recommendation">${icon('spark',14)}<span><b>${t("建议")}</b>${esc(item.recommendation)}</span></div>`;
    html += gallery(item.media) + editor(item);
  } else if (item.replacedBy) {
    const next = state.data.items.find(i => i.id === item.replacedBy);
    html += `<p class="quote closing">${t('replacedBy', esc(next?.title || item.replacedBy))}</p>`;
  } else {
    const a = item.answer || {choices:[],note:'',images:[]};
    const labels = a.choices.map(key => item.kind === 'accept' ? ({pass:t('通过'),rework:t('返修')}[key]) : `${letter(item.options.findIndex(o => o.key === key))}. ${item.options.find(o => o.key === key)?.label || ''}`);
    html += `<div class="reply"><div class="reply-label">${item.answeredBy === 'orchestrator' ? t('编排代答') : t('你的答复')}</div><div class="reply-choices">${labels.map(l => `<span class="chip ${item.kind === 'accept' ? (a.choices[0] === 'pass' ? 'pass' : 'rework') : ''}">${esc(l)}</span>`).join('') || `<span class="chip quiet">${t("只留言")}</span>`}</div>${a.note ? `<p class="quote">${esc(a.note)}</p>` : ''}${thumbnails(a.images)}</div>${track(item)}`;
    if (item.closedNote) html += `<p class="quote closing">${esc(item.closedNote)}</p>`;
    if (item.status !== 'closed') html += `<div class="actions"><button class="text-button" data-action="edit" data-id="${esc(item.id)}">${icon('pen',15)}${t("修改")}</button>${['saved','notified','read'].includes(item.status) ? `<button class="text-button" data-action="withdraw" data-id="${esc(item.id)}">${icon('undo',15)}${t("撤回")}</button>` : `<span class="aside">${t("再改会重新转交")}</span>`}</div>`;
  }
  return `<article class="card ${item.kind} ${blocking ? 'blocking' : ''} ${open ? 'open' : 'answered'} ${item.status === 'closed' ? 'closed' : ''}" data-card="${esc(item.id)}" id="item-${esc(item.id)}">${html}</article>`;
}
export function message(m) {
  const failed = notifyFailed(m), slow = late(m), quiet = m.status === 'saved' && m.notify?.state === 'unconfigured';
  const statusText = failed ? t('通知没送到') : slow ? t('unread',ago(m.times.notified)) : quiet ? t('已保存，没配通知，编排巡检时会看到') : {saved:t('已保存'),notified:t('已通知编排'),read:t('编排已读'),closed:t('已结案')}[m.status];
  return `<li class="message"><p class="message-note">${esc(m.note || t('（只有图）'))}</p>${thumbnails(m.images)}<div class="message-meta ${failed ? 'failed' : slow ? 'late' : m.status}"><span class="status-dot"></span><span>${statusText}</span>${failed || slow ? '' : `<span class="num">${when(m.times?.saved)}</span>`}${failed || slow || quiet ? `<button class="link" data-action="retry" data-id="${esc(m.id)}">${t("重发")}</button>` : ''}</div></li>`;
}
const countPill = (value, hot) => `<span class="count num ${hot ? 'hot' : ''} ${value ? '' : 'zero'}">${value}</span>`;
// 四个分区是真 tab：手机在底部，平板和电脑是左侧导航栏；链接带 ?tab=，可以收藏和新标签打开。
function tabLink(tab) {
  const params = [['campaign', state.campaign], ['machine', state.summary?.hub && state.machine], ['tab', tab !== 'decide' && tab]].filter(([, value]) => value);
  return `?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}
export function tabs(lock = '') {
  const items = state.data?.items || [], open = kind => items.filter(i => i.kind === kind && i.status === 'open').length, blocking = items.filter(i => i.blocking && i.status === 'open').length;
  const link = (tab, iconName, label, extra = '') => `<a href="${esc(tabLink(tab))}" data-tab="${tab}"${state.tab === tab ? ' class="active" aria-current="page"' : ''}>${icon(iconName,24)}<span>${t(label)}</span>${extra}</a>`;
  return `<nav class="tabs" aria-label="${t("分区")}"${lock}>${link('decide','decide','决定',state.data ? countPill(open('decide'), blocking) : '')}${link('accept','ok','验收',state.data ? countPill(open('accept')) : '')}${link('message','message','留言')}${link('progress','list','进度')}</nav>`;
}
export function decidePage() {
  const items = state.data.items, decisions = items.filter(i => i.kind === 'decide' && i.status !== 'closed'), closed = items.filter(i => i.status === 'closed');
  const n = decisions.filter(i => i.status === 'open').length, b = items.filter(i => i.blocking && i.status === 'open').length;
  return `<section class="lane" id="sec-decide"><div class="lane-header"><h2>${t("待你决定")}</h2>${countPill(n, b)}${b ? `<span class="lane-flag">${icon('flag',12)}${t("blockingCount",b)}</span>` : ''}</div><div class="lane-body">${decisions.map(card).join('') || empty(t('都决定完了'), t('有新题会推送提醒你'))}${closed.length ? `<button class="closed-toggle ${state.closedVisible ? 'expanded' : ''}" data-action="closed" aria-expanded="${state.closedVisible}"><span>${t("已结案")}</span><span class="num">${closed.length}</span>${icon('down',15)}</button>${state.closedVisible ? closed.map(card).join('') : ''}` : ''}</div></section>`;
}
export function acceptPage() {
  const accepts = state.data.items.filter(i => i.kind === 'accept' && i.status !== 'closed');
  return `<section class="lane" id="sec-accept"><div class="lane-header"><h2>${t("待你验收")}</h2>${countPill(accepts.filter(i => i.status === 'open').length)}</div><div class="lane-body">${accepts.map(card).join('') || empty(t('没有待验收的成品'), t('交付到了会推送提醒你'))}</div></section>`;
}
export function messagePage() {
  return `<section class="lane" id="sec-message"><div class="lane-header"><h2>${t("给编排留言")}</h2></div><div class="lane-body"><article class="card panel" data-card="__message"><p class="panel-sub">${t("不针对哪一题，和答复一起提交")}</p>${composer('__message',t('比如：#237 先停，等我周末看实物'))}${state.data.messages.length ? `<ul class="messages">${state.data.messages.slice().reverse().map(message).join('')}</ul>` : ''}</article></div></section>`;
}
const pages = { decide: decidePage, accept: acceptPage, message: messagePage, progress: renderKanban };
export const empty = (title, text) => `<div class="empty">${icon('inbox',28)}<b>${title}</b><span>${text}</span></div>`;
export function renderMenu() {
  if (!state.menu || !state.summary) return '';
  const bounds = document.querySelector('.switcher')?.getBoundingClientRect();
  const machines = [{name:state.summary.name,campaigns:state.summary.campaigns,self:true}, ...(state.summary.peers || [])];
  const disabledRemove = title => `<button class="link campaign-remove" disabled title="${t(title)}">${t('移除')}</button>`;
  const removeNote = key => `<p class="machine-note">${t(key)}</p>`;
  const row = (p, c) => { const pending = c.pending || 0, inner = `<span class="campaign-title">${esc(c.title)}</span><span class="pending num ${pending ? '' : 'zero'}">${pending ? t('pending',pending) : t('无待答')}</span>`;
    const select = state.summary.hub || p.self ? `<button class="campaign-row ${p.name === state.machine && c.id === state.campaign ? 'active' : ''}" data-action="campaign" data-machine="${esc(p.name)}" data-id="${esc(c.id)}">${inner}</button>` : `<a class="campaign-row" href="${esc(new URL(`?campaign=${encodeURIComponent(c.id)}`,p.url).href)}">${inner}</a>`;
    let remove = '';
    let note = '';
    const unknown = typeof c.removable !== 'boolean';
    const blocked = c.removable === false;
    if (state.summary.hub || p.self) {
      // Hub/self: canManage gate; disabled title stays removeBlocked (prior hub display).
      if (state.summary.canManage) {
        remove = c.removable
          ? `<button class="link campaign-remove" data-action="remove-campaign" data-machine="${esc(p.name)}" data-id="${esc(c.id)}" title="${t('移除')}">${t('移除')}</button>`
          : `<button class="link campaign-remove" data-action="remove-campaign" data-machine="${esc(p.name)}" data-id="${esc(c.id)}" disabled title="${t('removeBlocked')}">${t('移除')}</button>`;
        if (blocked) note = removeNote('removeBlocked');
      }
    } else if (p.url) {
      // LAN peer: jump link; enablement from peer removable; auth on owning machine.
      const reason = blocked ? 'removeBlocked' : unknown ? 'removeUnread' : '移除';
      remove = c.removable
        ? `<a class="link campaign-remove" href="${esc(new URL(`?campaign=${encodeURIComponent(c.id)}&remove=${encodeURIComponent(c.id)}`, p.url).href)}">${t('移除')}</a>`
        : disabledRemove(reason);
      if (blocked || unknown) note = removeNote(reason);
    }
    return `<div class="campaign-entry">${select}${remove}</div>${note}`; };
  return `<div class="scrim" data-action="close-menu"></div><div class="sheet" role="dialog" aria-label="${t("切换")} Campaign" style="--x:${Math.round(bounds?.left || 16)}px;--y:${Math.round((bounds?.bottom || 56) + 8)}px"><div class="sheet-head"><b>${t("切换")} Campaign</b><button class="icon-button" data-action="close-menu" aria-label="${t("关闭")}">${icon('x',18)}</button></div><div class="sheet-body">${machines.map(p => `<section class="machine ${p.unavailable ? 'off' : ''}"><h6>${icon(p.unavailable ? 'offline' : 'server',14)}<span>${esc(p.name)}</span><em>${p.unavailable ? t('连不上') : p.campaigns ? t('在线') : t('连接中…')}</em></h6>${p.unavailable ? `<p class="machine-note">${t("peerOffline")}</p>` : (p.campaigns || []).map(c => row(p, c)).join('') || (p.campaigns ? `<p class="machine-note">${t("noRegistered")}</p>` : '')}</section>`).join('')}</div></div>`;
}
export function header(lock = '') {
  const remote = state.data ? state.data.remote : state.summary?.remote, themeTitle = {auto:t('跟随系统'),light:t('浅色'),dark:t('深色')}[state.theme];
  const title = state.data ? state.data.campaign.title : state.errors.connection && state.campaign ? state.campaign : state.campaign ? t('正在加载…') : t('选择 Campaign');
  const bell = state.data?.remote && isSecureContext && 'PushManager' in window ? `<button class="icon-button ${state.pushOn ? 'on' : ''}" data-action="push" title="${state.pushOn ? t('推送已开启，点一下给所有机器补登记') : t('开启推送提醒')}" aria-label="${state.pushOn ? t('推送已开启') : t('开启推送提醒')}">${icon(state.pushOn ? 'bellOn' : 'bell',19)}</button>` : '';
  return `<header class="bar"${lock}><div class="wrap bar-inner"><span class="mark">${icon('inbox',17)}</span><span class="brand">Inbox</span><button class="switcher" data-action="menu" aria-haspopup="dialog" aria-expanded="${state.menu}"><span class="switcher-machine"><i class="dot ${state.errors.connection ? 'off' : remote === undefined ? 'wait' : remote ? 'remote' : 'lan'}"></i>${esc(state.machine || state.summary?.name || '')}<span class="via">${state.errors.connection ? t('连不上') : remote === undefined ? t('连接中…') : remote ? t('远程') : t('局域网')}</span></span><span class="switcher-name"><span class="switcher-title">${esc(title)}</span>${icon('down',16)}</span></button><span class="spacer"></span><span class="bar-tools">${bell}${state.summary?.loggedIn ? `<button class="icon-button" data-action="add-device" title="${t('添加设备')}" aria-label="${t('添加设备')}">${icon('server',18)}</button>` : ''}<button class="icon-button" data-action="rt-open" title="${t('派票设置')}" aria-label="${t('派票设置')}">${icon('sliders',19)}</button><button class="icon-button language-button" data-action="language" title="${t('语言')}" aria-label="${t('语言')}">${state.language === 'zh' ? 'EN' : '中'}</button><button class="icon-button" data-action="theme" title="${t("主题：")}${themeTitle}" aria-label="${t("主题：")}${themeTitle}">${icon({auto:'auto',light:'sun',dark:'moon'}[state.theme],19)}</button></span><button class="icon-button settings-button" data-action="settings" aria-haspopup="dialog" aria-expanded="${state.settings}" title="${t('设置')}" aria-label="${t('设置')}">${icon('settings',20)}</button></div></header>`;
}
// 手机顶栏放不下的工具收在这里，桌面仍直接显示在顶栏。
export function renderSettings() {
  if (!state.settings) return '';
  const themeTitle = {auto:t('跟随系统'),light:t('浅色'),dark:t('深色')}[state.theme];
  const row = (action, iconName, label, value = '') => `<button class="setting-row" data-action="${action}">${icon(iconName,19)}<span class="setting-label">${label}</span><span class="setting-value">${value}</span></button>`;
  const push = state.data?.remote && isSecureContext && 'PushManager' in window ? row('push', state.pushOn ? 'bellOn' : 'bell', state.pushOn ? t('推送已开启') : t('开启推送提醒')) : '';
  return `<div class="scrim" data-action="close-menu"></div><div class="sheet settings-sheet" role="dialog" aria-label="${t('设置')}"><div class="sheet-head"><b>${t('设置')}</b><button class="icon-button" data-action="close-menu" aria-label="${t('关闭')}">${icon('x',18)}</button></div><div class="sheet-body">${push}${state.summary?.loggedIn ? row('add-device', 'server', t('添加设备')) : ''}${row('rt-open', 'sliders', t('派票设置'))}${row('language', 'globe', t('语言'), state.language === 'zh' ? '中文' : 'English')}${row('theme', {auto:'auto',light:'sun',dark:'moon'}[state.theme], t('主题'), themeTitle)}</div></div>`;
}
export const skeleton = () => `<main class="board-wrap"><div class="wrap shell">${tabs()}<div class="view loading" aria-busy="true"><section class="lane"><div class="lane-header"><span class="sk sk-title"></span></div><div class="lane-body">${[0,1].map(() => '<div class="card sk-card"><span class="sk sk-line short"></span><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-block"></span></div>').join('')}</div></section></div></div></main>`;
// 整页重绘后把焦点放回同一个控件，键盘操作不用从头再找；横向滚动的看板和抽屉保留滚动位置。
const focusKeys = ['action', 'field', 'type', 'index', 'key', 'layer', 'delta', 'kbField', 'pop', 'id', 'tab'];
function focusTarget() {
  const el = document.activeElement, data = el?.dataset;
  if (!data || !focusKeys.some(k => k in data)) return null;
  return focusKeys.filter(k => k in data).map(k => `[data-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(data[k])}"]`).join('') + (data.kbField ? `[value="${CSS.escape(el.value)}"]` : '');
}
function keepScroll() {
  const kept = [...document.querySelectorAll('.lane-body,[data-keep]')].map(el => [el.dataset.keep, el.scrollLeft, el.scrollTop]);
  return () => document.querySelectorAll('.lane-body,[data-keep]').forEach((el, i) => { const old = el.dataset.keep ? kept.find(k => k[0] === el.dataset.keep) : kept[i]; if (old) { el.scrollLeft = old[1]; el.scrollTop = old[2]; } });
}
function routingView() {
  const y = scrollY, restore = keepScroll(), focus = focusTarget();
  state.root.innerHTML = `${header()}${renderRouting()}${renderMenu()}${renderSettings()}`;
  restore(); scrollTo(0, y); spy();
  if (focus) document.querySelector(focus)?.focus({ preventScroll: true });
}
export let render = function render() {
  if (state.view === 'routing') return routingView();
  if (!state.data) {
    const view = state.errors.connection ? `<div class="state">${icon('offline',36)}<h2>${esc(state.machine)} · ${t("连不上")}</h2><p>${t("offline")}</p><div class="state-actions"><button class="button primary" data-action="reload">${icon('refresh',16)}${t("重试")}</button><button class="button" data-action="menu">${t("切换")} Campaign</button></div></div>`
      : !state.campaign && state.summary ? `<div class="state">${icon('inbox',36)}<h2>${t("noCampaign")}</h2><p>${t("registerHint")}</p></div>` : skeleton();
    state.root.innerHTML = `${header()}${view}${renderMenu()}${renderSettings()}`;
    return;
  }
  const y = scrollY, restore = keepScroll(), focus = focusTarget(), unsent = countDrafts(), lock = kanbanModal() ? ' inert' : '';
  const focused = document.activeElement?.dataset.note, selection = focused && [document.activeElement.selectionStart,document.activeElement.selectionEnd];
  state.root.innerHTML = `${header(lock)}
  <main class="board-wrap"><div class="wrap shell">${tabs(lock)}<div class="view view-${state.tab}">${pages[state.tab]()}</div></div></main>
  <div class="tray ${unsent ? 'show' : ''}" ${unsent && !lock ? '' : 'inert'}><span class="tray-count"><b class="num">${unsent}</b> ${t("项待提交")}</span><button class="tray-clear" data-action="clear-all">${t("清空")}</button><button class="submit" data-action="submit" ${state.busy || state.uploading ? 'disabled' : ''}>${icon('send',16)}<span>${state.busy ? t('提交中…') : state.uploading ? t('上传中…') : t('提交')}</span></button></div>${renderMenu()}${renderSettings()}`;
  restore(); scrollTo(0,y);
  document.querySelectorAll('textarea').forEach(grow);
  if (focused) { const el = [...document.querySelectorAll('[data-note]')].find(el => el.dataset.note === focused); if (el) { el.focus({preventScroll:true}); el.setSelectionRange(...selection); } }
  else if (focus) document.querySelector(focus)?.focus({ preventScroll: true });
  spy();
}
// 按服务端返回的通知结果说清楚，通知失败或没配通知时不承诺编排会收到。
export function submitted(n, notify) { return notify === 'failed' ? t('submittedFailed',n) : notify === 'unconfigured' ? t('submittedQuiet',n) : t('submitted',n); }
export function grow(el) { el.style.height='auto'; el.style.height=`${Math.min(el.scrollHeight,220)}px`; el.style.overflowY=el.scrollHeight>220?'auto':'hidden'; }
// 派票设置页的分区导航仍是锚点，按滚动位置高亮；Inbox 的四个 tab 是真 tab，不参与。
export function spy() {
  document.body.classList.toggle('scrolled',scrollY>4);
  const links=[...document.querySelectorAll('.tabs a[href^="#"]')];if(!links.length)return;let current=links[0];
  for(const link of links){if(document.querySelector(link.hash)?.getBoundingClientRect().top<140)current=link;}
  // 滚到底时最后一区够不到顶部，直接算它。
  if(innerHeight+scrollY>=document.documentElement.scrollHeight-2&&scrollY>0)current=links.at(-1);
  // 点击后的锚点滚动可能被页面底部截断，仍以明确选择为准。
  current=links.find(link=>link.hash===state.selectedTab)||current;
  for(const link of links)link.classList.toggle('active',link===current);
}
