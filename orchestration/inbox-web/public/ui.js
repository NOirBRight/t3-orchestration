import { state, t } from './state.js';
import { esc, icon } from './icons.js';
import { markdown, mediaKind } from './format.js';
import { mediaUrl } from './api.js';

export let toast = function toast(message, tone = 'info') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = `toast ${tone}`; el.role = tone === 'error' ? 'alert' : 'status';
  el.innerHTML = `${icon({ok:'ok',error:'warn'}[tone] || 'bell',17)}<span>${esc(message)}</span>`;
  el.addEventListener('click', () => el.remove()); document.body.append(el); setTimeout(() => el.remove(), 4500);
}
export function openLightbox(media,index) {
  document.querySelector('.lightbox')?.remove(); overlay();
  const el=document.createElement('div');el.className='lightbox';el.role='dialog';el.ariaLabel=t('查看素材');
  const m=media[index],url=m.url || mediaUrl(m),kind=m.url ? 'image' : mediaKind(m.path);
  el.innerHTML=`<div class="lightbox-bar"><span class="num">${media.length > 1 ? `${index+1} / ${media.length}` : ''}</span><span class="lightbox-caption">${esc(m.caption || '')}</span><button class="close" aria-label="${t("关闭")}">${icon('x',22)}</button></div><div class="lightbox-stage">${kind === 'video' ? `<video controls autoplay src="${esc(url)}"></video>` : kind === 'doc' ? `<article class="lightbox-doc" tabindex="0"><div class="doc-body">${t('加载中…')}</div></article>` : `<img alt="${esc(m.caption || '')}" src="${esc(url)}">`}</div>${media.length>1 ? `<button class="nav previous" aria-label="${t("上一张")}">${icon('left',24)}</button><button class="nav next" aria-label="${t("下一张")}">${icon('right',24)}</button>` : ''}`;
  el.addEventListener('click',e => { if(e.target.closest('.previous')) openLightbox(media,(index+media.length-1)%media.length); else if(e.target.closest('.next')) openLightbox(media,(index+1)%media.length); else if(!e.target.closest('img,video,.lightbox-doc') || e.target.closest('.close')) el.remove(); });
  el.addEventListener('keydown',e => { if(e.key==='ArrowLeft') el.querySelector('.previous')?.click(); if(e.key==='ArrowRight') el.querySelector('.next')?.click(); });
  document.body.append(el);el.querySelector('.close').focus();
  const reader=el.querySelector('.doc-body');
  if (reader) fetch(url).then(r => r.ok ? r.text() : Promise.reject()).then(text => { reader.innerHTML=/\.(md|markdown)$/i.test(m.path) ? markdown(text) : `<pre>${esc(text)}</pre>`; }, () => { reader.textContent=t('文档打不开，请刷新重试。'); });
}
export function setUrl(url){history.replaceState(history.state,'',url);state.pageUrl=location.href;}
export function guard(){if(!state.guarded){history.pushState({inbox:'guard'},'',state.pageUrl);state.guarded=true;}}
export function overlay(){guard();if(history.state?.inbox!=='overlay')history.pushState({inbox:'overlay'},'',state.pageUrl);}
