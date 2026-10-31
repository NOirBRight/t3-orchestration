import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadAppSource, readAppBundle } from './load-app.mjs';
import { TABS, readTab, tabHref, itemTab } from '../public/tabs.js';

test('manifest 请求携带远程入口 cookie', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link\b(?=[^>]*rel="manifest")(?=[^>]*crossorigin="use-credentials")[^>]*>/);
});

test('card CSS wraps long unbroken asker ids instead of stretching past a phone viewport', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const cardRule = css.match(/\.card\s*\{([^}]*)\}/);
  assert.ok(cardRule, 'missing .card rule');
  assert.match(cardRule[1], /overflow-wrap:\s*anywhere/);
  assert.match(cardRule[1], /max-width:\s*100%/);
  const askerRule = css.match(/\.asker\s*\{([^}]*)\}/);
  assert.ok(askerRule, 'missing .asker rule');
  assert.doesNotMatch(askerRule[1], /white-space:\s*nowrap/);
  assert.match(askerRule[1], /overflow-wrap:\s*anywhere|word-break:\s*break-word/);
  assert.match(askerRule[1], /min-width:\s*0/);

  const context = await renderContext();
  // Owner phone report: forwarded thread id is a long hex hash with no spaces.
  const longId = 'mcp:launch:' + 'a1b2c3d4e5f67890'.repeat(6);
  assert.ok(longId.length > 80);
  // Phone width budget used in the CSS contract below (max-width:720px mobile lane).
  const phoneViewport = 390;
  assert.ok(phoneViewport >= 360 && phoneViewport <= 390);
  context.item = {
    id: 'Q10', ticket: 'P79', askerLabel: longId, kind: 'decide', status: 'closed',
    title: 'forwarded', answer: { choices: [], note: '', images: [] }, options: [],
    times: { saved: new Date().toISOString() },
  };
  const html = vm.runInContext('card(item)', context);
  assert.match(html, /class="card[^"]*"/);
  assert.match(html, new RegExp(`class="asker">${longId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // Mobile lane is active at ≤720px; card max-width 100% + wrap keeps width ≤ viewport.
  assert.match(css, /@media \(max-width:720px\)/);
});

test('login page offers passphrase and one-time device code fields', async () => {
  const source = await readFile(new URL('../public/login.js', import.meta.url), 'utf8');
  assert.match(source, /name="k"/);
  assert.match(source, /name="code"/);
  assert.match(source, /id="device-code"|id="code"/);
  assert.match(source, /一次性码|deviceCode/);
  assert.match(source, /id="device-code"[^>]*type="password"|name="code" type="password"/);
  assert.match(source, /autocomplete="one-time-code"/);
});

test('选项和答复摘要显示顺序字母，提交仍使用内部 key', async () => {
  const context = await renderContext();
  const item = { id: 'Q1', kind: 'decide', status: 'open', title: '选择', options: [
    { key: 'got', label: '收到了推送' }, { key: 'page-only', label: '只用网页' }, { key: 'unlimited', label: '不限' },
  ] };
  context.item = item;
  const editor = vm.runInContext("data = {remote:false}; editor(item)", context);
  assert.match(editor, /class="key">A<\/span><span class="option-text"><span class="option-label">收到了推送/);
  assert.match(editor, /class="key">B<\/span><span class="option-text"><span class="option-label">只用网页/);
  assert.match(editor, /class="key">C<\/span><span class="option-text"><span class="option-label">不限/);
  assert.match(editor, /data-key="page-only"/);
  item.status = 'closed'; item.answer = { choices: ['page-only', 'got'], images: [] };
  const card = vm.runInContext('card(item)', context);
  assert.match(card, /<span class="chip ">B\. 只用网页<\/span><span class="chip ">A\. 收到了推送<\/span>/);
  assert.doesNotMatch(card, /page-only|got|unlimited/);
  context.label = { ticket: '#275', askerLabel: '#275 存档同步' };
  assert.equal(vm.runInContext('asker(label)', context), '存档同步');
});

test('手机顶栏工具收进设置面板，桌面仍显示在顶栏', async () => {
  const context = await renderContext();
  vm.runInContext("summary = { name: 'desk', loggedIn: true, campaigns: [] }", context);
  const bar = vm.runInContext('header()', context);
  assert.match(bar, /<span class="bar-tools">[\s\S]*data-action="add-device"[\s\S]*data-action="language"[\s\S]*data-action="theme"[\s\S]*<\/span><button class="icon-button settings-button" data-action="settings"/);
  assert.equal(vm.runInContext('renderSettings()', context), '');
  const sheet = vm.runInContext('settings = true; renderSettings()', context);
  assert.deepEqual([...sheet.matchAll(/class="setting-row" data-action="([^"]+)"/g)].map(m => m[1]), ['add-device', 'rt-open', 'language', 'theme']);
  assert.match(sheet, /<span class="setting-value">中文<\/span>/);
});

test('看板已并进“进度”tab：顶栏和设置面板不再链到单独的看板页', async () => {
  const context = await renderContext();
  vm.runInContext("summary = { name: 'desk', loggedIn: false, campaigns: [] }; campaign = 'pm v4'; settings = true", context);
  assert.doesNotMatch(vm.runInContext('renderSettings()', context), /kanban\.html|data-action="kb-/);
  assert.doesNotMatch(vm.runInContext('header()', context), /kanban\.html|icon\('list'/);
});

test('编排换题后草稿带到新题，原题显示已换成新题', async () => {
  const context = await renderContext();
  vm.runInContext(`toast = message => { toasted = message; }; data = { items: [
    { id: 'Q1', kind: 'decide', status: 'closed', title: '旧题', replacedBy: 'Q2', options: [{ key: 'a', label: '甲' }, { key: 'b', label: '乙' }] },
    { id: 'Q2', kind: 'decide', status: 'closed', title: '中间题', replacedBy: 'Q3', options: [] },
    { id: 'Q3', kind: 'decide', status: 'open', title: '新题', options: [{ key: 'b', label: '乙' }, { key: 'c', label: '丙' }] },
  ] }; drafts = { Q1: { choices: ['a', 'b'], note: '我的想法', images: ['inbox/uploads/Q1/x.png'] } }; carryDrafts();`, context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(drafts)', context)), { Q3: { choices: ['b'], note: '我的想法', images: ['inbox/uploads/Q1/x.png'] } });
  assert.match(vm.runInContext('toasted', context), /草稿已带到新题/);
  const card = vm.runInContext('card(data.items[0])', context);
  assert.match(card, /编排已换成新题：中间题/); assert.doesNotMatch(card, /你的答复|只留言/);
});

test('slow submission preserves newer answer and message drafts', async () => {
  const context = await renderContext(); let release;
  context.pendingResponse = new Promise(resolve => { release = resolve; });
  vm.runInContext(`render = () => {}; refresh = async () => {}; toast = () => {};
    data = {items:[{id:'Q1',kind:'decide',status:'open',options:[]}]};
    drafts = {Q1:{choices:[],note:'original',images:[]}, __message:{choices:[],note:'message',images:[]}};
    api = async () => pendingResponse;`, context);
  const submitting = vm.runInContext('submit()', context);
  vm.runInContext("drafts.Q1.note = 'new input'; drafts.__message.note = 'new message';", context);
  release({notify:'accepted'}); await submitting;
  assert.equal(vm.runInContext('drafts.Q1.note', context), 'new input');
  assert.equal(vm.runInContext('drafts.__message.note', context), 'new message');
  assert.equal(vm.runInContext("editing.has('Q1')", context), true);
  await vm.runInContext('submit()', context);
  assert.equal(vm.runInContext('Object.keys(drafts).length', context), 0);
});

// 运行真实渲染函数；不启动网络、DOM 事件和定时刷新。
function renderContext({ browserLanguage = 'zh-CN', savedLanguage = null } = {}) {
  const context = vm.createContext({
    navigator: { language: browserLanguage },
    document: { getElementById: () => ({}), documentElement: { dataset: {} } },
    location: { href: 'https://example.test/?campaign=test' }, URL, scrollY: 0,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem(key) { return key === 'inbox-language' ? savedLanguage : null; }, setItem() {} },
  });
  return loadAppSource(context, { stopBefore: "document.addEventListener('click'" });
}

async function loadAppHandlers(context) {
  const source = await readAppBundle();
  vm.runInContext(source.slice(source.indexOf("document.addEventListener('click'"), source.lastIndexOf('\nrender();')), context);
}

// 第 P109 票：四个分区是真 tab，点一下换整页，不是滚到锚点。
function tabContext(context, listeners) {
  const root = { innerHTML: '' }, scrolls = [];
  Object.assign(context, {
    scrollY: 0, innerHeight: 800, scrollTo: (x, y) => scrolls.push(y),
    addEventListener(name, handler) { listeners[name] = handler; },
    navigator: {}, setInterval() {}, history: fakeHistory(context, listeners),
  });
  Object.assign(context.document, {
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => ({ scrollIntoView() {} }),
    addEventListener(name, handler) { listeners[name] = handler; },
    body: { classList: { toggle() {} } },
  });
  vm.runInContext(`root = __root; machine = 'desk'; campaign = 'demo'; summary = { name:'desk', campaigns:[{id:'demo',title:'Demo'}], peers:[] };
    data = { remote:false, campaign:{title:'Demo'}, messages:[], items:[
      {id:'D1',ticket:'P1',kind:'decide',status:'open',title:'决定题',options:[{key:'a',label:'甲'}],createdAt:new Date().toISOString()},
      {id:'A1',ticket:'P2',kind:'accept',status:'open',title:'验收题',createdAt:new Date().toISOString()},
    ], progress:{ groups:[{title:'进行中',tickets:[{ticket:'#7',title:'旧进度列表',stage:'执行中'}]}], olderCompleted:3 } };`, Object.assign(context, { __root: root }));
  return { root, scrolls };
}
const tabClick = tab => ({ target: { closest: selector => selector === '[data-tab]' ? { dataset: { tab } } : null }, preventDefault() {} });

test('tab 地址：?tab= 决定显示哪一页，决定页不写参数，旧 #sec- 锚点仍能打开对应分区', () => {
  assert.deepEqual(TABS, ['decide', 'accept', 'message', 'progress']);
  assert.equal(readTab('https://x.test/?campaign=c'), 'decide');
  assert.equal(readTab('https://x.test/?campaign=c&tab=progress'), 'progress');
  assert.equal(readTab('https://x.test/?tab=bogus'), 'decide');
  assert.equal(readTab('https://x.test/?campaign=c#sec-accept'), 'accept');
  assert.equal(readTab('https://x.test/?campaign=c#sec-message'), 'message');
  assert.equal(tabHref('https://x.test/m/?campaign=c&machine=m', 'progress'), 'https://x.test/m/?campaign=c&machine=m&tab=progress');
  assert.equal(tabHref('https://x.test/?campaign=c&tab=progress#sec-progress', 'decide'), 'https://x.test/?campaign=c');
  assert.equal(tabHref('https://x.test/?campaign=c#item-Q1', 'accept'), 'https://x.test/?campaign=c&tab=accept');
  assert.equal(itemTab({ kind: 'accept', status: 'open' }), 'accept');
  assert.equal(itemTab({ kind: 'accept', status: 'saved' }), 'accept');
  assert.equal(itemTab({ kind: 'accept', status: 'closed' }), 'decide', 'closed items live under the 决定 page');
  assert.equal(itemTab({ kind: 'decide', status: 'open' }), 'decide');
});

test('每个 tab 只渲染自己的一页；导航是四个链接，当前项 aria-current；没有旧进度列表和看板外链', async () => {
  const context = await renderContext(), { root } = tabContext(context, {});
  const pages = {};
  for (const tab of ['decide', 'accept', 'message', 'progress']) {
    context.tab = tab; vm.runInContext('render()', context);
    const html = pages[tab] = root.innerHTML;
    assert.deepEqual([...html.matchAll(/<section class="lane[^"]*" id="sec-(\w+)"/g)].map(m => m[1]), [tab], `${tab}: one page`);
    const links = [...html.matchAll(/<a\b[^>]*data-tab="(\w+)"[^>]*>/g)];
    assert.deepEqual(links.map(m => m[1]), ['decide', 'accept', 'message', 'progress']);
    for (const [link, name] of links.map(m => [m[0], m[1]])) {
      assert.match(link, name === 'decide' ? /href="\?campaign=demo"/ : new RegExp(`href="\\?campaign=demo&amp;tab=${name}"`), link);
      assert.equal(/aria-current="page"/.test(link), name === tab, `${tab}: ${name} current`);
    }
    assert.doesNotMatch(html, /ticket-row|class="tickets"|旧进度列表|progressSource|来自 campaign\.json/, `${tab}: the old progress list is gone`);
    assert.doesNotMatch(html, /kanban\.html/, `${tab}: no link out to the separate board page`);
  }
  assert.match(pages.decide, /data-card="D1"/); assert.doesNotMatch(pages.decide, /data-card="A1"/);
  assert.match(pages.accept, /data-card="A1"/); assert.doesNotMatch(pages.accept, /data-card="D1"/);
  assert.match(pages.message, /data-card="__message"/); assert.doesNotMatch(pages.decide, /data-card="__message"/);
  assert.match(pages.progress, /class="kb-/, 'the 进度 page is the ticket board');
  const sheet = vm.runInContext('settings = true; renderSettings()', context);
  assert.doesNotMatch(sheet, /kanban\.html/);
});

test('点 tab 换页：只改地址不加历史、不滚锚点，回到原来的滚动位置；返回键先回决定页，再按两次才离开', async () => {
  const context = await renderContext(), listeners = {}, toasts = [];
  const { scrolls } = tabContext(context, listeners);
  await loadAppHandlers(context);
  let renders = 0; context.render = () => { renders++; };
  context.toast = message => toasts.push(message);
  await listeners.click(tabClick('message'));
  assert.equal(context.tab, 'message');
  assert.match(context.location.href, /\?campaign=test&tab=message$/);
  assert.equal(context.history.length, 2, 'only the back guard entry, no entry per tab');
  assert.equal(renders, 1); assert.equal(scrolls.at(-1), 0);
  context.scrollY = 640; await listeners.click(tabClick('accept'));
  context.scrollY = 120; await listeners.click(tabClick('message'));
  assert.equal(scrolls.at(-1), 640, 'each tab keeps its own scroll position');
  assert.equal(context.history.length, 2);

  // Esc 只关浮层，不换 tab；修饰键点击交给浏览器在新标签打开。
  assert.equal(vm.runInContext('closeOverlay()', context), false);
  assert.equal(context.tab, 'message');
  let prevented = false;
  await listeners.click({ ...tabClick('accept'), ctrlKey: true, preventDefault() { prevented = true; } });
  assert.equal(context.tab, 'message'); assert.equal(prevented, false);

  const back = context.history.back;
  back(); assert.equal(context.tab, 'decide'); assert.deepEqual(toasts, []);
  assert.doesNotMatch(context.location.href, /tab=/);
  back(); assert.deepEqual(toasts, ['再按一次返回退出']); assert.equal(context.history.left, false);
  back(); assert.equal(context.history.left, true);
});

test('看板筛选面板和抽屉是真模态：打开时焦点进对话框，背后整页 inert，关掉回到触发按钮', async () => {
  const context = await renderContext(), listeners = {}, focused = [];
  const { root } = tabContext(context, listeners);
  await loadAppHandlers(context);
  context.document.getElementById = id => ({ id, focus() { focused.push(`#${id}`); }, scrollIntoView() {} });
  context.document.querySelector = selector => (selector === '.lightbox' ? null : { focus() { focused.push(selector); } });
  vm.runInContext("tab = 'progress'; kanban.board = { generatedAt: new Date().toISOString(), tickets: [{ id:'P1', title:'票', status:'running', dependsOn:[], threadState:'running' }] }", context);
  const action = (name, id) => listeners.click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: name, id } } : null }, preventDefault() {} });
  const inert = html => [...html.matchAll(/<(header|nav|div|section|aside|button)\b[^>]*class="([^"]*)"[^>]*\binert\b/g)].map(m => m[2].split(' ')[0]);

  await action('kb-sheet');
  assert.equal(focused.at(-1), '#kb-sheet-x', 'focus moves into the filter sheet');
  let html = root.innerHTML;
  for (const part of ['bar', 'tabs', 'lane-header', 'kb-notice', 'kb-board', 'tray']) assert.ok(inert(html).includes(part), `${part} is inert behind the sheet`);
  assert.ok(!inert(html).includes('kb-bar'), 'the sheet itself stays interactive');
  vm.runInContext('closeOverlay()', context);
  assert.equal(focused.at(-1), '[data-action="kb-sheet"]', 'focus returns to the trigger');
  assert.deepEqual(inert(root.innerHTML).filter(part => part !== 'tray'), [], 'nothing stays inert after closing');

  await action('kb-open', 'P1');
  assert.equal(focused.at(-1), '#kb-x');
  html = root.innerHTML;
  for (const part of ['bar', 'tabs', 'kb-bar', 'kb-board']) assert.ok(inert(html).includes(part), `${part} is inert behind the drawer`);
  assert.ok(!inert(html).includes('kb-drawer'));
});

