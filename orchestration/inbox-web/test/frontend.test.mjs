import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('manifest 请求携带远程入口 cookie', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link\b(?=[^>]*rel="manifest")(?=[^>]*crossorigin="use-credentials")[^>]*>/);
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

// 运行真实渲染函数；不启动网络、DOM 事件和定时刷新。
function renderContext({ browserLanguage = 'zh-CN', savedLanguage = null } = {}) {
  const context = vm.createContext({
    navigator: { language: browserLanguage },
    document: { getElementById: () => ({}), documentElement: { dataset: {} } },
    location: { href: 'https://example.test/?campaign=test' }, URL,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem(key) { return key === 'inbox-language' ? savedLanguage : null; } },
  });
  return Promise.all([readFile(new URL('../public/i18n.js', import.meta.url), 'utf8'), readFile(new URL('../public/app.js', import.meta.url), 'utf8')]).then(([dictionary, source]) => { vm.runInContext(dictionary.replaceAll('export ', ''), context); source = source.replace(/^import .*;\r?\n/, ''); vm.runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context); return context; });
}

test('短页面导航保持点击项，用户滚动后恢复位置高亮', async () => {
  const context = await renderContext(), listeners = {};
  const links = ['decide', 'accept', 'message', 'progress'].map(name => ({
    hash: `#sec-${name}`, active: false,
    classList: { toggle(name, on) { this.link.active = on; } },
  }));
  links.forEach(link => { link.classList.link = link; });
  const tops = [80, 300, 580, 780];
  Object.assign(context, {
    scrollY: 0, innerHeight: 800,
    addEventListener(name, handler) { listeners[name] = handler; },
    navigator: {}, setInterval() {},
  });
  Object.assign(context.document, {
    querySelectorAll: selector => selector === '.tabs a' ? links : [],
    querySelector: selector => {
      const index = links.findIndex(link => link.hash === selector);
      return index < 0 ? null : { getBoundingClientRect: () => ({ top: tops[index] - context.scrollY }) };
    },
    addEventListener(name, handler) { listeners[name] = handler; },
    body: { classList: { toggle() {} } },
  });
  context.document.documentElement.scrollHeight = 1000;
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf("document.addEventListener('click'"), source.lastIndexOf('\nrender();')), context);
  const active = () => links.find(link => link.active)?.hash;
  const click = async index => {
    await listeners.click({ target: { closest: selector => selector === '.tabs a' ? links[index] : null } });
  };
  vm.runInContext('spy()', context);
  assert.equal(active(), '#sec-decide');
  await click(2);
  assert.equal(active(), '#sec-message');
  context.scrollY = 200; listeners.scroll(); // 锚点滚动被页面底部截断。
  assert.equal(active(), '#sec-message');
  vm.runInContext('spy()', context); // 定时刷新重新渲染也不覆盖选择。
  assert.equal(active(), '#sec-message');
  await click(3); // 已经在底部，不产生新 scroll 事件。
  assert.equal(active(), '#sec-progress');
  await click(1);
  assert.equal(active(), '#sec-accept');
  listeners.touchmove({});
  context.scrollY = 0; listeners.scroll();
  assert.equal(active(), '#sec-decide');
  for (const [name, event] of [['wheel', {}], ['keydown', { key: 'Home', target: { closest: () => null } }], ['pointerdown', { clientX: 400 }]]) {
    context.document.documentElement.clientWidth = 400;
    await click(2);
    context.scrollY = 200; listeners.scroll();
    assert.equal(active(), '#sec-message');
    listeners[name](event);
    context.scrollY = 0; listeners.scroll();
    assert.equal(active(), '#sec-decide', name);
  }
});

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
  Object.assign(context, { isSecureContext: true, window: { PushManager: class {} }, scrollY: 0, scrollTo() {}, spy() {} });
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  const now = new Date().toISOString();
  context.fixture = {
    id: 'Q1', ticket: '#10', askerLabel: '#10 Thread', kind: 'decide', status: 'open', blocking: true, multi: true,
    title: 'Choose a mode', background: ['Context '.repeat(50)], recommendation: 'Use A', createdAt: now,
    media: [{ path: 'image.png' }], options: [{ key: 'a', label: 'Mode A', recommended: true, consequence: 'Faster' }, { key: 'b', label: 'Mode B' }],
  };
  vm.runInContext(`
    machine = 'desktop'; campaign = 'demo'; menu = true;
    summary = { name:'desktop', hub:true, remote:true, campaigns:[{id:'demo',title:'Demo',pending:2}], peers:[{name:'offline',unavailable:true}] };
    data = { remote:true, campaign:{title:'Demo'}, items:[fixture], messages:[], progress:{ groups:[{title:'进行中',tickets:[{ticket:'#10',title:'Security',stage:'执行中'}]},{title:'24 小时内完成',completed:true,tickets:[{ticket:'#9',title:'Done',stage:'已合并'}]}], olderCompleted:2 } };
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
  assert.match(english('progress()'), /In progress/);
  assert.match(english('renderMenu()'), /Unavailable/);
  assert.match(english('header()', { selector: true }), /Enable notifications/);
  assert.match(english('side()'), /Note to orchestrator/);
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
