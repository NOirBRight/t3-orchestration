import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson } from './config.mjs';

export function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function mediaPath(dir, relative) {
  const file = path.resolve(dir, relative);
  if (!inside(dir, file)) throw new Error('media.path 必须在 Campaign 目录内');
  const real = fs.realpathSync(file);
  if (!inside(fs.realpathSync(dir), real) || !fs.statSync(real).isFile()) throw new Error('media.path 必须指向 Campaign 内文件');
  return real;
}
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`); }
export function validateItem(item, dir) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('题稿必须是对象');
  if (!['decide', 'accept'].includes(item.kind)) throw new Error('kind 必须是 decide 或 accept');
  if (item.id !== undefined && (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.id))) throw new Error('id 必须是只含字母、数字、下划线和短横线的字符串');
  for (const field of ['title', 'askerThreadId', 'askerLabel']) requiredString(item[field], field);
  if (!(typeof item.ticket === 'string' || Number.isInteger(item.ticket))) throw new Error('ticket 必须是票号字符串或整数');
  for (const field of ['blocking', 'multi']) if (item[field] !== undefined && typeof item[field] !== 'boolean') throw new Error(`${field} 必须是布尔值`);
  if (item.background !== undefined && (!Array.isArray(item.background) || item.background.some(x => typeof x !== 'string'))) throw new Error('background 必须是字符串数组');
  if (item.recommendation !== undefined && typeof item.recommendation !== 'string') throw new Error('recommendation 必须是字符串');
  if (item.kind === 'decide') {
    if (!Array.isArray(item.options) || !item.options.length) throw new Error('options 必须至少有一个选项');
    const keys = new Set();
    item.options.forEach((option, i) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error(`options[${i}] 必须是选项对象`);
      for (const field of ['key', 'label']) requiredString(option[field], `options[${i}].${field}`);
      if (keys.has(option.key)) throw new Error(`options[${i}].key 重复`); keys.add(option.key);
      if (option.consequence !== undefined && typeof option.consequence !== 'string') throw new Error(`options[${i}].consequence 必须是字符串`);
      if (option.recommended !== undefined && typeof option.recommended !== 'boolean') throw new Error(`options[${i}].recommended 必须是布尔值`);
    });
  } else if (item.options?.length) throw new Error('验收题没有 options');
  if (item.media !== undefined && !Array.isArray(item.media)) throw new Error('media 必须是数组');
  for (const [i, media] of (item.media || []).entries()) {
    if (!media || typeof media !== 'object' || Array.isArray(media)) throw new Error(`media[${i}] 必须是素材对象`);
    requiredString(media.path, `media[${i}].path`);
    if (media.caption !== undefined && typeof media.caption !== 'string') throw new Error(`media[${i}].caption 必须是字符串`);
    try { mediaPath(dir, media.path); } catch { throw new Error(`media[${i}].path 必须是 Campaign 目录内可读文件`); }
  }
  return item;
}
function stamp() { return new Date().toISOString(); }
function record(item, action) { item.history.push({ at: stamp(), action, status: item.status, answer: structuredClone(item.answer || null), submissionId: item.submissionId }); }
export class InboxStore {
  constructor(config) { this.config = config; }
  campaign(id) { const c = this.config.campaigns.find(x => x.id === id); if (!c) throw new Error('Campaign 不存在'); return c; }
  load(id) {
    const data = { items: [], messages: [], ...readJson(path.join(this.campaign(id).dir, 'inbox.json'), {}) };
    // Legacy persisted attribution: normalize on read without rewriting the file.
    for (const item of data.items) if (item.answeredBy && !['owner', 'orchestrator'].includes(item.answeredBy)) item.answeredBy = 'owner';
    return data;
  }
  save(id, data) { atomicJson(path.join(this.campaign(id).dir, 'inbox.json'), data); }
  ask(id, input) {
    const campaign = this.campaign(id); validateItem(input, campaign.dir);
    const data = this.load(id);
    const itemId = input.id || `${input.kind === 'accept' ? 'A' : 'Q'}${data.items.length + 1}`;
    if (!/^[A-Za-z0-9_-]+$/.test(itemId)) throw new Error('id 只能含字母、数字、下划线和短横线');
    if (data.items.some(x => x.id === itemId)) throw new Error('id 已存在');
    const item = { id: itemId, kind: input.kind, title: input.title, ticket: input.ticket, askerThreadId: input.askerThreadId, askerLabel: input.askerLabel, blocking: input.blocking || false, createdAt: stamp(), background: input.background || [], options: input.kind === 'decide' ? input.options : [], multi: input.multi || false, recommendation: input.recommendation || '', media: input.media || [], status: 'open', answer: null, history: [], times: {}, forwardedTo: null, redo: false, notify: null, closedNote: '', answeredBy: null };
    item.media = item.media.map(media => ({ ...media, path: path.relative(campaign.dir, path.resolve(campaign.dir, media.path)).split(path.sep).join('/') }));
    record(item, 'ask'); data.items.push(item); this.save(id, data); return item;
  }
  validateImages(id, itemId, images = []) {
    if (!Array.isArray(images) || images.some(x => typeof x !== 'string')) throw new Error('answer.images 必须是上传引用数组');
    for (const image of images) {
      const root = path.join(this.campaign(id).dir, 'inbox', 'uploads', itemId);
      if (!inside(root, path.resolve(this.campaign(id).dir, image))) throw new Error('images 必须引用本题上传的图片');
      mediaPath(this.campaign(id).dir, image);
    }
    return images;
  }
  submit(id, changes = [], messages = []) {
    if (!Array.isArray(changes) || !Array.isArray(messages)) throw new Error('items 和 messages 必须是数组');
    const data = this.load(id), now = stamp(), touched = [], submissionId = randomUUID();
    for (const change of changes) {
      const item = data.items.find(x => x.id === change.id); if (!item) throw new Error('条目不存在');
      if (item.status === 'closed') throw new Error(`${item.id} 已结案，只读`);
      const answer = change.answer || {}, choices = answer.choices || [], note = answer.note || '';
      if (!Array.isArray(choices) || choices.some(x => typeof x !== 'string')) throw new Error('answer.choices 必须是字符串数组');
      if (typeof note !== 'string') throw new Error('answer.note 必须是字符串');
      if (new Set(choices).size !== choices.length) throw new Error('answer.choices 不可重复');
      const images = this.validateImages(id, item.id, answer.images);
      if (item.kind === 'accept') {
        if (choices.length !== 1 || !['pass', 'rework'].includes(choices[0])) throw new Error('验收请选择 pass 或 rework');
        if (choices[0] === 'rework' && !note.trim()) throw new Error('返修必须填写说明');
      } else {
        if ((!choices.length && !note.trim() && !images.length) || (!item.multi && choices.length > 1) || choices.some(x => !item.options.some(o => o.key === x))) throw new Error('answer.choices 必须是有效选项，单选最多一个；未选时请留言或附图');
      }
      record(item, 'answer'); item.redo = item.redo || item.status === 'forwarded';
      item.answer = { choices, note, images }; item.answeredBy = 'owner'; item.status = 'saved'; item.times = { saved: now }; item.notify = null; item.submissionId = submissionId; item.problemSent = false; touched.push(item.id);
    }
    const newMessages = messages.map(message => {
      if (typeof message.note !== 'string' || (!message.note.trim() && !message.images?.length)) throw new Error('留言不能为空');
      return { id: `M-${randomUUID()}`, note: message.note, images: this.validateImages(id, 'messages', message.images), status: 'saved', times: { saved: now }, submissionId, problemSent: false };
    });
    data.messages.push(...newMessages); this.save(id, data);
    return { items: touched, messages: newMessages.map(x => x.id) };
  }
  change(id, itemId, action, options = {}) {
    const data = this.load(id), item = [...data.items, ...data.messages].find(x => x.id === itemId);
    if (!item) throw new Error('条目不存在');
    if (!item.kind && action !== 'ack') throw new Error('留言只支持确认已读');
    if (item.status === 'closed') throw new Error('已结案，只读');
    if (action === 'close' && options.by === 'orchestrator' && item.answeredBy === 'owner') throw new Error('Owner has answered; the orchestrator cannot overwrite it');
    if (action === 'withdraw' && !['saved', 'notified', 'read'].includes(item.status)) throw new Error('只能撤回编排处理前的答复');
    if (action === 'ack' && !['saved', 'notified', 'read'].includes(item.status)) throw new Error('此状态不能确认已读');
    if (action === 'forward' && (!['saved', 'notified', 'read', 'forwarded'].includes(item.status) || !item.kind)) throw new Error('此状态不能转交');
    if (item.history) record(item, action);
    const now = stamp();
    if (action === 'withdraw') { item.status = 'open'; item.answer = null; item.notify = null; item.answeredBy = null; item.times = { withdrawn: now }; }
    else if (action === 'ack') { item.status = 'read'; item.times.read = now; }
    else if (action === 'forward') { requiredString(options.to, 'to'); item.status = 'forwarded'; item.forwardedTo = options.to; item.times.forwarded = now; }
    else if (action === 'close') { item.status = 'closed'; item.times.closed = now; item.closedNote = options.note || ''; if (options.by === 'orchestrator') item.answeredBy = 'orchestrator'; }
    else throw new Error('未知操作');
    this.save(id, data); return item;
  }
  notified(id, ids, messageIds, result, revisions = {}) {
    const data = this.load(id), now = stamp();
    for (const item of [...data.items.filter(x => ids.includes(x.id)), ...data.messages.filter(x => messageIds.includes(x.id))]) {
      if (revisions[item.id] !== undefined && revisions[item.id] !== JSON.stringify({ answer: item.answer, saved: item.times.saved, withdrawn: item.times.withdrawn, submissionId: item.submissionId })) continue;
      if (item.history) record(item, 'notify');
      item.notify = { state: result, at: now };
      if (result === 'accepted' && item.status === 'saved') { item.status = 'notified'; item.times.notified = now; }
    }
    this.save(id, data);
  }
  claimSubmissionProblem(id, submissionId) {
    if (!submissionId) return false;
    const data = this.load(id);
    const members = [...data.items, ...data.messages].filter(item => item.submissionId === submissionId);
    if (!members.length || members.some(item => item.problemSent)) return false;
    for (const item of members) item.problemSent = true;
    this.save(id, data); return true;
  }
  pushResult(id, itemId, result) {
    const data = this.load(id), item = data.items.find(item => item.id === itemId);
    if (!item) return;
    item.push = { sent: result.sent, at: result.at, endpoints: result.endpoints };
    this.save(id, data);
  }
  pending(id) {
    const data = this.load(id), root = this.campaign(id).dir;
    return { items: data.items.filter(x => ['saved', 'notified', 'read'].includes(x.status)).map(x => ({ ...x, answer: x.answer ? { ...x.answer, images: x.answer.images.map(image => path.resolve(root, image)) } : null })), messages: data.messages.filter(x => ['saved', 'notified'].includes(x.status)).map(x => ({ ...x, images: x.images.map(image => path.resolve(root, image)) })) };
  }
  view(id) {
    const data = this.load(id), campaign = this.campaign(id), state = readJson(path.join(campaign.dir, 'campaign.json'), {});
    const tickets = Array.isArray(state.tickets) ? state.tickets : [];
    const completed = ticket => /^(已合并|已关闭|移出范围)/.test(ticket.stage || '') || ['closed', 'done', 'merged'].includes(ticket.status);
    const active = tickets.filter(ticket => !completed(ticket));
    const recent = tickets.filter(ticket => completed(ticket) && Date.now() - Date.parse(ticket.since || ticket.completedAt) <= 86400000);
    return { campaign, ...data, items: data.items.sort((a, b) => Number(b.blocking && b.status === 'open') - Number(a.blocking && a.status === 'open') || Number(b.status === 'open') - Number(a.status === 'open') || Date.parse(a.createdAt) - Date.parse(b.createdAt)), progress: { groups: [{ title: '进行中', tickets: active, completed: false }, { title: '24 小时内完成', tickets: recent, completed: true }], olderCompleted: tickets.length - active.length - recent.length } };
  }
}
export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { extension: 'png', mime: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: 'jpg', mime: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return { extension: 'gif', mime: 'image/gif' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(bytes.toString('ascii', 8, 12))) return { extension: 'heic', mime: 'image/heic' };
  return null;
}