test('刷新后抽屉里的票不在了：抽屉状态清掉，背后不再 inert', async () => {
  const context = await renderContext(), listeners = {};
  const { root } = tabContext(context, listeners);
  await loadAppHandlers(context);
  vm.runInContext("tab = 'progress'; kanban.board = { generatedAt: new Date().toISOString(), tickets: [{ id:'P1', title:'票', status:'running', dependsOn:[], threadState:'running' }] }; kanban.drawer = 'P1'", context);
  // 已经渲染出来的旧状态：抽屉指向的票被删掉，渲染和上锁要看同一个判断。
  vm.runInContext("kanban.board = { generatedAt: new Date().toISOString(), tickets: [] }; render()", context);
  assert.doesNotMatch(root.innerHTML, /<header class="bar" inert|<nav class="tabs"[^>]*inert/);
  assert.equal(vm.runInContext('kanbanModal()', context), false);
  // 刷新拿到新数据时直接清掉失效的抽屉。
  vm.runInContext("kanban.drawer = 'P1'; api = async () => ({ generatedAt: new Date().toISOString(), tickets: [{ id:'P2', title:'别的', status:'queued', dependsOn:[], threadState:'notStarted' }] })", context);
  await vm.runInContext('loadKanban()', context);
  assert.equal(vm.runInContext('kanban.drawer', context), null);
  assert.doesNotMatch(root.innerHTML, /<header class="bar" inert|<nav class="tabs"[^>]*inert/);
});

