import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { createECDH, randomBytes } from 'node:crypto';
import { loadConfig, saveConfig } from '../config.mjs';
import { Access } from '../access.mjs';
import { PushService } from '../push.mjs';
import { createInboxServer } from '../server.mjs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function frontend(base, cookie, calls) {
  const key = createECDH('prime256v1'); key.generateKeys();
  const subscription = {endpoint:'https://fcm.googleapis.com/shared',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
  const handlers = {};
  const context = vm.createContext({
    URL, AbortSignal, Uint8Array, atob, Promise, setTimeout, clearTimeout, scrollY: 0,
    addEventListener(){}, scrollTo(){}, confirm:()=>true, history:{replaceState(){}}, handlers,
    location: {href:`${base}/?machine=workstation-b&campaign=demo`},
    document:{getElementById:()=>({}),documentElement:{dataset:{}},querySelector:()=>null,addEventListener:(name,handler)=>{handlers[name]=handler;}},
    matchMedia:()=>({matches:false,addEventListener(){}}),
    localStorage:{getItem(){return null;},setItem(){}},
    navigator:{language:'zh-CN',serviceWorker:{ready:Promise.resolve({pushManager:{getSubscription:async()=>null,subscribe:async()=>({toJSON:()=>subscription})}})}},
    fetch:async(url, options={})=>{calls.push(new URL(url).pathname); return fetch(url,{...options,headers:{...options.headers,cookie}});},
  });
  vm.runInContext(fs.readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8').replaceAll('export ', ''),context);
  vm.runInContext(source.replace(/^import .*;\r?\n/, '').slice(0,source.replace(/^import .*;\r?\n/, '').lastIndexOf("if ('serviceWorker' in navigator)")),context);
  vm.runInContext('render = () => {}; toast = message => { globalThis.notice = message; };',context);
  return context;
}

test('双机反代：hub/机器路径、一次登录、跨机答复与一次订阅双机推送', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'inbox-hub-'));
  const servers = [], pushes = [], sent = [];
  let proxy;
  t.after(async()=>{if(proxy)await new Promise(r=>proxy.close(r));await Promise.all(servers.map(s=>s.stop()));fs.rmSync(home,{recursive:true,force:true});});
  for (const name of ['workstation-a','workstation-b']) {
    const config=loadConfig({home:path.join(home,name)});
    Object.assign(config,{name,port:0,remotePort:0,remote:{type:'none',publicUrl:`https://inbox.example.test/${name}/`},peers:[{name:name==='workstation-a'?'workstation-b':'workstation-a'}]});
    const dir=path.join(home,name,'campaign');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'campaign.json'),JSON.stringify({id:'demo',title:name}));
    config.campaigns=[{id:'demo',title:name,dir}];saveConfig(config);
    if(servers.length)for(const file of ['remote-token','cookie-key','vapid.json'])fs.copyFileSync(path.join(servers[0].config.privateDir,file),path.join(config.privateDir,file));
    const push=new PushService({privateDir:config.privateDir,publicUrl:config.remote.publicUrl,machine:name,fetchImpl:async(url,options)=>{sent.push({name,url,options});return new Response(null,{status:201});}});
    const server=await createInboxServer({config,push});await server.start();servers.push(server);pushes.push(push);
    server.store.ask('demo',{kind:'decide',title:name,ticket:'#4',askerThreadId:'test',askerLabel:'test',options:[{key:'a',label:'甲'}]});
  }
  let rootMachine=0;
  proxy=http.createServer((req,res)=>{
    const parsed=new URL(req.url,'http://proxy');const match=/^\/(workstation-a|workstation-b)\//.exec(parsed.pathname);
    const index=match?['workstation-a','workstation-b'].indexOf(match[1]):rootMachine;
    const upstream=http.request({host:'127.0.0.1',port:servers[index].health().remotePort,path:match?req.url.slice(match[0].length-1):req.url,method:req.method,headers:{...req.headers,'x-inbox-hub':match?'0':'1'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${proxy.address().port}`;
  const token=new Access(servers[0].config.privateDir).token;
  const login=await fetch(`${base}/?k=${token}&campaign=demo`,{redirect:'manual'});
  assert.equal(login.status,302);assert.equal(login.headers.get('location'),'/?campaign=demo');assert.match(login.headers.get('set-cookie'),/Path=\/$/);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/workstation-b/api/summary',{headers:{cookie:`inbox_session=old-invalid; ${cookie}`}})).status,200);
  for(const route of ['/api/summary','/workstation-a/api/summary','/workstation-b/api/summary']){
    const response=await fetch(base+route,{headers:{cookie}});assert.equal(response.status,200);assert.equal((await response.json()).hub,route==='/api/summary');
  }
  assert.equal((await (await fetch(base+'/api/summary',{headers:{cookie,'x-inbox-hub':'1'}})).json()).remote,true);
  for(const file of ['','manifest.webmanifest','sw.js','icon-192.png','icon-512.png'])assert.equal((await fetch(base+'/'+file,{headers:{cookie}})).status,200);
  const manifest=await (await fetch(base+'/manifest.webmanifest',{headers:{cookie}})).json();assert.equal(new URL(manifest.scope,base+'/manifest.webmanifest').pathname,'/');
  const calls=[],context=frontend(base,cookie,calls);
  await vm.runInContext('load();',context);
  await vm.runInContext('refreshSummary(true)',context);
  assert.equal(vm.runInContext('machine',context),'workstation-b');
  assert.equal(vm.runInContext('summary.peers[0].campaigns[0].id',context),'demo');
  assert.equal(vm.runInContext('data.campaign.title',context),'workstation-b');
  assert.equal(vm.runInContext('draftKey()',context),'inbox-drafts:workstation-b:demo');
  const originalFetch=context.fetch;
  let release, started;
  const requested=new Promise(resolve=>{started=resolve;});
  const delayed=new Promise(resolve=>{release=resolve;});
  context.fetch=async(url,options)=>{if(new URL(url).pathname==='/workstation-a/api/campaign/demo'){started();await delayed;}return originalFetch(url,options);};
  const stale=vm.runInContext("machine='workstation-a'; refresh()",context);
  await requested;
  await vm.runInContext("machine='workstation-b'; data=null; refresh()",context);
  release();await stale;
  assert.equal(vm.runInContext('data.campaign.title',context),'workstation-b');
  context.fetch=originalFetch;
  vm.runInContext("drafts = {Q1:{choices:['a'],note:'来自 hub',images:[]}}",context);
  await vm.runInContext('submit()',context);
  assert.ok(calls.includes('/workstation-b/api/submit'));
  assert.equal(servers[1].store.pending('demo').items[0].answer.note,'来自 hub');assert.equal(servers[0].store.pending('demo').items.length,0);
  // 切换时立即撤掉旧卡片，加载完成前即使旧事件已入队也不能撤回同号题。
  servers[0].store.submit('demo',[{id:'Q1',answer:{choices:['a'],note:'Workstation A 原答案'}}]);
  await vm.runInContext("machine='workstation-a'; refresh()",context);
  let openGate, requestStarted;
  const gate=new Promise(resolve=>{openGate=resolve;});
  const switching=new Promise(resolve=>{requestStarted=resolve;});
  context.fetch=async(url,options)=>{if(new URL(url).pathname==='/workstation-b/api/campaign/demo'){requestStarted();await gate;}return originalFetch(url,options);};
  const click=dataset=>context.handlers.click({target:{closest:selector=>selector==='[data-action]'?{dataset}:null}});
  const switchTask=click({action:'campaign',machine:'workstation-b',id:'demo'});
  await switching;
  const withdrawTask=click({action:'withdraw',id:'Q1'});
  openGate();await Promise.all([switchTask,withdrawTask]);
  context.fetch=originalFetch;
  assert.ok(!calls.includes('/workstation-b/api/item/demo/Q1'));
  assert.equal(servers[1].store.pending('demo').items[0].answer.note,'来自 hub');
  // 已发出的撤回完成前不能切换，避免回包清掉另一机草稿。
  let finishItem, itemStarted;
  const itemGate=new Promise(resolve=>{finishItem=resolve;});
  const itemRequest=new Promise(resolve=>{itemStarted=resolve;});
  context.fetch=async(url,options)=>{if(new URL(url).pathname==='/workstation-b/api/item/demo/Q1'){itemStarted();await itemGate;}return originalFetch(url,options);};
  const changing=click({action:'withdraw',id:'Q1'});
  await itemRequest;
  await click({action:'campaign',machine:'workstation-a',id:'demo'});
  assert.equal(vm.runInContext('machine',context),'workstation-b');
  finishItem();await changing;context.fetch=originalFetch;
  await vm.runInContext('subscribe()',context);
  assert.match(context.notice,/所有机器/);
  assert.ok(calls.includes('/workstation-a/api/subscribe'));assert.ok(calls.includes('/workstation-b/api/subscribe'));
  for(const push of pushes){assert.equal(push.subscriptions.length,1);await push.enqueue({campaign:'demo',id:'Q1',title:'题',blocking:true});}
  assert.equal(sent.length,2);assert.equal(pushes[0].subscriptions[0].endpoint,pushes[1].subscriptions[0].endpoint);
  assert.equal(pushes[1].location({campaign:'demo',id:'Q1'}).url,'https://inbox.example.test/?machine=workstation-b&campaign=demo#Q1');
  rootMachine=1;assert.equal((await (await fetch(base+'/api/summary',{headers:{cookie}})).json()).name,'workstation-b');
  new Access(servers[0].config.privateDir).rotate();
  for(const file of ['remote-token','cookie-key'])fs.copyFileSync(path.join(servers[0].config.privateDir,file),path.join(servers[1].config.privateDir,file));
  for(const route of ['/workstation-a/api/summary','/workstation-b/api/summary'])assert.equal((await fetch(base+route,{headers:{cookie}})).status,401);
});
