import { state, t } from './state.js';
import { toast } from './ui.js';

export const draftKey = () => `inbox-drafts:${state.machine}:${state.campaign}`;
export function readDrafts() { try { state.drafts = JSON.parse(localStorage.getItem(draftKey()) || '{}'); } catch { state.drafts = {}; } state.editing = new Set(Object.keys(state.drafts).filter(id => state.drafts[id].editing)); }
export function saveDrafts() { localStorage.setItem(draftKey(), JSON.stringify(state.drafts)); }
export const draft = id => state.drafts[id] ||= {choices:[],note:'',images:[]};
export const hasDraft = id => !!state.drafts[id] && (state.drafts[id].choices?.length || state.drafts[id].note?.trim() || state.drafts[id].images?.length);
export const isEditing = item => item.status !== 'closed' && (item.status === 'open' || state.editing.has(item.id));
// 编排换题后，把原题上没提交的草稿带到最新的替换题，只保留新题仍有的选项。
export function carryDrafts() {
  let carried = 0;
  for (const old of state.data?.items || []) {
    let next = state.data.items.find(i => i.id === old.replacedBy);
    while (next?.replacedBy) next = state.data.items.find(i => i.id === next.replacedBy);
    if (!next || next.status !== 'open' || !hasDraft(old.id) || hasDraft(next.id)) continue;
    const {choices = [], note = '', images = []} = state.drafts[old.id], valid = choices.filter(key => next.kind === 'accept' ? ['pass','rework'].includes(key) : next.options.some(o => o.key === key));
    state.drafts[next.id] = {choices: next.multi ? valid : valid.slice(0,1), note, images};
    delete state.drafts[old.id]; state.editing.delete(old.id); carried++;
  }
  if (carried) { saveDrafts(); toast(t('draftCarried')); }
}
export const targets = () => state.data.items.filter(i => isEditing(i) && hasDraft(i.id));
export const countDrafts = () => targets().length + (hasDraft('__message') ? 1 : 0);
export const late = item => item.status === 'notified' && Date.now() - Date.parse(item.times?.notified) >= 15 * 60000;
// Once the orchestrator has read an answer (e.g. on patrol), an earlier failed notification no longer matters and cannot be resent.
export const notifyFailed = item => ['saved', 'notified'].includes(item.status) && item.notify?.state === 'failed';
