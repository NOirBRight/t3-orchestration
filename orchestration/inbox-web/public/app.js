import { translateError } from './i18n.js';
import { state, t } from './state.js';
import { esc, icon } from './icons.js';
import { draft, hasDraft, isEditing, readDrafts, saveDrafts, carryDrafts, countDrafts, targets } from './drafts.js';
import { address, api, machineBase, pageBase } from './api.js';
import { render, header, applyTheme, spy, submitted, grow } from './render.js';
import { toast, openLightbox, setUrl, guard, overlay } from './ui.js';
import { closeRouting, loadRoutingData, routingAction, routingChange, routingChanges } from './routing.js';
import { tabHref, itemTab } from './tabs.js';
import { loadKanban, resetKanban, closeKanban, kanbanAction, kanbanChange, boardShown } from './kanban.js';

// 返回键、Esc 一层层退：大图、菜单、看板抽屉和面板、派票设置；只有返回键最后再从别的 tab 回到决定页。
function closeOverlay(back = false) { const box = document.querySelector('.lightbox'); if (box) { box.remove(); return true; } if (state.menu || state.settings) { state.menu = false; state.settings = false; render(); return true; } if (closeKanban()) return true; if (state.view === 'routing') { closeRouting(); kanbanAfterRouting(); return true; } if (back && state.tab !== 'decide') { switchTab('decide'); return true; } return false; }
// 从派票设置回到进度 tab 时，看板可能还没加载过。
function kanbanAfterRouting() { if (boardShown() && !state.kanban.board) loadKanban(); }
// 换 tab 只改地址不加历史；每个 tab 记住自己的滚动位置，进度 tab 每次进来刷新看板。
function switchTab(tab) {
  if (tab !== state.tab) { state.tabScroll[state.tab] = scrollY; state.tab = tab; }
  setUrl(tabHref(location.href, tab)); render(); scrollTo(0, state.tabScroll[tab] || 0); spy();
  if (tab === 'progress') loadKanban();
}
// 通知深链、提交报错和看板里的“去确认”都切到题目所在的 tab 再定位。
function showItem(id) {
  const item = state.data?.items.find(i => i.id === id);
  if (!item) return;
  if (item.status === 'closed') state.closedVisible = true;
  state.tabScroll[itemTab(item)] = 0; switchTab(itemTab(item));
  document.getElementById(`item-${id}`)?.scrollIntoView({block:'center'});
}

