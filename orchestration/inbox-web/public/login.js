import { chooseLanguage, translate } from './i18n.js';

let language = chooseLanguage(localStorage.getItem('inbox-language'), navigator.language);
const root = document.getElementById('login');
const url = new URL(location.href);
let blocked = url.searchParams.get('login') === 'blocked';
let failed = url.searchParams.get('login') === 'failed' || url.searchParams.has('k');
url.searchParams.delete('k');
url.searchParams.delete('login');
history.replaceState(null, '', url);
const theme = localStorage.getItem('inbox-theme') || 'auto';
const systemTheme = matchMedia('(prefers-color-scheme:dark)');
function applyTheme() { document.documentElement.dataset.theme = theme === 'auto' ? (systemTheme.matches ? 'dark' : 'light') : theme; }
applyTheme(); systemTheme.addEventListener('change', applyTheme);
function render() {
  const t = key => translate(language, key);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  root.innerHTML = `<button class="button" type="button" id="language" aria-label="${t('语言')}">${language === 'zh' ? 'English' : '中文'}</button><h1>${t('登录 Inbox')}</h1><p>${t('请使用口令链接，输入口令，或输入终端显示的一次性码登录。')}</p>${blocked || failed ? `<p role="alert">${t(blocked ? '尝试过多，请稍后再试' : '口令无效')}</p>` : ''}<form method="post" action=""><label for="passphrase">${t('口令')}</label><input id="passphrase" name="k" type="password" autocomplete="current-password"><label for="device-code">${t('一次性码')}</label><input id="device-code" name="code" type="password" inputmode="text" autocomplete="one-time-code" spellcheck="false" autocapitalize="characters"><button class="button primary" type="submit">${t('登录')}</button></form>`;
  document.getElementById('language').onclick = () => {
    language = language === 'zh' ? 'en' : 'zh';
    localStorage.setItem('inbox-language', language); render();
  };
}
render();

fetch(new URL('api/summary', location.href)).then(response => { if (response.status === 429) { blocked = true; render(); } }).catch(() => {});