test('通知深链 #item- 和提交报错都切到题目所在的 tab', async () => {
  const context = await renderContext(), listeners = {};
  tabContext(context, listeners);
  await loadAppHandlers(context);
  context.render = () => {};
  vm.runInContext("showItem('A1')", context);
  assert.equal(context.tab, 'accept');
  assert.match(context.location.href, /tab=accept/);
  vm.runInContext("showItem('D1')", context);
  assert.equal(context.tab, 'decide');
  vm.runInContext("showItem('missing')", context);
  assert.equal(context.tab, 'decide', 'unknown ids stay put');

  // 看板抽屉里的“去确认”先关抽屉；提示条跳到等你确认的票名下的题，而不是随便一道未答题。
  let renders = 0; context.render = () => { renders++; };
  const action = (name, id) => listeners.click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: name, id } } : null }, preventDefault() {} });
  vm.runInContext("kanban.drawer = 'P2'", context);
  await action('kb-goto', 'missing');
  assert.equal(vm.runInContext('kanban.drawer', context), null); assert.ok(renders > 0, 'drawer closes even when the item is gone');
  vm.runInContext("tab = 'progress'; kanban.board = { tickets: [{ id:'P1', ownerItems:[] }, { id:'P2', needsOwner:true, ownerItems:[{ id:'A1', title:'验收题' }] }] }", context);
  await action('kb-owner');
  assert.equal(context.tab, 'accept', 'D1 is open too, but only A1 belongs to a ticket waiting on the owner');

  vm.runInContext("drafts = { A1: { choices:['rework'], note:'', images:[] } }", context);
  await vm.runInContext('submit()', context);
  assert.equal(context.tab, 'accept', 'validation error opens the tab that holds the item');
  assert.match(vm.runInContext('errors.A1', context), /返修要写说明/);
});