async function load() {
  await refreshSummary();
  if ((!state.campaign && !state.summary.campaigns.length) || (state.campaign && !state.machine && !state.summary.campaigns.some(c => c.id === state.campaign))) await refreshSummary(true);
  const machines = [{name:state.summary.name,campaigns:state.summary.campaigns}, ...(state.summary.hub ? state.summary.peers : [])];
  const selected = machines.find(p => (!state.machine || p.name === state.machine) && p.campaigns?.some(c => c.id === state.campaign))
    || machines.find(p => p.name === state.machine) || machines.find(p => p.campaigns?.length);
  state.machine = selected?.name || state.summary.name;
  state.campaign ||= selected?.campaigns?.[0]?.id;
  readDrafts(); await refresh();
  consumeRemoveParam();
  if (state.view === 'routing') await loadRoutingData();
}
async function refreshSummary(waitPeers = false) {
  state.summary = await api('api/summary', undefined, pageBase());
  const current = state.summary;
  const pending = Promise.allSettled(current.peers.map(async p => {
    const base = state.summary.remote ? machineBase(p.name).href : p.lanUrl;
    try { const response = await fetch(new URL('api/summary',base.replace(/\/?$/,'/')), {signal:AbortSignal.timeout(5000)}); if (!response.ok) throw Error(); const remote = await response.json(); p.campaigns = remote.campaigns; p.url = base; }
    catch { p.unavailable=true; }
    if (state.summary === current) render();
  }));
  if (waitPeers) await pending;
}
async function refresh() {
  const sequence = ++state.refreshSequence, selectedMachine = state.machine, selectedCampaign = state.campaign;
  const current = () => sequence === state.refreshSequence && state.machine === selectedMachine && state.campaign === selectedCampaign;
  if (state.campaign) {
    try {
      const result = await api(`api/campaign/${encodeURIComponent(state.campaign)}`);
      if (!current()) return;
      state.data = result; delete state.errors.connection; carryDrafts();
    } catch {
      if (!current()) return;
      state.data = null; state.errors.connection = `${state.machine} · ${t("连不上")}`;
    }
  }
  if (!current()) return;
  render(); if (boardShown()) loadKanban();
  await refreshSummary(); if (current()) render();
}
async function submit() {
  if (state.busy || state.uploading) return;
  state.errors = {};
  for (const item of targets()) {
    const d = draft(item.id);
    if (item.kind === 'accept' && !d.choices.length) state.errors[item.id]=t('先选“通过”或“返修”');
    if (item.kind === 'accept' && d.choices[0] === 'rework' && !d.note.trim()) state.errors[item.id]=t('返修要写说明');
  }
  if (Object.keys(state.errors).length) { showItem(Object.keys(state.errors)[0]); return; }
  const references = images => images.map(m => typeof m === 'string' ? m : m.path);
  const items = targets().map(i => ({id:i.id,answer:{...draft(i.id),images:references(draft(i.id).images)}})), messages = hasDraft('__message') ? [{note:draft('__message').note,images:references(draft('__message').images)}] : [];
  if (!items.length && !messages.length) return;
  const sentDrafts = new Map([...items.map(i => i.id), ...(messages.length ? ['__message'] : [])].map(id => [id, JSON.stringify(state.drafts[id])]));
  state.busy=true; render();
  try { const result = await api('api/submit',{campaign: state.campaign,items,messages}); for (const [id, sent] of sentDrafts) { if (JSON.stringify(state.drafts[id]) === sent) { delete state.drafts[id]; state.editing.delete(id); } else if (state.drafts[id]) state.editing.add(id); } saveDrafts(); await refresh(); const n = items.length+messages.length; toast(submitted(n, result?.notify), result?.notify === 'failed' ? 'error' : 'ok'); }
  catch (e) { toast(e.message, 'error'); refresh().catch(()=>{}); }
  finally { state.busy=false; render(); }
}
async function addFiles(id, files) {
  const item = state.data.items.find(i => i.id === id);
  if (item && !isEditing(item)) return;
  state.uploading++; render();
  try {
    for (const file of files) {
      if (file.size > 20*1024*1024) throw Error(t('单张不能超过 20MB'));
      let output=file;
      if (state.data.remote) {
        try {
          const bitmap=await createImageBitmap(file), scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height)), canvas=document.createElement('canvas');
          canvas.width=Math.round(bitmap.width*scale); canvas.height=Math.round(bitmap.height*scale); canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
          const blob=await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.85)); if (blob && blob.size < file.size) output=blob;
        } catch { /* HEIC 等浏览器不能解码的格式保留原图，服务端仍检查文件头。 */ }
      }
      const response=await fetch(address(`api/upload/${encodeURIComponent(state.campaign)}/${encodeURIComponent(id === '__message' ? 'messages' : id)}`),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:output});
      const result=await response.json(); if (!response.ok) throw Error(translateError(state.language, result.error || '上传失败'));
      draft(id).images.push({...result,size:output.size,originalSize:file.size}); saveDrafts();
    }
  } catch(e) { toast(e.message, 'error'); }
  finally { state.uploading--; render(); }
}
async function changeItem(id, action) {
  if (state.busy || state.uploading) return;
  state.busy = true; render();
  try {
    await api(`api/item/${encodeURIComponent(state.campaign)}/${encodeURIComponent(id)}`, {action});
    if (action === 'withdraw') { delete state.drafts[id]; state.editing.delete(id); saveDrafts(); }
    await refresh();
    toast(action === 'withdraw' ? t('已撤回，编排会收到撤回通知') : t('已重发通知'), 'ok');
  } finally { state.busy = false; render(); }
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
  overlay(); document.body.append(el); el.querySelector('[data-copy]').focus();
}
function consumeRemoveParam() {
  const url = new URL(location.href);
  const id = url.searchParams.get('remove');
  if (!id || !state.summary) return;
  url.searchParams.delete('remove');
  setUrl(url);
  const entry = state.summary.campaigns.find(c => c.id === id);
  if (!entry) { toast(t('removeMissing'), 'error'); return; }
  if (!state.summary.canManage) { toast(t('removeNeedManage'), 'error'); return; }
  if (typeof entry.removable !== 'boolean') { toast(t('removeUnread'), 'error'); return; }
  if (!entry.removable) { toast(t('removeBlocked'), 'error'); return; }
  confirmRemoval(state.summary.name, id, entry);
}
function confirmRemoval(name, id, known) {
  if (state.busy || state.uploading) return;
  const entry = known || (name === state.summary.name ? state.summary.campaigns : state.summary.peers.find(p => p.name === name)?.campaigns)?.find(c => c.id === id);
  if (!entry?.removable) return;
  state.menu = false; render();
  const el = document.createElement('div'); el.className = 'lightbox device-dialog'; el.role = 'dialog'; el.ariaModal = 'true'; el.ariaLabel = t('removeCampaign');
  el.innerHTML = `<section class="device-panel"><h2>${t('removeCampaign')}</h2><p>${esc(name)} · ${esc(entry.title)}</p><p>${esc(t('removeHelp'))}</p><button class="primary" data-confirm>${t('移除')}</button> <button class="link" data-close>${t('取消')}</button><p role="status"></p></section>`;
  const close = () => { if (!state.busy) el.remove(); };
  el.querySelector('[data-close]').onclick = close;
  el.onclick = event => { if (event.target === el) close(); };
  el.onkeydown = event => { if (event.key === 'Escape') close(); };
  overlay();
  el.querySelector('[data-confirm]').onclick = async () => {
    if (state.busy) return;
    state.busy = true; el.querySelector('[data-confirm]').disabled = true;
    try {
      const result = await api('api/remove-campaign', {campaign:id}, state.summary.hub ? machineBase(name) : undefined);
      if (state.machine === name && state.campaign === id) {
        ++state.refreshSequence; state.campaign = null; state.data = null; state.drafts = {}; state.editing.clear(); state.errors = {};
        const url = new URL(location.href); url.searchParams.delete('campaign'); url.searchParams.delete('machine'); setUrl(url);
      }
      el.remove(); await load();
      toast(t(result.notify === 'failed' ? 'removedFailed' : result.notify === 'unconfigured' ? 'removedQuiet' : 'removed'), result.notify === 'failed' ? 'error' : 'ok');
    } catch (error) { el.querySelector('[role=status]').textContent = error.message; }
    finally { state.busy = false; el.querySelector('[data-confirm]').disabled = false; render(); }
  };
  document.body.append(el); el.querySelector('[data-close]').focus();
}
async function subscribe() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const {publicKey} = await api('api/push-key', undefined, pageBase());
    const key=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),c => c.charCodeAt(0));
    const subscription=await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    state.pushOn = true;
    await refreshSummary();
    const machines = state.summary.hub ? [state.summary.name, ...state.summary.peers.map(p => p.name)] : [state.summary.name];
    const results = await Promise.allSettled(machines.map(name => api('api/subscribe', {...subscription.toJSON(), language: state.language}, state.summary.hub ? machineBase(name) : pageBase())));
    const failed = machines.filter((_, i) => results[i].status === 'rejected');
    toast(failed.length ? t('pushFailed',failed.join(', ')) : t('已开启所有机器的推送提醒'), failed.length ? 'error' : 'ok');
  } catch { toast(t('推送没开成，请在浏览器设置里允许通知'), 'error'); }
  render();
}
async function setLanguage(value) {
  state.language = value; localStorage.setItem('inbox-language', value);
  document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en';
  state.errors = {}; render();
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({type:'language', language: state.language});
    const subscription = await registration.pushManager?.getSubscription();
    if (subscription && state.summary?.remote) {
      const machines = state.summary.hub ? [state.summary.name, ...state.summary.peers.map(p => p.name)] : [state.summary.name];
      const results = await Promise.allSettled(machines.map(name => api('api/subscribe', {...subscription.toJSON(), language: state.language}, state.summary.hub ? machineBase(name) : pageBase())));
      const failed = machines.filter((_, index) => results[index].status === 'rejected');
      if (failed.length) toast(t('pushFailed', failed.join(', ')), 'error');
    }
  }
}
document.addEventListener('click',async event => {
  guard();
  // 点在看板下拉菜单外就收起菜单。
  if (state.kanban.pop && !event.target.closest('.kb-pop')) { state.kanban.pop = null; if (!event.target.closest('[data-action],[data-tab]')) render(); }
  const tab=event.target.closest('[data-tab]');
  // 带修饰键或中键点开时交给浏览器，新标签打开同一 tab。
  if(tab){if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button)return;event.preventDefault();if(tab.dataset.tab===state.tab){scrollTo(0,0);return;}switchTab(tab.dataset.tab);return;}
  const anchor=event.target.closest('.tabs a[href^="#"]');
  // 派票设置的分区跳转只换地址不加历史，返回键留给浮层和退出确认。
  if(anchor){event.preventDefault();document.querySelector(anchor.hash)?.scrollIntoView();setUrl(anchor.hash);state.selectedTab=anchor.hash;state.userScroll=false;spy();return;}
  const galleryButton = event.target.closest('[data-gallery]');
  if (galleryButton) { const media=JSON.parse(galleryButton.dataset.media); openLightbox(media,Number(galleryButton.dataset.gallery)); return; }
  const image=event.target.closest('[data-lightbox]'); if (image) { openLightbox([{url:image.dataset.lightbox}],0); return; }
  const button=event.target.closest('[data-action]'); if (!button) return;
  const {action,id,key}=button.dataset, item=state.data?.items.find(i => i.id===id);
  if (action.startsWith('rt-')) { try { await routingAction(action, button); kanbanAfterRouting(); } catch(e) { toast(e.message, 'error'); } return; }
  if (action === 'kb-goto') { state.kanban.drawer = null; render(); showItem(id); return; }
  // 提示条跳到第一张等你确认的票名下的题。
  if (action === 'kb-owner') { const first = state.kanban.board?.tickets.flatMap(ticket => ticket.ownerItems || []).find(owned => state.data?.items.some(i => i.id === owned.id)); if (first) showItem(first.id); else switchTab('decide'); return; }
  if (action.startsWith('kb-')) { kanbanAction(action, button); return; }
  if (!state.data && !['language','menu','close-menu','theme','campaign','push','reload','add-device','remove-campaign','settings'].includes(action)) return;
  try {
    switch(action) {
      case 'pick': { const d=draft(id), index=d.choices.indexOf(key); if (item.multi) index>=0 ? d.choices.splice(index,1) : d.choices.push(key); else d.choices=index>=0 ? [] : [key]; delete state.errors[id];saveDrafts();render();break; }
      case 'clear': draft(id).choices=[];saveDrafts();render();break;
      case 'remove-image': draft(id).images.splice(Number(button.dataset.index),1);saveDrafts();render();break;
      case 'edit': state.drafts[id]={...structuredClone(item.answer),editing:true};state.editing.add(id);saveDrafts();render();break;
      case 'cancel-edit': delete state.drafts[id];state.editing.delete(id);saveDrafts();render();break;
      case 'clear-all': if (confirm(t('清空所有还没提交的选择、留言和图片？'))) { state.drafts={};state.editing.clear();saveDrafts();render(); } break;
      case 'withdraw': if (confirm(t('撤回这条答复？题目会回到待答。'))) await changeItem(id, 'withdraw'); break;
      case 'retry': await changeItem(id, 'retry'); break;
      case 'more': state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); render(); break;
      case 'submit': await submit();break;
      case 'language': await setLanguage(state.language === 'zh' ? 'en' : 'zh'); break;
      case 'theme': state.theme=({auto:'light',light:'dark',dark:'auto'})[state.theme];localStorage.setItem('inbox-theme',state.theme);applyTheme();render();toast(`${t("主题：")}${({auto:t('跟随系统'),light:t('浅色'),dark:t('深色')})[state.theme]}`);break;
      case 'menu': state.menu=!state.menu;if(state.menu)overlay();render();if(state.menu){await refreshSummary();render();}break;
      case 'close-menu': state.menu=false;state.settings=false;render();break;
      case 'settings': state.settings=true;state.menu=false;overlay();render();break;
      case 'reload': render();await refresh();break;
      case 'campaign': if (state.busy || state.uploading) break; if (state.view==='routing' && state.routing && routingChanges(state.routing) && !confirm(t('rtDiscard'))) break; state.machine=button.dataset.machine;resetKanban();state.tabScroll={}; state.data=null; state.campaign=id;state.editing.clear();state.menu=false;readDrafts();{const url=new URL(location.href);url.searchParams.set('campaign',id);if(state.summary.hub)url.searchParams.set('machine',state.machine);setUrl(url);}render();await refresh();if(state.view==='routing')await loadRoutingData();else scrollTo(0,0);break;
      case 'closed': state.closedVisible=!state.closedVisible;render();break;
      case 'push': state.settings=false;render();await subscribe();break;
      case 'add-device': state.settings=false;render();await addDevice(); break;
      case 'remove-campaign': confirmRemoval(button.dataset.machine, id); break;
    }
  } catch(e) { toast(e.message, 'error'); }
});
addEventListener('popstate',e=>{
  if(location.href!==state.pageUrl)history.replaceState(e.state,'',state.pageUrl);
  if(e.state?.inbox==='overlay')return;
  // 浮层已用关闭按钮关掉时，守卫上面还留着它的条目；这次返回直接当作主页返回。
  if(e.state?.inbox==='guard'){if(!closeOverlay(true))history.back();return;}
  state.guarded=false;
  // 退回主页时关掉一层就重新挂上守卫，离开前仍要再按一次。
  if(closeOverlay(true))guard();else toast(t('backAgain'));
});
document.addEventListener('keydown',e => {if(e.key==='Escape')closeOverlay();});
document.addEventListener('input',e => {
  const id=e.target.dataset.note;if(!id)return;draft(id).note=e.target.value;saveDrafts();grow(e.target);
  const tray=document.querySelector('.tray');tray.classList.toggle('show',countDrafts()>0);tray.inert=!countDrafts();tray.querySelector('b').textContent=countDrafts();
  const item=state.data.items.find(i=>i.id===id);if(item?.kind==='accept')e.target.closest('.composer').classList.toggle('required',draft(id).choices[0]==='rework'&&!draft(id).note.trim());
});
document.addEventListener('change',e=>{if(e.target.matches('[data-rt-field]'))routingChange(e.target);if(e.target.matches('[data-kb-field]'))kanbanChange(e.target);if(e.target.dataset.file){addFiles(e.target.dataset.file,[...e.target.files]);e.target.value='';}});
document.addEventListener('paste',e=>{const card=document.activeElement?.closest('[data-card]');if(!card)return;const files=[...e.clipboardData.items].filter(i=>i.kind==='file').map(i=>i.getAsFile());if(files.length){e.preventDefault();addFiles(card.dataset.card,files);}});
document.addEventListener('dragover',e=>{const card=e.target.closest('[data-card]');if(card){e.preventDefault();card.classList.add('drop');}});
document.addEventListener('dragleave',e=>e.target.closest('[data-card]')?.classList.remove('drop'));
document.addEventListener('drop',e=>{const card=e.target.closest('[data-card]');if(card){e.preventDefault();card.classList.remove('drop');addFiles(card.dataset.card,[...e.dataTransfer.files]);}});
addEventListener('wheel',()=>{state.userScroll=true;},{passive:true});
addEventListener('touchmove',()=>{state.userScroll=true;},{passive:true});
addEventListener('pointerdown',e=>{if(e.clientX>=document.documentElement.clientWidth)state.userScroll=true;},{passive:true});
addEventListener('keydown',e=>{
  if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)&&!e.target.closest('input,textarea,select,[contenteditable]'))state.userScroll=true;
});
addEventListener('scroll',()=>{
  if(scrollY!==state.navScrollY&&state.userScroll){state.selectedTab=null;state.userScroll=false;}
  state.navScrollY=scrollY;spy();
},{passive:true});
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(()=>{}); if ('PushManager' in window) navigator.serviceWorker.ready.then(r => { r.active?.postMessage({type:'language', language: state.language}); return r.pushManager.getSubscription(); }).then(s => { state.pushOn = !!s; if (state.data) render(); }).catch(()=>{}); }
render();
load().then(()=>{const hash=decodeURIComponent(location.hash.slice(1));if(hash.startsWith('item-'))showItem(hash.slice(5));}).catch(e=>{state.root.innerHTML=`${header()}<div class="state" role="alert">${icon('warn',36)}<h2>Inbox ${t("打不开")}</h2><p>${esc(e.message)} ${t("请刷新重试。")}</p></div>`;});
setInterval(()=>{if(state.data&&state.view!=='routing'&&!state.busy&&!state.uploading&&!state.menu&&!state.kanban.drawer&&!state.kanban.sheet&&!document.activeElement?.matches('textarea'))refresh().catch(()=>{});},30000);
