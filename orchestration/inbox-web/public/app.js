import { chooseLanguage, translate, translateError } from './i18n.js';
let language = chooseLanguage(localStorage.getItem('inbox-language'), navigator.language);
const t = (key, ...values) => translate(language, key, ...values);
document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
const root = document.getElementById('app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  inbox:'M3 13h5l2 3h4l2-3h5M6 5h12l3 8v6H3v-6Z', check:'m5 12.5 4.5 4.5L19 7',
  camera:'M4 8h3l2-3h6l2 3h3v11H4ZM8.5 13a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0',
  image:'M4 5h16v14H4ZM4 17l5-5 4 4 3-3 4 4M8.5 9h.01', doc:'M6 3h8l4 4v14H6ZM14 3v4h4M9 12h6M9 16h6', down:'m6 9 6 6 6-6', left:'m15 5-7 7 7 7', right:'m9 5 7 7-7 7',
  send:'M4 12 20 4l-6 16-3-7ZM11 13l9-9', sun:'M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
  moon:'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z', auto:'M3 5h18v11H3ZM8 20h8M12 16v4',
  undo:'m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12h-3', pen:'M4 20h4L19 9l-4-4L4 16ZM13.5 6.5l4 4',
  warn:'M12 4 2.5 20h19ZM12 10v4.5m0 2.8v.1', ok:'M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0m5 .5 3 3 5-6',
  rework:'M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6', arrow:'M4 12h16m-6-6 6 6-6 6',
  spark:'M12 3.5 13.8 9 19.5 10.8 13.8 12.6 12 18.5 10.2 12.6 4.5 10.8 10.2 9Z', x:'m6 6 12 12M6 18 18 6',
  bell:'M5.5 17h13l-1.6-2.4V10a4.9 4.9 0 0 0-9.8 0v4.6ZM10 20.5h4', bellOn:'M5.5 17h13l-1.6-2.4V10a4.9 4.9 0 0 0-9.8 0v4.6ZM10 20.5h4M3 8.5a9 9 0 0 1 2.4-4.6M21 8.5a9 9 0 0 0-2.4-4.6',
  offline:'m3 3 18 18M8.6 6.3A5.5 5.5 0 0 1 17.4 10H18a4 4 0 0 1 2.7 7M15.5 19H7a4 4 0 0 1-1.6-7.7', refresh:'M20 11a8 8 0 0 0-14.6-4.5M4 3.5v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20.5v-4h-4',
  server:'M4 4h16v7H4ZM4 13h16v7H4ZM8 7.5h.01M8 16.5h.01', message:'M4 5h16v11H9.5L5 20v-4H4Z', list:'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  decide:'M4 6.5 6 8.5l3.5-3.5M4 15.5l2 2 3.5-3.5M13 7h7M13 16h7', flag:'M5 21V4h11.5l-2 4 2 4H5', clock:'M12 7.5V12l3 2M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0',
};
const icon = (name, size = 16) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || paths.inbox}"/></svg>`;
let machine = new URL(location.href).searchParams.get('machine');
let summary, data, campaign = new URL(location.href).searchParams.get('campaign'), drafts = {}, editing = new Set(), expanded = new Set(), errors = {}, closedVisible = false, menu = false, busy = false, uploading = 0, pushOn = false;
const systemTheme = matchMedia('(prefers-color-scheme:dark)');
let theme = localStorage.getItem('inbox-theme') || 'auto';
// 安卓状态栏跟随页面底色。
function applyTheme() { const mode = theme === 'auto' ? (systemTheme.matches ? 'dark' : 'light') : theme; document.documentElement.dataset.theme = mode; document.querySelector?.('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#131218' : '#fcf8ff'); }
applyTheme(); systemTheme.addEventListener('change', applyTheme);
const draftKey = () => `inbox-drafts:${machine}:${campaign}`;
function readDrafts() { try { drafts = JSON.parse(localStorage.getItem(draftKey()) || '{}'); } catch { drafts = {}; } editing = new Set(Object.keys(drafts).filter(id => drafts[id].editing)); }
function saveDrafts() { localStorage.setItem(draftKey(), JSON.stringify(drafts)); }
const draft = id => drafts[id] ||= {choices:[],note:'',images:[]};
const hasDraft = id => !!drafts[id] && (drafts[id].choices?.length || drafts[id].note?.trim() || drafts[id].images?.length);
const isEditing = item => item.status !== 'closed' && (item.status === 'open' || editing.has(item.id));
const targets = () => data.items.filter(i => isEditing(i) && hasDraft(i.id));
const countDrafts = () => targets().length + (hasDraft('__message') ? 1 : 0);
const late = item => item.status === 'notified' && Date.now() - Date.parse(item.times?.notified) >= 15 * 60000;
const letter = index => String.fromCharCode(65 + index);
const minutesSince = time => Math.max(0, Math.floor((Date.now()-Date.parse(time))/60000));
function ago(time) { const n = minutesSince(time); return n < 1 ? t('刚刚') : n < 60 ? t('minutes', n) : n < 1440 ? t('hoursMinutes', Math.floor(n/60), n%60) : t('days', Math.floor(n/1440)); }
// 时间一律带上日期语境：一小时内说“几分钟前”，再往前写今天／昨天／几月几日。
function when(time) {
  if (!time) return '';
  const date = new Date(time), now = new Date(), minutes = Math.floor((now - date) / 60000);
  if (minutes < 1) return t('刚刚'); if (minutes < 60) return t('minutesAgo', minutes);
  const clock = date.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false});
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  return days === 0 ? t('today', clock) : days === 1 ? t('yesterday', clock) : t('date', date.getMonth()+1,date.getDate(),clock);
}
// 卡片右上角只要量级：一小时内到分钟，一天内到小时，再往后按天。
const waited = time => { const n = minutesSince(time); return n < 1 ? t('刚到') : n < 60 ? t('waitMinutes',n) : n < 1440 ? t('waitHours',Math.floor(n/60)) : t('waitDays',Math.floor(n/1440)); };
// 提问者标签常以票号开头，票号已单独显示，这里去掉重复。
const asker = item => String(item.askerLabel || '').replace(String(item.ticket), '').replace(/^[\s·:：-]+/, '') || item.askerLabel;
// 页面、媒体、上传共用这里；地址保持相对路径，支持远程路径前缀。
const machineBase = name => new URL(`/${encodeURIComponent(name)}/`, location.href);
function address(route) { if (summary?.hub) return new URL(route, machineBase(machine)); return new URL(route, data?.lanHttpsUrl && !data.remote ? data.lanHttpsUrl.replace(/\/?$/, '/') : new URL('./', location.href)); }
async function api(route, value, base) {
  const response = await fetch(base ? new URL(route, base) : address(route), value === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  // A proxy in front of the Inbox (remote tunnel restarting, gateway timeout) can answer without JSON.
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(translateError(language, result?.error || '服务暂时连不上，请稍后重试'));
  return result;
}
function mediaUrl(ref) {
  const path = typeof ref === 'string' ? ref : ref.path;
  return address(`media/${encodeURIComponent(campaign)}/${String(path).split(/[\\/]/).map(encodeURIComponent).join('/')}`).href;
}
function thumbnails(images, id) {
  return images?.length ? `<div class="thumbs">${images.map((m,index) => `<figure class="thumb"><img src="${esc(mediaUrl(m))}" alt="${t("已附图片")}" data-lightbox="${esc(mediaUrl(m))}">${id ? `<button class="thumb-remove" data-action="remove-image" data-id="${esc(id)}" data-index="${index}" aria-label="${t("移除图片")}">${icon('x',12)}</button>` : ''}${m.size ? `<figcaption class="num">${m.originalSize && m.originalSize !== m.size ? `${Math.round(m.originalSize/1024)}→` : ''}${Math.round(m.size/1024)} KB</figcaption>` : ''}</figure>`).join('')}</div>` : '';
}
function composer(id, placeholder, required = false) {
  const d = draft(id), tip = data.remote ? t('远程会压缩到长边 2048') : t('局域网传原图');
  return `<div class="composer ${required ? 'required' : ''}"><textarea rows="1" data-note="${esc(id)}" aria-label="${esc(placeholder)}" placeholder="${esc(placeholder)}">${esc(d.note)}</textarea>${thumbnails(d.images,id)}<div class="composer-bar"><label class="attach" title="${t("拍照")}${language === "zh" ? "（" : " ("}${tip}${language === "zh" ? "）" : ")"}">${icon('camera',18)}<span class="sr">${t("拍照")}</span><input hidden type="file" accept="image/*" capture="environment" data-file="${esc(id)}"></label><label class="attach" title="${t("从相册选")}${language === "zh" ? "（" : " ("}${tip}${language === "zh" ? "）" : ")"}">${icon('image',18)}<span class="sr">${t("从相册选")}</span><input hidden type="file" accept="image/*" multiple data-file="${esc(id)}"></label><span class="paste-hint">${t("可直接粘贴或拖入截图")}</span></div></div>`;
}
// Text documents (release checklists, reports) open in a reader instead of an <img>.
// Escape first, then a small Markdown subset; links stay http(s) only.
function markdown(text) {
  const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return esc(text).split(/\r?\n/).map(line => {
    const heading = line.match(/^(#{1,4})\s+(.*)/), item = line.match(/^(\s*)[-*]\s+(\[( |x|X)\]\s+)?(.*)/);
    if (heading) return `<p class="md-h${heading[1].length}">${inline(heading[2])}</p>`;
    if (item) return `<p class="md-li" style="--indent:${Math.min(item[1].length,8)}">${item[2] ? (item[3] === ' ' ? '☐' : '☑') : '•'} ${inline(item[4])}</p>`;
    return line.trim() ? `<p>${inline(line)}</p>` : '';
  }).join('');
}
const mediaKind = path => /\.(mp4|webm|mov)$/i.test(path || '') ? 'video' : /\.(md|markdown|txt|log|csv|json)$/i.test(path || '') ? 'doc' : 'image';
function gallery(media = []) {
  if (!media.length) return '';
  return `<div class="gallery n${Math.min(media.length,3)}">${media.slice(0,3).map((m,index) => {
    const url = mediaUrl(m), kind = mediaKind(m.path);
    const preview = kind === 'video' ? `<video preload="metadata" src="${esc(url)}"></video>` : kind === 'doc' ? `<span class="doc-tile">${icon('doc',30)}<span class="doc-ext num">${esc(String(m.path).split('.').pop().toUpperCase())}</span></span>` : `<img src="${esc(url)}" alt="">`;
    return `<figure><button data-gallery="${index}" data-media="${esc(JSON.stringify(media))}" aria-label="${esc(m.caption || t('查看素材'))}">${preview}${index === 2 && media.length > 3 ? `<span class="more num">+${media.length-3}</span>` : ''}</button>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`;
  }).join('')}</div>`;
}
function editor(item) {
  const d = draft(item.id), id = esc(item.id);
  let html;
  if (item.kind === 'decide') {
    const picked = item.options.map((o,index) => d.choices.includes(o.key) ? letter(index) : '').filter(Boolean);
    html = `<div class="options ${item.multi ? 'multi' : ''}" role="group">${item.options.map((o, index) => `<button class="option ${d.choices.includes(o.key) ? 'selected' : ''}" data-action="pick" data-id="${id}" data-key="${esc(o.key)}" aria-pressed="${d.choices.includes(o.key)}"><span class="key">${letter(index)}</span><span class="option-text"><span class="option-label">${esc(o.label)}${o.recommended ? `<span class="rec">${t("推荐")}</span>` : ''}</span>${o.consequence ? `<span class="consequence">${esc(o.consequence)}</span>` : ''}</span></button>`).join('')}</div>`;
    html += `<div class="hint">${picked.length ? `<span>${t("selected",picked.join(language === "zh" ? "、" : ", "))}</span><button class="link" data-action="clear" data-id="${id}">${t("清空")}</button>` : item.multi ? `<span>${t("可多选")}</span>` : ''}</div>`;
  } else html = `<div class="verdict">${[['pass',t('通过'),'ok'],['rework',t('返修'),'rework']].map(([key,label,i]) => `<button class="${key} ${d.choices.includes(key) ? 'selected' : ''}" data-action="pick" data-id="${id}" data-key="${key}" aria-pressed="${d.choices.includes(key)}">${icon(i,18)}${label}</button>`).join('')}</div>`;
  const rework = item.kind === 'accept' && d.choices[0] === 'rework';
  html += composer(item.id, rework ? t('写下要返修的地方（必填）') : t('补充说明（可选），只写留言也算答复'), rework && !d.note.trim());
  if (errors[item.id]) html += `<div class="error" role="alert">${icon('warn',15)}<span>${esc(errors[item.id])}</span></div>`;
  if (editing.has(item.id)) html += `<div class="actions"><button class="text-button" data-action="cancel-edit" data-id="${id}">${icon('undo',15)}${t("不改了")}</button><span class="aside">${t("改完和其他答复一起提交")}</span></div>`;
  return html;
}
// 送达进度：节点只标状态，时间和说明写在下面一行，异常换成带操作的提醒。
function track(item) {
  if (item.status === 'open') return '';
  const steps = [['saved',t('已保存')],['notified',t('已通知')],['read',t('编排已读')],['forwarded',t('已转交')],['closed',t('结案')]].slice(0,item.kind ? 5 : 3);
  const current = steps.findIndex(([status]) => status === item.status), failed = item.notify?.state === 'failed', slow = late(item);
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
function card(item) {
  const open = isEditing(item), blocking = item.blocking && item.status === 'open', draftTag = open && hasDraft(item.id);
  let html = `<header class="card-head">${blocking ? `<span class="badge block">${icon('flag',12)}${t("挡票")}</span>` : ''}<span class="ticket num">${esc(item.ticket)}</span><span class="asker">${esc(asker(item))}</span><span class="when num">${item.status === 'open' ? waited(item.createdAt) : when(item.times?.saved || item.createdAt)}</span>${draftTag ? `<span class="badge draft">${t("草稿")}</span>` : ''}</header><h3 class="card-title">${esc(item.title)}</h3>`;
  if (open) {
    const long = (item.background || []).join('').length > 240, folded = long && !expanded.has(item.id);
    html += item.background?.length ? `<div class="background${folded ? ' folded' : ''}">${item.background.map(p => `<p>${esc(p)}</p>`).join('')}</div>${long ? `<button class="link bg-toggle" data-action="more" data-id="${esc(item.id)}">${folded ? t('展开全文') : t('收起')}</button>` : ''}` : '';
    if (item.recommendation) html += `<div class="recommendation">${icon('spark',14)}<span><b>${t("建议")}</b>${esc(item.recommendation)}</span></div>`;
    html += gallery(item.media) + editor(item);
  } else {
    const a = item.answer || {choices:[],note:'',images:[]};
    const labels = a.choices.map(key => item.kind === 'accept' ? ({pass:t('通过'),rework:t('返修')}[key]) : `${letter(item.options.findIndex(o => o.key === key))}. ${item.options.find(o => o.key === key)?.label || ''}`);
    html += `<div class="reply"><div class="reply-label">${item.answeredBy === 'orchestrator' ? t('编排代答') : t('你的答复')}</div><div class="reply-choices">${labels.map(l => `<span class="chip ${item.kind === 'accept' ? (a.choices[0] === 'pass' ? 'pass' : 'rework') : ''}">${esc(l)}</span>`).join('') || `<span class="chip quiet">${t("只留言")}</span>`}</div>${a.note ? `<p class="quote">${esc(a.note)}</p>` : ''}${thumbnails(a.images)}</div>${track(item)}`;
    if (item.closedNote) html += `<p class="quote closing">${esc(item.closedNote)}</p>`;
    if (item.status !== 'closed') html += `<div class="actions"><button class="text-button" data-action="edit" data-id="${esc(item.id)}">${icon('pen',15)}${t("修改")}</button>${['saved','notified','read'].includes(item.status) ? `<button class="text-button" data-action="withdraw" data-id="${esc(item.id)}">${icon('undo',15)}${t("撤回")}</button>` : `<span class="aside">${t("再改会重新转交")}</span>`}</div>`;
  }
  return `<article class="card ${item.kind} ${blocking ? 'blocking' : ''} ${open ? 'open' : 'answered'} ${item.status === 'closed' ? 'closed' : ''}" data-card="${esc(item.id)}" id="item-${esc(item.id)}">${html}</article>`;
}
function stage(ticket, completed) {
  const tone = completed ? 'done' : /^(卡住|等你决定)/.test(ticket.stage) ? 'block' : /^等你/.test(ticket.stage) ? 'wait' : '';
  const text = completed ? t('完成') : String(ticket.stage ?? '');
  return `<span class="stage ${tone}${text.length > 8 ? ' long' : ''}">${esc(t(text))}</span>`;
}
function progress() {
  const groups = (data.progress?.groups || []).filter(group => group.tickets.length), older = data.progress?.olderCompleted || 0;
  return `<article class="card panel progress" id="sec-progress"><header class="panel-head"><h4>${t("进度")}</h4><span class="panel-sub">${t("progressSource")}</span></header>${groups.map(group => `<h5>${esc(t(group.title))}<span class="num">${group.tickets.length}</span></h5><ul class="tickets">${group.tickets.map(t => `<li class="ticket-row"><span class="ticket-id num">${esc(t.ticket)}</span><span class="ticket-title">${esc(t.title)}</span>${stage(t, group.completed)}</li>`).join('')}</ul>`).join('') || `<p class="panel-empty">${t("还没有票")}</p>`}${older ? `<p class="older">${t("older",older)}</p>` : ''}</article>`;
}
function message(m) {
  const failed = m.notify?.state === 'failed', slow = late(m), quiet = m.status === 'saved' && m.notify?.state === 'unconfigured';
  const state = failed ? t('通知没送到') : slow ? t('unread',ago(m.times.notified)) : quiet ? t('已保存，没配通知，编排巡检时会看到') : {saved:t('已保存'),notified:t('已通知编排'),read:t('编排已读')}[m.status];
  return `<li class="message"><p class="message-note">${esc(m.note || t('（只有图）'))}</p>${thumbnails(m.images)}<div class="message-meta ${failed ? 'failed' : slow ? 'late' : m.status}"><span class="status-dot"></span><span>${state}</span>${failed || slow ? '' : `<span class="num">${when(m.times?.saved)}</span>`}${failed || slow || quiet ? `<button class="link" data-action="retry" data-id="${esc(m.id)}">${t("重发")}</button>` : ''}</div></li>`;
}
function side() {
  return `<section class="lane side" id="sec-side"><div class="lane-header"><h2>${t("留言与进度")}</h2></div><div class="lane-body"><article class="card panel" data-card="__message" id="sec-message"><header class="panel-head"><h4>${t("给编排留言")}</h4><span class="panel-sub">${t("不针对哪一题，和答复一起提交")}</span></header>${composer('__message',t('比如：#237 先停，等我周末看实物'))}${data.messages.length ? `<ul class="messages">${data.messages.slice().reverse().map(message).join('')}</ul>` : ''}</article>${progress()}</div></section>`;
}
const empty = (title, text) => `<div class="empty">${icon('inbox',28)}<b>${title}</b><span>${text}</span></div>`;
function renderMenu() {
  if (!menu || !summary) return '';
  const bounds = document.querySelector('.switcher')?.getBoundingClientRect();
  const machines = [{name:summary.name,campaigns:summary.campaigns,self:true}, ...(summary.peers || [])];
  const row = (p, c) => { const pending = c.pending || 0, inner = `<span class="campaign-title">${esc(c.title)}</span><span class="pending num ${pending ? '' : 'zero'}">${pending ? t('pending',pending) : t('无待答')}</span>`;
    return summary.hub || p.self ? `<button class="campaign-row ${p.name === machine && c.id === campaign ? 'active' : ''}" data-action="campaign" data-machine="${esc(p.name)}" data-id="${esc(c.id)}">${inner}</button>` : `<a class="campaign-row" href="${esc(new URL(`?campaign=${encodeURIComponent(c.id)}`,p.url).href)}">${inner}</a>`; };
  return `<div class="scrim" data-action="close-menu"></div><div class="sheet" role="dialog" aria-label="${t("切换")} Campaign" style="--x:${Math.round(bounds?.left || 16)}px;--y:${Math.round((bounds?.bottom || 56) + 8)}px"><div class="sheet-head"><b>${t("切换")} Campaign</b><button class="icon-button" data-action="close-menu" aria-label="${t("关闭")}">${icon('x',18)}</button></div><div class="sheet-body">${machines.map(p => `<section class="machine ${p.unavailable ? 'off' : ''}"><h6>${icon(p.unavailable ? 'offline' : 'server',14)}<span>${esc(p.name)}</span><em>${p.unavailable ? t('连不上') : p.campaigns ? t('在线') : t('连接中…')}</em></h6>${p.unavailable ? `<p class="machine-note">${t("peerOffline")}</p>` : (p.campaigns || []).map(c => row(p, c)).join('') || (p.campaigns ? `<p class="machine-note">${t("noRegistered")}</p>` : '')}</section>`).join('')}</div></div>`;
}
function header() {
  const remote = data ? data.remote : summary?.remote, themeTitle = {auto:t('跟随系统'),light:t('浅色'),dark:t('深色')}[theme];
  const title = data ? data.campaign.title : errors.connection && campaign ? campaign : campaign ? t('正在加载…') : t('选择 Campaign');
  const bell = data?.remote && isSecureContext && 'PushManager' in window ? `<button class="icon-button ${pushOn ? 'on' : ''}" data-action="push" title="${pushOn ? t('推送已开启，点一下给所有机器补登记') : t('开启推送提醒')}" aria-label="${pushOn ? t('推送已开启') : t('开启推送提醒')}">${icon(pushOn ? 'bellOn' : 'bell',19)}</button>` : '';
  return `<header class="bar"><div class="wrap bar-inner"><span class="mark">${icon('inbox',17)}</span><span class="brand">Inbox</span><button class="switcher" data-action="menu" aria-haspopup="dialog" aria-expanded="${menu}"><span class="switcher-machine"><i class="dot ${errors.connection ? 'off' : remote === undefined ? 'wait' : remote ? 'remote' : 'lan'}"></i>${esc(machine || summary?.name || '')}<span class="via">${errors.connection ? t('连不上') : remote === undefined ? t('连接中…') : remote ? t('远程') : t('局域网')}</span></span><span class="switcher-name"><span class="switcher-title">${esc(title)}</span>${icon('down',16)}</span></button><span class="spacer"></span>${bell}${summary?.loggedIn ? `<button class="icon-button" data-action="add-device" title="${t('添加设备')}" aria-label="${t('添加设备')}">${icon('server',18)}</button>` : ''}<button class="icon-button language-button" data-action="language" title="${t('语言')}" aria-label="${t('语言')}">${language === 'zh' ? 'EN' : '中'}</button><button class="icon-button" data-action="theme" title="${t("主题：")}${themeTitle}" aria-label="${t("主题：")}${themeTitle}">${icon({auto:'auto',light:'sun',dark:'moon'}[theme],19)}</button></div></header>`;
}
const skeleton = () => `<main class="board-wrap"><div class="wrap board loading" aria-busy="true">${['lane" id="sec-decide','lane" id="sec-accept','lane side'].map(attr => `<section class="${attr}"><div class="lane-header"><span class="sk sk-title"></span></div><div class="lane-body">${[0,1].map(() => '<div class="card sk-card"><span class="sk sk-line short"></span><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-block"></span></div>').join('')}</div></section>`).join('')}</div></main>`;
function render() {
  if (!data) {
    const state = errors.connection ? `<div class="state">${icon('offline',36)}<h2>${esc(machine)} · ${t("连不上")}</h2><p>${t("offline")}</p><div class="state-actions"><button class="button primary" data-action="reload">${icon('refresh',16)}${t("重试")}</button><button class="button" data-action="menu">${t("切换")} Campaign</button></div></div>`
      : !campaign && summary ? `<div class="state">${icon('inbox',36)}<h2>${t("noCampaign")}</h2><p>${t("registerHint")}</p></div>` : skeleton();
    root.innerHTML = `${header()}${state}${renderMenu()}`;
    return;
  }
  const scrolls = [...document.querySelectorAll('.lane-body')].map(el => el.scrollTop), y = scrollY;
  const focused = document.activeElement?.dataset.note, selection = focused && [document.activeElement.selectionStart,document.activeElement.selectionEnd];
  const sorted = data.items;
  const decisions = sorted.filter(i => i.kind === 'decide' && i.status !== 'closed'), accepts = sorted.filter(i => i.kind === 'accept' && i.status !== 'closed'), closed = sorted.filter(i => i.status === 'closed');
  const n = decisions.filter(i => i.status === 'open').length, a = accepts.filter(i => i.status === 'open').length, b = sorted.filter(i => i.blocking && i.status === 'open').length;
  const count = (value, hot) => `<span class="count num ${hot ? 'hot' : ''} ${value ? '' : 'zero'}">${value}</span>`, unsent = countDrafts();
  root.innerHTML = `${header()}
  <nav class="tabs" aria-label="${t("分区")}"><a href="#sec-decide" class="active">${icon('decide',18)}<span>${t("决定")}</span>${count(n, b)}</a><a href="#sec-accept">${icon('ok',18)}<span>${t("验收")}</span>${count(a)}</a><a href="#sec-message">${icon('message',18)}<span>${t("留言")}</span></a><a href="#sec-progress">${icon('list',18)}<span>${t("进度")}</span></a></nav>
  <main class="board-wrap"><div class="wrap board"><section class="lane" id="sec-decide"><div class="lane-header"><h2>${t("待你决定")}</h2>${count(n, b)}${b ? `<span class="lane-flag">${icon('flag',12)}${t("blockingCount",b)}</span>` : ''}</div><div class="lane-body">${decisions.map(card).join('') || empty(t('都决定完了'), t('有新题会推送提醒你'))}${closed.length ? `<button class="closed-toggle ${closedVisible ? 'expanded' : ''}" data-action="closed" aria-expanded="${closedVisible}"><span>${t("已结案")}</span><span class="num">${closed.length}</span>${icon('down',15)}</button>${closedVisible ? closed.map(card).join('') : ''}` : ''}</div></section><section class="lane" id="sec-accept"><div class="lane-header"><h2>${t("待你验收")}</h2>${count(a)}</div><div class="lane-body">${accepts.map(card).join('') || empty(t('没有待验收的成品'), t('交付到了会推送提醒你'))}</div></section>${side()}</div></main>
  <div class="tray ${unsent ? 'show' : ''}" ${unsent ? '' : 'inert'}><span class="tray-count"><b class="num">${unsent}</b> ${t("项待提交")}</span><button class="tray-clear" data-action="clear-all">${t("清空")}</button><button class="submit" data-action="submit" ${busy || uploading ? 'disabled' : ''}>${icon('send',16)}<span>${busy ? t('提交中…') : uploading ? t('上传中…') : t('提交')}</span></button></div>${renderMenu()}`;
  document.querySelectorAll('.lane-body').forEach((el,i) => el.scrollTop = scrolls[i] || 0);
  scrollTo(0,y);
  document.querySelectorAll('textarea').forEach(grow);
  if (focused) { const el = [...document.querySelectorAll('[data-note]')].find(el => el.dataset.note === focused); if (el) { el.focus({preventScroll:true}); el.setSelectionRange(...selection); } }
  spy();
}
// 按服务端返回的通知结果说清楚，通知失败或没配通知时不承诺编排会收到。
function submitted(n, notify) { return notify === 'failed' ? t('submittedFailed',n) : notify === 'unconfigured' ? t('submittedQuiet',n) : t('submitted',n); }
function grow(el) { el.style.height='auto'; el.style.height=`${Math.min(el.scrollHeight,220)}px`; el.style.overflowY=el.scrollHeight>220?'auto':'hidden'; }
function toast(message, tone = 'info') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = `toast ${tone}`; el.role = tone === 'error' ? 'alert' : 'status';
  el.innerHTML = `${icon({ok:'ok',error:'warn'}[tone] || 'bell',17)}<span>${esc(message)}</span>`;
  el.addEventListener('click', () => el.remove()); document.body.append(el); setTimeout(() => el.remove(), 4500);
}
const pageBase = () => new URL('./', location.href);
async function load() {
  await refreshSummary();
  if ((!campaign && !summary.campaigns.length) || (campaign && !machine && !summary.campaigns.some(c => c.id === campaign))) await refreshSummary(true);
  const machines = [{name:summary.name,campaigns:summary.campaigns}, ...(summary.hub ? summary.peers : [])];
  const selected = machines.find(p => (!machine || p.name === machine) && p.campaigns?.some(c => c.id === campaign))
    || machines.find(p => p.name === machine) || machines.find(p => p.campaigns?.length);
  machine = selected?.name || summary.name;
  campaign ||= selected?.campaigns?.[0]?.id;
  readDrafts(); await refresh();
}
async function refreshSummary(waitPeers = false) {
  summary = await api('api/summary', undefined, pageBase());
  const current = summary;
  const pending = Promise.allSettled(current.peers.map(async p => {
    const base = summary.remote ? machineBase(p.name).href : p.lanUrl;
    try { const response = await fetch(new URL('api/summary',base.replace(/\/?$/,'/')), {signal:AbortSignal.timeout(5000)}); if (!response.ok) throw Error(); const remote = await response.json(); p.campaigns = remote.campaigns; p.url = base; }
    catch { p.unavailable=true; }
    if (summary === current) render();
  }));
  if (waitPeers) await pending;
}
let refreshSequence = 0;
async function refresh() {
  const sequence = ++refreshSequence, selectedMachine = machine, selectedCampaign = campaign;
  const current = () => sequence === refreshSequence && machine === selectedMachine && campaign === selectedCampaign;
  if (campaign) {
    try {
      const result = await api(`api/campaign/${encodeURIComponent(campaign)}`);
      if (!current()) return;
      data = result; delete errors.connection;
    } catch {
      if (!current()) return;
      data = null; errors.connection = `${machine} · ${t("连不上")}`;
    }
  }
  if (!current()) return;
  render(); await refreshSummary(); if (current()) render();
}
async function submit() {
  if (busy || uploading) return;
  errors = {};
  for (const item of targets()) {
    const d = draft(item.id);
    if (item.kind === 'accept' && !d.choices.length) errors[item.id]=t('先选“通过”或“返修”');
    if (item.kind === 'accept' && d.choices[0] === 'rework' && !d.note.trim()) errors[item.id]=t('返修要写说明');
  }
  if (Object.keys(errors).length) { render(); document.getElementById(`item-${Object.keys(errors)[0]}`)?.scrollIntoView({block:'center',behavior:'smooth'}); return; }
  const references = images => images.map(m => typeof m === 'string' ? m : m.path);
  const items = targets().map(i => ({id:i.id,answer:{...draft(i.id),images:references(draft(i.id).images)}})), messages = hasDraft('__message') ? [{note:draft('__message').note,images:references(draft('__message').images)}] : [];
  if (!items.length && !messages.length) return;
  busy=true; render();
  try { const result = await api('api/submit',{campaign,items,messages}); for (const i of items) { delete drafts[i.id]; editing.delete(i.id); } if (messages.length) delete drafts.__message; saveDrafts(); await refresh(); const n = items.length+messages.length; toast(submitted(n, result?.notify), result?.notify === 'failed' ? 'error' : 'ok'); }
  catch (e) { toast(e.message, 'error'); }
  finally { busy=false; render(); }
}
async function addFiles(id, files) {
  const item = data.items.find(i => i.id === id);
  if (item && !isEditing(item)) return;
  uploading++; render();
  try {
    for (const file of files) {
      if (file.size > 20*1024*1024) throw Error(t('单张不能超过 20MB'));
      let output=file;
      if (data.remote) {
        try {
          const bitmap=await createImageBitmap(file), scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height)), canvas=document.createElement('canvas');
          canvas.width=Math.round(bitmap.width*scale); canvas.height=Math.round(bitmap.height*scale); canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
          const blob=await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.85)); if (blob && blob.size < file.size) output=blob;
        } catch { /* HEIC 等浏览器不能解码的格式保留原图，服务端仍检查文件头。 */ }
      }
      const response=await fetch(address(`api/upload/${encodeURIComponent(campaign)}/${encodeURIComponent(id === '__message' ? 'messages' : id)}`),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:output});
      const result=await response.json(); if (!response.ok) throw Error(translateError(language, result.error || '上传失败'));
      draft(id).images.push({...result,size:output.size,originalSize:file.size}); saveDrafts();
    }
  } catch(e) { toast(e.message, 'error'); }
  finally { uploading--; render(); }
}
async function changeItem(id, action) {
  if (busy || uploading) return;
  busy = true; render();
  try {
    await api(`api/item/${encodeURIComponent(campaign)}/${encodeURIComponent(id)}`, {action});
    if (action === 'withdraw') { delete drafts[id]; editing.delete(id); saveDrafts(); }
    await refresh();
    toast(action === 'withdraw' ? t('已撤回，编排会收到撤回通知') : t('已重发通知'), 'ok');
  } finally { busy = false; render(); }
}
async function addDevice() {
  const result = await api('api/add-device', {});
  const el = document.createElement('div'); el.className = 'lightbox device-dialog'; el.role = 'dialog'; el.ariaModal = 'true'; el.ariaLabel = t('添加设备');
  el.innerHTML = `<section class="device-panel"><h2>${t('添加设备')}</h2><p>${t('deviceLinkHelp')}</p><p>${t('deviceLinkPrivacy')}</p><button class="primary" data-copy>${t('复制登录链接')}</button> <button class="link" data-close>${t('关闭')}</button><p role="status"></p></section>`;
  const close = () => { clearTimeout(timer); el.remove(); };
  const timer = setTimeout(close, result.expiresIn * 1000);
  el.querySelector('[data-close]').onclick = close;
  el.querySelector('[data-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(result.url); el.querySelector('[role=status]').textContent = t('deviceLinkCopied'); }
    catch { el.querySelector('[role=status]').textContent = t('deviceLinkSecure'); }
  };
  el.onclick = event => { if (event.target === el) close(); };
  document.body.append(el); el.querySelector('[data-copy]').focus();
}