test('派票设置的分区导航仍是锚点：保持点击项，用户滚动后恢复位置高亮', async () => {
  const context = await renderContext(), listeners = {};
  const links = ['routes', 'limits', 'quota', 'sync'].map(name => ({
    hash: `#rt-${name}`, active: false,
    classList: { toggle(name, on) { this.link.active = on; } },
  }));
  links.forEach(link => { link.classList.link = link; });
  const tops = [80, 300, 580, 780];
  Object.assign(context, {
    scrollY: 0, innerHeight: 800,
    addEventListener(name, handler) { listeners[name] = handler; },
    navigator: {}, setInterval() {}, history: fakeHistory(context, listeners),
  });
  Object.assign(context.document, {
    querySelectorAll: selector => selector === '.tabs a[href^="#"]' ? links : [],
    querySelector: selector => {
      const index = links.findIndex(link => link.hash === selector);
      return index < 0 ? null : { getBoundingClientRect: () => ({ top: tops[index] - context.scrollY }), scrollIntoView() {} };
    },
    addEventListener(name, handler) { listeners[name] = handler; },
    body: { classList: { toggle() {} } },
  });
  context.document.documentElement.scrollHeight = 1000;
  await loadAppHandlers(context);
  const active = () => links.find(link => link.active)?.hash;
  const click = async index => {
    await listeners.click({ target: { closest: selector => selector === '.tabs a[href^="#"]' ? links[index] : null }, preventDefault() {} });
  };
  vm.runInContext('spy()', context);
  assert.equal(active(), '#rt-routes');
  await click(2);
  assert.equal(active(), '#rt-quota');
  context.scrollY = 200; listeners.scroll(); // 锚点滚动被页面底部截断。
  assert.equal(active(), '#rt-quota');
  vm.runInContext('spy()', context); // 定时刷新重新渲染也不覆盖选择。
  assert.equal(active(), '#rt-quota');
  await click(3); // 已经在底部，不产生新 scroll 事件。
  assert.equal(active(), '#rt-sync');
  await click(1);
  assert.equal(active(), '#rt-limits');
  listeners.touchmove({});
  context.scrollY = 0; listeners.scroll();
  assert.equal(active(), '#rt-routes');
  for (const [name, event] of [['wheel', {}], ['keydown', { key: 'Home', target: { closest: () => null } }], ['pointerdown', { clientX: 400 }]]) {
    context.document.documentElement.clientWidth = 400;
    await click(2);
    context.scrollY = 200; listeners.scroll();
    assert.equal(active(), '#rt-quota');
    listeners[name](event);
    context.scrollY = 0; listeners.scroll();
    assert.equal(active(), '#rt-routes', name);
  }
  // 分区跳转只改地址，不给返回键留下历史条目。
  assert.equal(context.history.length, 2);
  assert.match(context.location.href, /#rt-quota$/);
});

test('返回键先关浮层，主页上要按两次才离开', async () => {
  const context = await renderContext(), listeners = {}, toasts = [];
  let box = null;
  Object.assign(context, { scrollY: 0, addEventListener(name, handler) { listeners[name] = handler; }, navigator: {}, setInterval() {}, history: fakeHistory(context, listeners) });
  Object.assign(context.document, {
    querySelectorAll: () => [], querySelector: selector => selector === '.lightbox' ? box : null,
    addEventListener(name, handler) { if (name === 'click') listeners.click = handler; },
  });
  await loadAppHandlers(context);
  context.toast = message => toasts.push(message);
  const tap = () => listeners.click({ target: { closest: () => null } });
  const open = () => { box = { remove() { box = null; } }; vm.runInContext('overlay()', context); };
  const back = context.history.back;

  await tap(); open();
  back(); assert.equal(box, null); assert.deepEqual(toasts, []);
  back(); assert.deepEqual(toasts, ['再按一次返回退出']); assert.equal(context.history.left, false);
  back(); assert.equal(context.history.left, true);

  // 用关闭按钮关掉浮层后，下一次返回直接给出退出提示。
  context.history.left = false; toasts.length = 0;
  await tap(); open(); box.remove();
  back(); assert.deepEqual(toasts, ['再按一次返回退出']); assert.equal(context.history.left, false);
  back(); assert.equal(context.history.left, true);
});

function fakeDialogDom(appended) {
  return {
    querySelector: () => null,
    body: { append(el) { appended.push(el); } },
    createElement: tag => {
      const el = {
        tagName: tag.toUpperCase(), className: '', role: '', ariaModal: '', ariaLabel: '', innerHTML: '',
        onclick: null, onkeydown: null, style: {},
        querySelector(sel) {
          if (sel === '[data-close]' || sel === '[data-confirm]' || sel === '[role=status]') {
            return { onclick: null, onkeydown: null, disabled: false, focus() {}, textContent: '' };
          }
          return null;
        },
        remove() { const i = appended.indexOf(el); if (i >= 0) appended.splice(i, 1); },
      };
      return el;
    },
  };
}

// 同步模拟浏览器历史：返回时触发 popstate，退到第一条之外记为离开页面。
function fakeHistory(context, listeners) {
  const entries = [{ state: null, url: context.location.href }]; let index = 0;
  const go = (state, url) => ({ state, url: String(new URL(url ?? context.location.href, context.location.href)) });
  const history = {
    left: false,
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state, _, url) { entries.splice(index + 1, Infinity, go(state, url)); index++; context.location.href = entries[index].url; },
    replaceState(state, _, url) { entries[index] = go(state, url); context.location.href = entries[index].url; },
    back() { if (!index) { history.left = true; return; } index--; context.location.href = entries[index].url; listeners.popstate({ state: entries[index].state }); },
  };
  return history;
}

