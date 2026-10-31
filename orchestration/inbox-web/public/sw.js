// 不缓存问答和媒体，避免退出或改答后读到旧数据。基线就没有 app shell 预缓存清单，拆模块后仍不预缓存。
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
const languageKey=new URL('__inbox_language__',self.registration.scope).href;
const normalizeLanguage=value=>String(value || '').toLowerCase().startsWith('zh')?'zh':'en';
async function preferredLanguage(){
  try{const saved=await(await caches.open('inbox-preferences')).match(languageKey);if(saved)return normalizeLanguage(await saved.text());}catch{}
  return normalizeLanguage(self.navigator?.language);
}
self.addEventListener('message',event=>{
  if(event.data?.type!=='language' || !['zh','en'].includes(event.data.language))return;
  event.waitUntil(caches.open('inbox-preferences').then(cache=>cache.put(languageKey,new Response(event.data.language))).catch(()=>{}));
});
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
  let payload={};try{payload=event.data?.json() || {};}catch{}
  let proposed;try{proposed=payload.url && new URL(payload.url,self.registration.scope);}catch{}
  const target=proposed && proposed.origin === self.location.origin && (proposed.pathname === '/' || proposed.href.startsWith(self.registration.scope)) ? proposed : new URL('./',self.registration.scope);
  if(payload.campaign)target.searchParams.set('campaign',payload.campaign);
  if(payload.id)target.hash=`item-${payload.id}`;
  else if(target.hash){let id=target.hash.slice(1);try{id=decodeURIComponent(id);}catch{}target.hash=`item-${id}`;}
  const language=['zh','en'].includes(payload.language)?payload.language:await preferredLanguage();
  await self.registration.showNotification(payload.title || (language==='zh'?'Inbox 有新事项':'New items in Inbox'),{body:payload.body || (language==='zh'?'打开 Inbox 查看':'Open Inbox to view'),icon:'icon-192.png',badge:'icon-192.png',tag:payload.tag || undefined,data:{url:target.href}});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url || './',self.registration.scope);
  if(target.origin!==self.location.origin)return;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{
    const existing=windows.find(w=>w.url.startsWith(self.registration.scope));
    if(existing){await existing.navigate(target.href);return existing.focus();}
    return self.clients.openWindow(target.href);
  }));
});
