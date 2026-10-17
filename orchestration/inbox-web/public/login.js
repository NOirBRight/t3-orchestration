import { chooseLanguage, translate } from './i18n.js';

let language = chooseLanguage(localStorage.getItem('inbox-language'), navigator.language);
const root = document.getElementById('login');
const url = new URL(location.href);
let blocked = false;
const theme = localStorage.getItem('inbox-theme') || 'auto';
const systemTheme = matchMedia('(prefers-color-scheme:dark)');
function applyTheme() { document.documentElement.dataset.theme = theme === 'auto' ? (systemTheme.matches ? 'dark' : 'light') : theme; }
applyTheme(); systemTheme.addEventListener('change', applyTheme);
const failed = url.searchParams.has('k');
url.searchParams.delete('k');
history.replaceState(null, '', url);
function render() {
  const t = key => translate(language, key);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  root.innerHTML = `<button class="button" type="button" id="language" aria-label="${t('语言')}">${language === 'zh' ? 'English' : '中文'}</button><h1>${t('登录 Inbox')}</h1><p>${t('请使用口令链接，或输入口令登录。')}</p>${blocked || failed ? `<p role="alert">${t(blocked ? '尝试过多，请稍后再试' : '口令无效')}</p>` : ''}<form><label for="passphrase">${t('口令')}</label><input id="passphrase" type="password" autocomplete="current-password" required><button class="button primary" type="submit">${t('登录')}</button></form>`;
  document.getElementById('language').onclick = () => {
    language = language === 'zh' ? 'en' : 'zh';
    localStorage.setItem('inbox-language', language); render();
  };
  root.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const target = new URL(url); target.searchParams.set('k', document.getElementById('passphrase').value);
    location.replace(target);
  };
}
render();

fetch(new URL('api/summary', location.href)).then(response => { if (response.status === 429) { blocked = true; render(); } }).catch(() => {});