test('时间带日期语境：几分钟前、今天、昨天、几月几日', async () => {
  const context = await renderContext(), now = new Date();
  context.minutesAgo = new Date(now - 5 * 60000).toISOString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 5);
  const older = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 21, 30);
  Object.assign(context, { yesterday: yesterday.toISOString(), older: older.toISOString() });
  assert.equal(vm.runInContext('when(minutesAgo)', context), '5 分钟前');
  assert.equal(vm.runInContext('when(yesterday)', context), '昨天 09:05');
  assert.equal(vm.runInContext('when(older)', context), `${older.getMonth() + 1}月${older.getDate()}日 21:30`);
});

test('送达异常给带重发的提醒，没配通知只给说明和低调的重发', async () => {
  const context = await renderContext(), saved = new Date(Date.now() - 60000).toISOString();
  context.failed = { id: 'Q1', kind: 'decide', status: 'saved', times: { saved }, notify: { state: 'failed' } };
  context.slow = { id: 'Q2', kind: 'decide', status: 'notified', times: { saved, notified: new Date(Date.now() - 20 * 60000).toISOString() }, notify: { state: 'accepted' } };
  context.quiet = { id: 'Q3', kind: 'decide', status: 'saved', times: { saved }, notify: { state: 'unconfigured' } };
  const failed = vm.runInContext('track(failed)', context), slow = vm.runInContext('track(slow)', context), quiet = vm.runInContext('track(quiet)', context);
  assert.match(failed, /class="alert failed"[\s\S]*data-action="retry" data-id="Q1"/);
  assert.match(failed, /class="step failed"><span class="step-dot"><\/span><span class="step-label">已通知/);
  assert.match(slow, /class="alert late"[\s\S]*编排 20 分钟还没读/);
  assert.match(slow, /class="step late"><span class="step-dot"><\/span><span class="step-label">编排已读/);
  assert.doesNotMatch(quiet, /class="alert/);
  // Read on patrol after a failed webhook: the server refuses a resend, so no warning or resend button.
  context.readAfterFailure = { id: 'Q4', kind: 'decide', status: 'read', times: { saved, read: saved }, notify: { state: 'failed' } };
  assert.doesNotMatch(vm.runInContext('track(readAfterFailure)', context), /class="alert|data-action="retry"/);
  assert.match(quiet, /没配通知[\s\S]*class="link" data-action="retry" data-id="Q3"/);
  context.note = { id: 'M1', note: '先停', status: 'saved', times: { saved }, notify: { state: 'unconfigured' } };
  assert.match(vm.runInContext('message(note)', context), /没配通知[\s\S]*data-action="retry" data-id="M1"/);
  assert.match(vm.runInContext("submitted(2, 'failed')", context), /通知没送到/);
  assert.match(vm.runInContext("submitted(2, 'unconfigured')", context), /没配通知/);
  assert.equal(vm.runInContext("submitted(2, 'accepted')", context), '已提交 2 项，已通知编排');
});

test('旧机器路径 worker 和根 worker 的通知均定位同源 hub，拒绝跨源地址', async () => {
  const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const scope of ['https://example.test/workstation-a/', 'https://example.test/']) {
    const listeners = {}, notifications = [];
    const context = vm.createContext({
    navigator: { language: 'zh-CN' }, URL, self: {
      location: {origin:'https://example.test'}, registration:{scope,showNotification:async(title,options)=>notifications.push(options)},
      addEventListener:(name,handler)=>{listeners[name]=handler;},
    }});
    vm.runInContext(worker,context);
    let work;
    const send = async url => {listeners.push({data:{json:()=>({url})},waitUntil:p=>{work=p;}});await work;return notifications.at(-1).data.url;};
    assert.equal(await send('https://example.test/?machine=workstation-b&campaign=demo#Q1'),'https://example.test/?machine=workstation-b&campaign=demo#item-Q1');
    assert.equal(await send('https://evil.test/?campaign=demo'),scope);
  }
});

test('英文主要渲染路径完整翻译，用户题稿和选项保留原文', async () => {
  const context = await renderContext({ browserLanguage: 'zh-CN', savedLanguage: 'en' });
  assert.equal(context.document.documentElement.lang, 'en');
  Object.assign(context, { isSecureContext: true, window: { PushManager: class {} }, scrollY: 0, scrollTo() {} });
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  context.document.body = { classList: { toggle() {} } };
  const now = new Date().toISOString();
  context.fixture = {
    id: 'Q1', ticket: '#10', askerLabel: '#10 Thread', kind: 'decide', status: 'open', blocking: true, multi: true,
    title: 'Choose a mode', background: ['Context '.repeat(50)], recommendation: 'Use A', createdAt: now,
    media: [{ path: 'image.png' }], options: [{ key: 'a', label: 'Mode A', recommended: true, consequence: 'Faster' }, { key: 'b', label: 'Mode B' }],
  };
  vm.runInContext(`
    machine = 'desktop'; campaign = 'demo'; menu = true;
    summary = { name:'desktop', hub:true, remote:true, campaigns:[{id:'demo',title:'Demo',pending:2}], peers:[{name:'offline',unavailable:true}] };
    data = { remote:true, campaign:{title:'Demo'}, items:[fixture], messages:[] };
    kanban.board = { campaign:{id:'demo',title:'Demo'}, generatedAt:new Date().toISOString(), github:{error:'github-unavailable',fetchedAt:new Date().toISOString()}, conflictCount:1, tickets:[
      {id:'P1',title:'Security',status:'running',version:'0.4.1',machine:'DESK',needsOwner:true,ownerItems:[{id:'Q1',title:'Choose a mode'}],dependsOn:['P2'],blocked:true,blockedReason:'Waiting',conflict:'issueClosed',missingIssue:true,orchestratorSide:true,threadState:'running',stage:'Build',summary:'Fix it',issue:{number:4,state:'CLOSED',url:'https://example.test/4'}},
      {id:'P2',title:'Done',status:'merged',version:null,machine:null,needsOwner:false,dependsOn:[],threadState:'ended'}] };
    drafts.Q1 = { choices:['a'], note:'Draft note', images:[{path:'image.png',size:512,originalSize:1024}] };
  `, context);
  const english = (expression, { selector = false } = {}) => {
    let html = vm.runInContext(expression, context);
    if (selector) html = html.replace(/(<button[^>]*data-action="language"[^>]*>)中(<\/button>)/, '$1ZH$2');
    assert.doesNotMatch(html, /\p{Script=Han}/u, expression);
    assert.doesNotMatch(html, /[，。；：、（）]/u, `${expression}: English punctuation`);
    return html;
  };
  assert.match(english('editor(fixture)'), /Recommended/);
  assert.match(english('card(fixture)'), /Blocking/);
  assert.match(english('renderKanban()'), /Needs you/);
  assert.match(english("kanban.columns = COLUMNS.slice(); kanban.drawer = 'P1'; kanban.sheet = true; renderKanban()"), /Depends on/);
  assert.match(english("kanban.board = null; kanban.error = 'x'; renderKanban()"), /didn&#39;t load/);
  assert.match(english('renderMenu()'), /Unavailable/);
  assert.match(english('header()', { selector: true }), /Enable notifications/);
  assert.match(english('messagePage()'), /Note to orchestrator/);
  english('decidePage()'); english('acceptPage()'); english('tabs()');
  for (const status of ['saved', 'notified', 'read', 'forwarded', 'closed']) {
    context.answered = { ...context.fixture, status, answeredBy: 'orchestrator', answer: { choices: ['a'], note: 'Answer', images: [] }, times: { [status]: now, saved: now }, redo: true };
    english('card(answered)'); english('track(answered)');
  }
  context.failed = { ...context.answered, status: 'saved', notify: { state: 'failed' } };
  assert.match(english('track(failed)'), /Resend notification/);
  context.slow = { ...context.answered, status: 'notified', times: { notified: new Date(Date.now() - 20 * 60000).toISOString() } };
  assert.match(english('track(slow)'), /Unread/);
  context.quiet = { ...context.answered, status: 'saved', notify: { state: 'unconfigured' } };
  english('track(quiet)');
  for (const notify of ['failed', 'unconfigured', 'accepted']) {
    context.notifyState = notify;
    assert.match(english('submitted(2, notifyState)'), /Submitted 2/);
  }
  context.acceptance = { ...context.fixture, id: 'A1', kind: 'accept', options: undefined };
  vm.runInContext("drafts.A1 = {choices:['rework'],note:'',images:[]}; editing.add('A1')", context);
  assert.match(english('editor(acceptance)'), /Describe the changes needed \(required\)/);
  english('render(); root.innerHTML', { selector: true });
  vm.runInContext("data = null; errors.connection = 'offline'", context);
  assert.match(english('render(); root.innerHTML', { selector: true }), /Retry/);
  vm.runInContext('campaign = null; errors = {}; menu = false', context);
  assert.match(english('render(); root.innerHTML', { selector: true }), /No Campaign registered yet/);

  context.userItem = { ...context.fixture, id: 'USER', title: '用户原题', background: ['用户背景'], recommendation: '用户建议', options: [{ key: 'a', label: '用户选项', consequence: '用户后果' }] };
  vm.runInContext("data = { remote:false }; drafts.USER = {choices:['a'],note:'用户草稿',images:[]}", context);
  const userCard = vm.runInContext('card(userItem)', context);
  for (const original of ['用户原题', '用户背景', '用户建议', '用户选项', '用户后果', '用户草稿']) assert.ok(userCard.includes(original), original);
  assert.doesNotMatch(userCard.replace(/用户(?:原题|背景|建议|选项|后果|草稿)/g, ''), /\p{Script=Han}/u);
});

test('Campaign menu exposes removal only when canManage for local/hub entries with closed data', async () => {
  const context = await renderContext(); context.document.querySelector = () => null;
  vm.runInContext(`menu=true; summary={name:'local',loggedIn:true,canManage:true,campaigns:[{id:'done',title:'Done',removable:true},{id:'pending',title:'Pending',removable:false}],peers:[{name:'peer',url:'https://peer.example.test/',campaigns:[{id:'done',title:'Peer',removable:true},{id:'busy',title:'Busy',removable:false},{id:'unknown',title:'Unknown'}]}]}`, context);
  let menu = vm.runInContext('renderMenu()', context);
  assert.match(menu, /data-action="remove-campaign" data-machine="local" data-id="done"\s+title=/);
  assert.match(menu, /data-id="pending" disabled/); assert.match(menu, /请先结案所有题目和留言/);
  // LAN page: peer rows show Remove as a jump link to that machine's confirm dialog.
  assert.doesNotMatch(menu, /data-action="remove-campaign" data-machine="peer"/);
  assert.match(menu, /href="https:\/\/peer\.example\.test\/\?campaign=done&amp;remove=done"[^>]*>移除/);
  assert.match(menu, /campaign-remove[^>]*disabled[^>]*title="[^"]*请先结案所有题目和留言/);
  assert.match(menu, /campaign-remove[^>]*disabled[^>]*title="[^"]*读不到是否可移除/);
  vm.runInContext(`summary.hub=true; language='en'`, context);
  menu = vm.runInContext('renderMenu()', context);
  assert.match(menu, /data-action="remove-campaign" data-machine="peer"/);
  assert.doesNotMatch(menu, /href="https:\/\/peer\.example\.test\/\?campaign=done&amp;remove=done"/);
  assert.match(menu, /Close all questions and messages first/);
  vm.runInContext('summary.canManage=false; summary.loggedIn=false; summary.hub=false', context);
  menu = vm.runInContext('renderMenu()', context);
  assert.doesNotMatch(menu, /data-action="remove-campaign"/);
  // Peer jump links are not gated by the viewing machine's canManage.
  assert.match(menu, /href="https:\/\/peer\.example\.test\/\?campaign=done&amp;remove=done"[^>]*>(?:Remove|移除)/);
  vm.runInContext('summary.canManage=true; summary.loggedIn=false', context);
  assert.match(vm.runInContext('renderMenu()', context), /data-action="remove-campaign" data-machine="local"/);
});

