// 看板的纯逻辑（筛选、列、持久化、时间），不碰 DOM，便于单测。
export const STATUS = ['queued', 'running', 'blocked', 'verify', 'delivered', 'rework', 'merge', 'merged', 'closed'];
export const COLUMNS = ['owner', ...STATUS];
export const DEFAULT_COLUMNS = ['owner', 'running', 'blocked', 'rework'];
export const KEYS = { columns: 'pmKanban.v2.columns', filters: 'pmKanban.v2.filters' };
export const emptyFilters = () => ({ status: [], version: [], machine: [], ownerOnly: false });

const parse = raw => { try { return JSON.parse(raw); } catch { return undefined; } };
const strings = value => Array.isArray(value) && value.every(x => typeof x === 'string');

export function readColumns(raw) {
  const value = parse(raw);
  if (!Array.isArray(value) || value.some(key => !COLUMNS.includes(key))) return [...DEFAULT_COLUMNS];
  return COLUMNS.filter(key => value.includes(key));
}

export function readFilters(raw) {
  const value = parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyFilters();
  const { status, version, machine, ownerOnly } = value;
  if (!strings(status) || status.some(x => !STATUS.includes(x)) || !strings(version) || !strings(machine) || typeof ownerOnly !== 'boolean') return emptyFilters();
  return { status: [...status], version: [...version], machine: [...machine], ownerOnly };
}

// 维度之间取交集，同一维度内取并集；空维度不限制。没有版本、机器的票用空字符串表示。
export function matchesFilters(ticket, filters) {
  return (!filters.status.length || filters.status.includes(ticket.status))
    && (!filters.version.length || filters.version.includes(ticket.version ?? ''))
    && (!filters.machine.length || filters.machine.includes(ticket.machine ?? ''))
    && (!filters.ownerOnly || ticket.needsOwner);
}

export const columnTickets = (tickets, key) => tickets.filter(ticket => (key === 'owner' ? ticket.needsOwner : ticket.status === key));
export const ownerCount = tickets => tickets.filter(ticket => ticket.needsOwner).length;
export const activeFilters = filters => filters.status.length + filters.version.length + filters.machine.length + (filters.ownerOnly ? 1 : 0);
export const cardTitle = (ticket, separator = '：') => `${ticket.id}${separator}${ticket.title}`;
export const blocks = (tickets, id) => tickets.filter(ticket => (ticket.dependsOn || []).includes(id)).map(ticket => ticket.id);
// 提示条：有待确认用强调色，没有时中性显示“暂无待你确认”。
export const noticeState = n => (n ? { tone: 'accent', key: 'kb.notice' } : { tone: 'none', key: 'kb.noticeNone' });

const compareVersion = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return a.localeCompare(b);
};
export function filterOptions(tickets) {
  const collect = (field, compare) => {
    const values = [...new Set(tickets.map(ticket => ticket[field] ?? ''))];
    return [...values.filter(Boolean).sort(compare), ...(values.includes('') ? [''] : [])];
  };
  return { version: collect('version', compareVersion), machine: collect('machine', (a, b) => a.localeCompare(b)) };
}

// 时间一律按 UTC+8 显示，不跟浏览器时区。
export function formatUtc8(time) {
  const ms = Date.parse(time ?? '');
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 8 * 3600000), pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
