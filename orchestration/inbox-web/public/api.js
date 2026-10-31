import { state } from './state.js';
import { translateError } from './i18n.js';

// 页面、媒体、上传共用这里；地址保持相对路径，支持远程路径前缀。
export const machineBase = name => new URL(`/${encodeURIComponent(name)}/`, location.href);
export function address(route) { if (state.summary?.hub) return new URL(route, machineBase(state.machine)); return new URL(route, state.data?.lanHttpsUrl && !state.data.remote ? state.data.lanHttpsUrl.replace(/\/?$/, '/') : new URL('./', location.href)); }
export async function api(route, value, base, method = 'POST') {
  const response = await fetch(base ? new URL(route, base) : address(route), value === undefined ? {} : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  // A proxy in front of the Inbox (remote tunnel restarting, gateway timeout) can answer without JSON.
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw Object.assign(new Error(translateError(state.language, result?.error || '服务暂时连不上，请稍后重试')), {status:response.status});
  return result;
}
export function mediaUrl(ref) {
  const path = typeof ref === 'string' ? ref : ref.path;
  return address(`media/${encodeURIComponent(state.campaign)}/${String(path).split(/[\\/]/).map(encodeURIComponent).join('/')}`).href;
}
export const pageBase = () => new URL('./', location.href);