test('?remove= opens local confirm only when Campaign exists, canManage, and removable', async () => {
  const context = await renderContext();
  const listeners = {};
  const appended = [];
  const toasts = [];
  Object.assign(context, {
    history: fakeHistory(context, listeners),
    document: Object.assign(context.document, fakeDialogDom(appended)),
  });
  context.toast = (message, tone) => toasts.push({ message, tone });
  const run = (href, summary) => {
    appended.length = 0; toasts.length = 0;
    context.location.href = href;
    context.history.replaceState(null, '', href);
    vm.runInContext(`summary = ${JSON.stringify(summary)}; busy = false; uploading = 0; menu = false;`, context);
    return vm.runInContext('consumeRemoveParam()', context);
  };
  const base = { name: 'local', loggedIn: true, canManage: true, campaigns: [{ id: 'done', title: 'Done', removable: true }, { id: 'busy', title: 'Busy', removable: false }], peers: [] };

  await run('https://example.test/?campaign=done&remove=done', base);
  assert.equal(appended.length, 1);
  assert.match(appended[0].innerHTML, /移除 Campaign？/);
  assert.equal(new URL(context.location.href).searchParams.get('remove'), null);
  assert.equal(new URL(context.location.href).searchParams.get('campaign'), 'done');
  assert.deepEqual(toasts, []);

  await run('https://example.test/?remove=missing', base);
  assert.equal(appended.length, 0);
  assert.match(toasts[0]?.message, /没有这个 Campaign/);
  assert.equal(new URL(context.location.href).searchParams.get('remove'), null);

  await run('https://example.test/?remove=done', { ...base, canManage: false });
  assert.equal(appended.length, 0);
  assert.match(toasts[0]?.message, /没有管理权限/);
  assert.equal(new URL(context.location.href).searchParams.get('remove'), null);

  await run('https://example.test/?remove=busy', base);
  assert.equal(appended.length, 0);
  assert.match(toasts[0]?.message, /请先结案所有题目和留言/);
  assert.equal(new URL(context.location.href).searchParams.get('remove'), null);

  await run('https://example.test/?remove=done', { ...base, campaigns: [{ id: 'done', title: 'Done' }] });
  assert.equal(appended.length, 0);
  assert.match(toasts[0]?.message, /读不到是否可移除/);
  assert.equal(new URL(context.location.href).searchParams.get('remove'), null);
});

test('closed comments display their bilingual status without retry', async () => {
  for (const [browserLanguage, label] of [['zh-CN', '已结案'], ['en-US', 'Closed']]) {
    const context = await renderContext({ browserLanguage });
    context.comment = { id: 'M-done', status: 'closed', notify: { state: 'failed' }, note: 'Handled note', images: [], times: { saved: new Date().toISOString(), closed: new Date().toISOString() } };
    const html = vm.runInContext('message(comment)', context);
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /undefined|data-action="retry"/);
  }
});
