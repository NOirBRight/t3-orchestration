import { t } from './state.js';
import { esc } from './icons.js';

export const letter = index => String.fromCharCode(65 + index);
export const minutesSince = time => Math.max(0, Math.floor((Date.now()-Date.parse(time))/60000));
export function ago(time) { const n = minutesSince(time); return n < 1 ? t('刚刚') : n < 60 ? t('minutes', n) : n < 1440 ? t('hoursMinutes', Math.floor(n/60), n%60) : t('days', Math.floor(n/1440)); }
// 时间一律带上日期语境：一小时内说“几分钟前”，再往前写今天／昨天／几月几日。
export function when(time) {
  if (!time) return '';
  const date = new Date(time), minutes = Math.floor((new Date() - date) / 60000);
  if (minutes < 1) return t('刚刚'); if (minutes < 60) return t('minutesAgo', minutes);
  return onDay(date);
}
// 按日历日写“今天／昨天／明天 几点”，再远写几月几日；将来的时间（额度恢复）也用这里。
export function onDay(date) {
  const now = new Date(), clock = date.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false});
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  return days === 0 ? t('today', clock) : days === 1 ? t('yesterday', clock) : days === -1 ? t('tomorrow', clock) : t('date', date.getMonth()+1,date.getDate(),clock);
}
// 卡片右上角只要量级：一小时内到分钟，一天内到小时，再往后按天。
export const waited = time => { const n = minutesSince(time); return n < 1 ? t('刚到') : n < 60 ? t('waitMinutes',n) : n < 1440 ? t('waitHours',Math.floor(n/60)) : t('waitDays',Math.floor(n/1440)); };
// 提问者标签常以票号开头，票号已单独显示，这里去掉重复。
export const asker = item => String(item.askerLabel || '').replace(String(item.ticket), '').replace(/^[\s·:：-]+/, '') || item.askerLabel;
// Text documents (release checklists, reports) open in a reader instead of an <img>.
// Escape first, then a small Markdown subset; links stay http(s) only.
export function markdown(text) {
  const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return esc(text).split(/\r?\n/).map(line => {
    const heading = line.match(/^(#{1,4})\s+(.*)/), item = line.match(/^(\s*)[-*]\s+(\[( |x|X)\]\s+)?(.*)/);
    if (heading) return `<p class="md-h${heading[1].length}">${inline(heading[2])}</p>`;
    if (item) return `<p class="md-li" style="--indent:${Math.min(item[1].length,8)}">${item[2] ? (item[3] === ' ' ? '☐' : '☑') : '•'} ${inline(item[4])}</p>`;
    return line.trim() ? `<p>${inline(line)}</p>` : '';
  }).join('');
}
export const mediaKind = path => /\.(mp4|webm|mov)$/i.test(path || '') ? 'video' : /\.(md|markdown|txt|log|csv|json)$/i.test(path || '') ? 'doc' : 'image';