async function subscribe() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const {publicKey} = await api('api/push-key', undefined, pageBase());
    const key=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),c => c.charCodeAt(0));
    const subscription=await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    pushOn = true;
    await refreshSummary();
    const machines = summary.hub ? [summary.name, ...summary.peers.map(p => p.name)] : [summary.name];
    const results = await Promise.allSettled(machines.map(name => api('api/subscribe', {...subscription.toJSON(), language}, summary.hub ? machineBase(name) : pageBase())));
    const failed = machines.filter((_, i) => results[i].status === 'rejected');
    toast(failed.length ? t('pushFailed',failed.join(', ')) : t('已开启所有机器的推送提醒'), failed.length ? 'error' : 'ok');
  } catch { toast(t('推送没开成，请在浏览器设置里允许通知'), 'error'); }
  render();
}
async function setLanguage(value) {
  language = value; localStorage.setItem('inbox-language', value);
  document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en';
  errors = {}; render();
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({type:'language', language});
    const subscription = await registration.pushManager?.getSubscription();
    if (subscription && summary?.remote) {
      const machines = summary.hub ? [summary.name, ...summary.peers.map(p => p.name)] : [summary.name];
      const results = await Promise.allSettled(machines.map(name => api('api/subscribe', {...subscription.toJSON(), language}, summary.hub ? machineBase(name) : pageBase())));
      const failed = machines.filter((_, index) => results[index].status === 'rejected');
      if (failed.length) toast(t('pushFailed', failed.join(', ')), 'error');
    }
  }
}
document.addEventListener('click',async event => {
  const tab=event.target.closest('.tabs a');
  if(tab){selectedTab=tab.hash;userScroll=false;spy();return;}
  const galleryButton = event.target.closest('[data-gallery]');
  if (galleryButton) { const media=JSON.parse(galleryButton.dataset.media); openLightbox(media,Number(galleryButton.dataset.gallery)); return; }
  const image=event.target.closest('[data-lightbox]'); if (image) { openLightbox([{url:image.dataset.lightbox}],0); return; }
  const button=event.target.closest('[data-action]'); if (!button) return;
  const {action,id,key}=button.dataset, item=data?.items.find(i => i.id===id);
  if (!data && !['language','menu','close-menu','theme','campaign','push','reload','add-device'].includes(action)) return;
  try {
    switch(action) {
      case 'pick': { const d=draft(id), index=d.choices.indexOf(key); if (item.multi) index>=0 ? d.choices.splice(index,1) : d.choices.push(key); else d.choices=index>=0 ? [] : [key]; delete errors[id];saveDrafts();render();break; }
      case 'clear': draft(id).choices=[];saveDrafts();render();break;
      case 'remove-image': draft(id).images.splice(Number(button.dataset.index),1);saveDrafts();render();break;
      case 'edit': drafts[id]={...structuredClone(item.answer),editing:true};editing.add(id);saveDrafts();render();break;
      case 'cancel-edit': delete drafts[id];editing.delete(id);saveDrafts();render();break;
      case 'clear-all': if (confirm(t('清空所有还没提交的选择、留言和图片？'))) { drafts={};editing.clear();saveDrafts();render(); } break;
      case 'withdraw': if (confirm(t('撤回这条答复？题目会回到待答。'))) await changeItem(id, 'withdraw'); break;
      case 'retry': await changeItem(id, 'retry'); break;
      case 'more': expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); break;
      case 'submit': await submit();break;
      case 'language': await setLanguage(language === 'zh' ? 'en' : 'zh'); break;
      case 'theme': theme=({auto:'light',light:'dark',dark:'auto'})[theme];localStorage.setItem('inbox-theme',theme);applyTheme();render();toast(`${t("主题：")}${({auto:t('跟随系统'),light:t('浅色'),dark:t('深色')})[theme]}`);break;
      case 'menu': menu=!menu;render();if(menu){await refreshSummary();render();}break;
      case 'close-menu': menu=false;render();break;
      case 'reload': render();await refresh();break;
      case 'campaign': if (busy || uploading) break; selectedTab=null;userScroll=false;machine=button.dataset.machine; data=null; campaign=id;editing.clear();menu=false;readDrafts();{const url=new URL(location.href);url.searchParams.set('campaign',id);if(summary.hub)url.searchParams.set('machine',machine);history.replaceState(null,'',url);}render();await refresh();scrollTo(0,0);break;
      case 'closed': closedVisible=!closedVisible;render();break;
      case 'push': await subscribe();break;
      case 'add-device': await addDevice(); break;
    }
  } catch(e) { toast(e.message, 'error'); }
});
function openLightbox(media,index) {
  document.querySelector('.lightbox')?.remove();
  const el=document.createElement('div');el.className='lightbox';el.role='dialog';el.ariaLabel=t('查看素材');
  const m=media[index],url=m.url || mediaUrl(m),kind=m.url ? 'image' : mediaKind(m.path);
  el.innerHTML=`<div class="lightbox-bar"><span class="num">${media.length > 1 ? `${index+1} / ${media.length}` : ''}</span><span class="lightbox-caption">${esc(m.caption || '')}</span><button class="close" aria-label="${t("关闭")}">${icon('x',22)}</button></div><div class="lightbox-stage">${kind === 'video' ? `<video controls autoplay src="${esc(url)}"></video>` : kind === 'doc' ? `<article class="lightbox-doc" tabindex="0"><div class="doc-body">${t('加载中…')}</div></article>` : `<img alt="${esc(m.caption || '')}" src="${esc(url)}">`}</div>${media.length>1 ? `<button class="nav previous" aria-label="${t("上一张")}">${icon('left',24)}</button><button class="nav next" aria-label="${t("下一张")}">${icon('right',24)}</button>` : ''}`;
  el.addEventListener('click',e => { if(e.target.closest('.previous')) openLightbox(media,(index+media.length-1)%media.length); else if(e.target.closest('.next')) openLightbox(media,(index+1)%media.length); else if(!e.target.closest('img,video,.lightbox-doc') || e.target.closest('.close')) el.remove(); });
  el.addEventListener('keydown',e => { if(e.key==='ArrowLeft') el.querySelector('.previous')?.click(); if(e.key==='ArrowRight') el.querySelector('.next')?.click(); });
  document.body.append(el);el.querySelector('.close').focus();
  const reader=el.querySelector('.doc-body');
  if (reader) fetch(url).then(r => r.ok ? r.text() : Promise.reject()).then(text => { reader.innerHTML=/\.(md|markdown)$/i.test(m.path) ? markdown(text) : `<pre>${esc(text)}</pre>`; }, () => { reader.textContent=t('文档打不开，请刷新重试。'); });
}
// 手机分区标签跟随滚动高亮；吸顶后加底边。
let selectedTab=null,userScroll=false,navScrollY=scrollY;
function spy() {
  const links=[...document.querySelectorAll('.tabs a')];if(!links.length)return;let current=links[0];
  for(const link of links){if(document.querySelector(link.hash)?.getBoundingClientRect().top<140)current=link;}
  // 滚到底时最后一区够不到顶部，直接算它。
  if(innerHeight+scrollY>=document.documentElement.scrollHeight-2&&scrollY>0)current=links.at(-1);
  // 点击后的锚点滚动可能被页面底部截断，仍以明确选择为准。
  current=links.find(link=>link.hash===selectedTab)||current;
  for(const link of links)link.classList.toggle('active',link===current);
  document.body.classList.toggle('scrolled',scrollY>4);
}
document.addEventListener('keydown',e => {if(e.key==='Escape'){if(document.querySelector('.lightbox')){document.querySelector('.lightbox').remove();return;}if(menu){menu=false;render();}}});
document.addEventListener('input',e => {
  const id=e.target.dataset.note;if(!id)return;draft(id).note=e.target.value;saveDrafts();grow(e.target);
  const tray=document.querySelector('.tray');tray.classList.toggle('show',countDrafts()>0);tray.inert=!countDrafts();tray.querySelector('b').textContent=countDrafts();
  const item=data.items.find(i=>i.id===id);if(item?.kind==='accept')e.target.closest('.composer').classList.toggle('required',draft(id).choices[0]==='rework'&&!draft(id).note.trim());
});
document.addEventListener('change',e=>{if(e.target.dataset.file){addFiles(e.target.dataset.file,[...e.target.files]);e.target.value='';}});
document.addEventListener('paste',e=>{const card=document.activeElement?.closest('[data-card]');if(!card)return;const files=[...e.clipboardData.items].filter(i=>i.kind==='file').map(i=>i.getAsFile());if(files.length){e.preventDefault();addFiles(card.dataset.card,files);}});
document.addEventListener('dragover',e=>{const card=e.target.closest('[data-card]');if(card){e.preventDefault();card.classList.add('drop');}});
document.addEventListener('dragleave',e=>e.target.closest('[data-card]')?.classList.remove('drop'));
document.addEventListener('drop',e=>{const card=e.target.closest('[data-card]');if(card){e.preventDefault();card.classList.remove('drop');addFiles(card.dataset.card,[...e.dataTransfer.files]);}});
addEventListener('wheel',()=>{userScroll=true;},{passive:true});
addEventListener('touchmove',()=>{userScroll=true;},{passive:true});
addEventListener('pointerdown',e=>{if(e.clientX>=document.documentElement.clientWidth)userScroll=true;},{passive:true});
addEventListener('keydown',e=>{
  if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)&&!e.target.closest('input,textarea,select,[contenteditable]'))userScroll=true;
});
addEventListener('scroll',()=>{
  if(scrollY!==navScrollY&&userScroll){selectedTab=null;userScroll=false;}
  navScrollY=scrollY;spy();
},{passive:true});
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(()=>{}); if ('PushManager' in window) navigator.serviceWorker.ready.then(r => { r.active?.postMessage({type:'language', language}); return r.pushManager.getSubscription(); }).then(s => { pushOn = !!s; if (data) render(); }).catch(()=>{}); }
render();
load().then(()=>{if(location.hash)document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({block:'center'});}).catch(e=>{root.innerHTML=`${header()}<div class="state" role="alert">${icon('warn',36)}<h2>Inbox ${t("打不开")}</h2><p>${esc(e.message)} ${t("请刷新重试。")}</p></div>`;});
setInterval(()=>{if(data&&!busy&&!uploading&&!menu&&!document.activeElement?.matches('textarea'))refresh().catch(()=>{});},30000);
