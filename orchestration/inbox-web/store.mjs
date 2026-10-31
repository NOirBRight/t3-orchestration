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
  if (item.replaces !== undefined && (typeof item.replaces !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.replaces))) throw new Error('replaces 必须是原题 id');
  for (const field of ['title', 'askerThreadId', 'askerLabel']) requiredString(item[field], field);
  if (!(typeof item.ticket === 'string' || Number.isInteger(item.ticket))) throw new Error('ticket 必须是票号字符串或整数');
  for (const field of ['blocking', 'multi']) if (item[field] !== undefined && typeof item[field] !== 'boolean') throw new Error(`${field} 必须是布尔值`);
  if (item.background !== undefined && (!Array.isArray(item.background) || item.background.some(x => typeof x !== 'string'))) throw new Error('background 必须是字符串数组');
  if (item.recommendation !== undefined && typeof item.recommendation !== 'string') throw new Error('recommendation 必须是字符串');
  if (item.kind === 'decide') {
    if (!Array.isArray(item.options) || !item.options.length) throw new Error('options 必须至少有一个选项');
    if (item.multi === true && item.options.length < 2) throw new Error('multi 为 true 时至少需要两个选项');
    const keys = new Set();
    const allowed = new Set(['key', 'label', 'consequence', 'recommended']);
    item.options.forEach((option, i) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error(`options[${i}] 必须是选项对象`);
      const unknown = Object.keys(option).filter(field => !allowed.has(field));
      if (unknown.length) throw new Error(`options[${i}] 含未显示字段: ${unknown.join(', ')}`);
      for (const field of ['key', 'label', 'consequence']) requiredString(option[field], `options[${i}].${field}`);
      if (keys.has(option.key)) throw new Error(`options[${i}].key 重复`); keys.add(option.key);
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
function record(item, action, extra = {}) {
  const entry = { at: stamp(), action, status: item.status, answer: structuredClone(item.answer || null), submissionId: item.submissionId };
  if (extra.via) entry.via = extra.via;
  if (extra.actor) entry.actor = extra.actor;
  item.history.push(entry);
}
function conflict(message, reason, details = {}) {
  const error = new Error(message);
  error.status = 409;
  error.reason = reason;
  if (details.itemStatus !== undefined) error.itemStatus = details.itemStatus;
  else if (details.status !== undefined && typeof details.status === 'string') error.itemStatus = details.status;
  if (details.answeredVia !== undefined) error.answeredVia = details.answeredVia;
  if (details.submissionId !== undefined) error.submissionId = details.submissionId;
  if (details.replacedBy !== undefined) error.replacedBy = details.replacedBy;
  return error;
}
function missing(message = '条目不存在') {
  const error = new Error(message);
  error.status = 404;
  return error;
}
function forbidden(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}
function clipActor(actor) {
  if (actor === undefined || actor === null) return undefined;
  const text = String(actor).trim();
  if (!text) return undefined;
  return text.slice(0, 64);
}
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
    const prefix = input.kind === 'accept' ? 'A' : 'Q';
    let itemId = input.id;
    if (!itemId) {
      const taken = new Set(data.items.map(x => x.id));
      let n = 1;
      while (taken.has(`${prefix}${n}`)) n += 1;
      itemId = `${prefix}${n}`;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(itemId)) throw new Error('id 只能含字母、数字、下划线和短横线');
    if (data.items.some(x => x.id === itemId)) throw new Error('id 已存在');
    const original = input.replaces === undefined ? null : data.items.find(x => x.id === input.replaces);
    if (input.replaces !== undefined) {
      if (!original) throw new Error(`replaces 指向的 ${input.replaces} 不存在`);
      if (original.status === 'closed') throw new Error(`${original.id} 已结案，不能替换；要推翻结论请发不带 replaces 的新题`);
      if (original.status !== 'open') throw new Error(`${original.id} 已有 Owner 答复（${original.status}），没有发新题；先运行 pending 处理这条答复`);
    }
    const item = { id: itemId, kind: input.kind, title: input.title, ticket: input.ticket, askerThreadId: input.askerThreadId, askerLabel: input.askerLabel, blocking: input.blocking || false, createdAt: stamp(), background: input.background || [], options: input.kind === 'decide' ? input.options : [], multi: input.multi || false, recommendation: input.recommendation || '', media: input.media || [], status: 'open', answer: null, history: [], times: {}, forwardedTo: null, redo: false, notify: null, closedNote: '', answeredBy: null };
    item.media = item.media.map(media => ({ ...media, path: path.relative(campaign.dir, path.resolve(campaign.dir, media.path)).split(path.sep).join('/') }));
    record(item, 'ask'); data.items.push(item);
    if (original) { item.replaces = original.id; record(original, 'replace'); original.status = 'closed'; original.times.closed = item.createdAt; original.replacedBy = item.id; }
    this.save(id, data); return item;
  }
  validateImages(id, itemId, images = [], items = []) {
    if (!Array.isArray(images) || images.some(x => typeof x !== 'string')) throw new Error('answer.images 必须是上传引用数组');
    // 被替换的原题上传的图片随草稿带到新题，也算本题的图片。
    const owners = [itemId];
    for (let item = items.find(x => x.id === itemId); item?.replaces; item = items.find(x => x.id === item.replaces)) owners.push(item.replaces);
    for (const image of images) {
      const roots = owners.map(owner => path.join(this.campaign(id).dir, 'inbox', 'uploads', owner));
      if (!roots.some(root => inside(root, path.resolve(this.campaign(id).dir, image)))) throw new Error('images 必须引用本题上传的图片');
      mediaPath(this.campaign(id).dir, image);
    }
    return images;
  }
  submit(id, changes = [], messages = [], options = {}) {
    if (!Array.isArray(changes) || !Array.isArray(messages)) throw new Error('items 和 messages 必须是数组');
    const via = options.via || 'web';
    const actor = clipActor(options.actor);
    const relayStrict = via === 'relay' || (typeof via === 'string' && via.startsWith('relay:'));
    if (relayStrict && messages.length) throw forbidden('中继不能提交留言');
    const data = this.load(id), now = stamp(), touched = [], submissionId = randomUUID();
    // Validate the whole batch before writing so expect mismatches reject atomically.
    for (const change of changes) {
      const item = data.items.find(x => x.id === change.id);
      if (!item) throw missing();
      this.assertSubmitAllowed(item, change, { relayStrict });
      const answer = change.answer || {}, choices = answer.choices || [], note = answer.note || '';
      if (!Array.isArray(choices) || choices.some(x => typeof x !== 'string')) throw new Error('answer.choices 必须是字符串数组');
      if (typeof note !== 'string') throw new Error('answer.note 必须是字符串');
      if (new Set(choices).size !== choices.length) throw new Error('answer.choices 不可重复');
      this.validateImages(id, item.id, answer.images, data.items);
      if (item.kind === 'accept') {
        if (choices.length !== 1 || !['pass', 'rework'].includes(choices[0])) throw new Error('验收请选择 pass 或 rework');
        if (choices[0] === 'rework' && !note.trim()) throw new Error('返修必须填写说明');
      } else {
        const images = answer.images || [];
        if ((!choices.length && !note.trim() && !images.length) || (!item.multi && choices.length > 1) || choices.some(x => !item.options.some(o => o.key === x))) throw new Error('answer.choices 必须是有效选项，单选最多一个；未选时请留言或附图');
      }
    }
    for (const change of changes) {
      const item = data.items.find(x => x.id === change.id);
      const answer = change.answer || {}, choices = answer.choices || [], note = answer.note || '';
      const images = this.validateImages(id, item.id, answer.images, data.items);
      const answeredVia = relayStrict ? (via.startsWith('relay:') ? via : `relay:${options.tokenId || 'r'}`) : 'web';
      record(item, 'answer', { via: answeredVia, actor }); item.redo = item.redo || item.status === 'forwarded';
      item.answer = { choices, note, images }; item.withdrawalPending = false; item.answeredBy = 'owner';
      item.answeredVia = answeredVia;
      item.status = 'saved'; item.times = { saved: now }; item.notify = null; item.submissionId = submissionId; item.problemSent = false; touched.push(item.id);
    }
    const newMessages = messages.map(message => {
      if (typeof message.note !== 'string' || (!message.note.trim() && !message.images?.length)) throw new Error('留言不能为空');
      return { id: `M-${randomUUID()}`, note: message.note, images: this.validateImages(id, 'messages', message.images), status: 'saved', times: { saved: now }, submissionId, problemSent: false };
    });
    data.messages.push(...newMessages); this.save(id, data);
    return { items: touched, messages: newMessages.map(x => x.id) };
  }
  assertSubmitAllowed(item, change, { relayStrict }) {
    const expect = change.expect || {};
    if (item.status === 'closed') {
      if (item.replacedBy) throw conflict(`${item.id} 已换成新题 ${item.replacedBy}，请在新题作答`, 'replaced', { replacedBy: item.replacedBy, status: item.status });
      throw conflict(`${item.id} 已结案，只读`, 'closed', { status: item.status });
    }
    if (relayStrict) {
      if (item.status !== 'open') {
        throw conflict(`${item.id} 已有答复`, 'answered', {
          status: item.status,
          answeredVia: item.answeredVia || 'web',
          submissionId: item.submissionId || null,
        });
      }
      if (expect.questionId !== undefined && expect.questionId !== item.id) {
        throw conflict('expect.questionId 与当前题不符', 'stale', { status: item.status, submissionId: item.submissionId || null });
      }
      if (expect.status !== undefined && expect.status !== item.status) {
        throw conflict('expect.status 与当前状态不符', 'stale', { status: item.status, submissionId: item.submissionId || null });
      }
      if (expect.submissionId !== undefined && expect.submissionId !== (item.submissionId || null)) {
        throw conflict('expect.submissionId 与当前版本不符', 'stale', { status: item.status, submissionId: item.submissionId || null });
      }
      return;
    }
    // Web / trusted LAN keep existing overwrite behaviour (decision 45 confirmed).
    if (expect.questionId !== undefined && expect.questionId !== item.id) {
      throw conflict('expect.questionId 与当前题不符', 'stale', { status: item.status, submissionId: item.submissionId || null });
    }
    if (expect.submissionId !== undefined && item.submissionId && expect.submissionId !== item.submissionId) {
      throw conflict('expect.submissionId 与当前版本不符', 'stale', { status: item.status, submissionId: item.submissionId || null });
    }
  }
  change(id, itemId, action, options = {}) {
    const data = this.load(id), item = [...data.items, ...data.messages].find(x => x.id === itemId);
    if (!item) throw missing();
    if (!item.kind && !['ack', 'close'].includes(action)) throw new Error('留言只支持确认已读或结案');
    if (item.status === 'closed') throw new Error('已结案，只读');
    if (action === 'ack' && (options.submission !== undefined || item.withdrawalPending) && options.submission !== item.submissionId) throw new Error('答复或撤回已变化：重新运行 pending，并用 --submission 确认当前事件');
    if (['forward', 'close'].includes(action) && item.withdrawalPending) throw new Error('答复已撤回：先运行 pending，停止按旧答复执行并 ack 撤回');
    if (action === 'close' && item.kind && item.status === 'open' && options.by !== 'orchestrator') throw new Error('未答题不能按旧答复结案；编排代答须明确指定 by=orchestrator');
    if (action === 'close' && options.by === 'orchestrator' && item.answeredBy === 'owner') throw new Error('Owner has answered; the orchestrator cannot overwrite it');
    // 改答会把题目退回 saved/notified；编排没 ack 最新答复前，不能按旧一轮读到的答复转交或结案。
    if (['forward', 'close'].includes(action) && item.kind && ['saved', 'notified'].includes(item.status)) throw new Error(`${item.id} 有还没读的新答复：先运行 pending 读最新答复并 ack，再按最新答复处理`);
    if (action === 'withdraw' && !['saved', 'notified', 'read'].includes(item.status)) throw new Error('只能撤回编排处理前的答复');
    if (action === 'withdraw' && options.via === 'relay') {
      const tokenVia = options.tokenId ? `relay:${options.tokenId}` : null;
      if (!item.answeredVia || !String(item.answeredVia).startsWith('relay:') || (tokenVia && item.answeredVia !== tokenVia)) {
        throw conflict('中继只能撤回本令牌写入的答复', 'forbidden-withdraw', {
          status: item.status,
          answeredVia: item.answeredVia || null,
          submissionId: item.submissionId || null,
        });
      }
      const expectId = options.expect?.submissionId;
      if (expectId !== undefined && expectId !== item.submissionId) {
        throw conflict('expect.submissionId 与当前版本不符', 'stale', { status: item.status, submissionId: item.submissionId || null });
      }
    }
    if (action === 'ack' && !item.withdrawalPending && !['saved', 'notified', 'read'].includes(item.status)) throw new Error('此状态不能确认已读');
    if (action === 'forward' && (!['saved', 'notified', 'read', 'forwarded'].includes(item.status) || !item.kind)) throw new Error('此状态不能转交');
    const actor = clipActor(options.actor);
    const via = options.via === 'relay' && options.tokenId ? `relay:${options.tokenId}` : options.via;
    if (item.history) record(item, action, { via, actor });
    const now = stamp();
    if (action === 'withdraw') {
      item.redo = item.redo || item.status === 'read';
      item.withdrawalPending = true;
      item.status = 'open';
      item.answer = null;
      item.notify = null;
      item.answeredBy = null;
      item.answeredVia = null;
      item.times = { withdrawn: now };
      item.submissionId = randomUUID();
      item.problemSent = false;
    }
    else if (action === 'ack') { if (item.withdrawalPending) { item.withdrawalPending = false; item.times.withdrawalRead = now; } else { item.status = 'read'; item.times.read = now; } }
    else if (action === 'forward') { requiredString(options.to, 'to'); item.status = 'forwarded'; item.forwardedTo = options.to; item.times.forwarded = now; }
    else if (action === 'close') { item.status = 'closed'; item.times.closed = now; item.closedNote = options.note || ''; if (options.by === 'orchestrator') item.answeredBy = 'orchestrator'; }
    else throw new Error('未知操作');
    this.save(id, data); return item;
  }
  relayResult(id, itemId, result) {
    const data = this.load(id), item = data.items.find(entry => entry.id === itemId);
    if (!item) return;
    item.relay = { state: result.state, at: result.at, event: result.event, attempts: result.attempts };
    this.save(id, data);
  }
  claimRelayProblem(id, itemId) {
    const data = this.load(id), item = data.items.find(entry => entry.id === itemId);
    if (!item || item.relayProblemSent) return false;
    item.relayProblemSent = true;
    this.save(id, data);
    return true;
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
    return { items: data.items.filter(x => x.withdrawalPending || ['saved', 'notified', 'read'].includes(x.status)).map(x => ({ ...x, answer: x.answer ? { ...x.answer, images: x.answer.images.map(image => path.resolve(root, image)) } : null })), messages: data.messages.filter(x => ['saved', 'notified'].includes(x.status)).map(x => ({ ...x, images: x.images.map(image => path.resolve(root, image)) })) };
  }
  view(id) {
    const data = this.load(id), campaign = this.campaign(id);
    // 进度改由只读看板（GET /api/kanban）提供，这里只给题目和留言。
    return { campaign, ...data, items: data.items.sort((a, b) => Number(b.blocking && b.status === 'open') - Number(a.blocking && a.status === 'open') || Number(b.status === 'open') - Number(a.status === 'open') || Date.parse(a.createdAt) - Date.parse(b.createdAt)) };
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
