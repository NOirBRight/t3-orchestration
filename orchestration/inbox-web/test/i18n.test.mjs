import test from 'node:test';
import assert from 'node:assert/strict';
import { messages, chooseLanguage, translate } from '../public/i18n.js';

test('浏览器自动选择中英，记住的手选语言优先', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans-CN', 'ZH-cn']) assert.equal(chooseLanguage(null, locale), 'zh', locale);
  for (const locale of ['en', 'en-US', 'fr-FR', '', 'not-a-locale']) assert.equal(chooseLanguage(null, locale), 'en', locale);
  assert.equal(chooseLanguage('en', 'zh-CN'), 'en');
  assert.equal(chooseLanguage('zh', 'en-US'), 'zh');
  assert.equal(chooseLanguage('invalid', 'zh-CN'), 'zh');
  assert.equal(chooseLanguage('invalid', 'en-US'), 'en');
});

test('字典每项有完整中英文，英文不包含中文，中文静态措辞不变', () => {
  for (const [key, row] of Object.entries(messages)) {
    assert.equal(row.length, 2, key);
    assert.equal(typeof row[0], 'string', key); assert.ok(row[0].trim(), key);
    assert.equal(typeof row[1], 'string', key); assert.ok(row[1].trim(), key);
    assert.doesNotMatch(row[1], /\p{Script=Han}/u, key);
    if (/\p{Script=Han}/u.test(key)) assert.equal(row[0], key, key);
    const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(row[0]), placeholders(row[1]), `${key}: placeholders`);
  }
});

test('关键动态中文措辞保持，英文参数插入完整且不改用户原文', () => {
  const cases = [
    ['minutes', [5], '5 分钟'], ['days', [2], '2 天'], ['minutesAgo', [5], '5 分钟前'],
    ['today', ['09:05'], '今天 09:05'], ['yesterday', ['09:05'], '昨天 09:05'], ['date', [10, 17, '09:05'], '10月17日 09:05'],
    ['waitMinutes', [5], '等了 5 分钟'], ['waitHours', [2], '等了 2 小时'], ['waitDays', [3], '等了 3 天'],
    ['unreadDetail', ['20 分钟'], '编排 20 分钟还没读，可能在忙或卡住了。'],
    ['submittedFailed', [2], '已提交 2 项，通知没送到，可重发'], ['submittedQuiet', [2], '已提交 2 项，没配通知，等编排巡检'],
    ['submitted', [2], '已提交 2 项，已通知编排'], ['pending', [2], '2 待答'],
    ['selected', ['A、B'], '已选 A、B，再点一次取消'], ['older', [3], '更早完成 3 张'], ['blockingCount', [2], '2 题挡住票了'],
  ];
  for (const [key, values, expected] of cases) assert.equal(translate('zh', key, ...values), expected, key);
  assert.equal(translate('zh', 'hoursMinutes', 2, 0), '2 小时');
  assert.equal(translate('zh', 'hoursMinutes', 2, 5), '2 小时 5 分');
  assert.equal(translate('en', 'hoursMinutes', 2, 5), '2h 5m');
  assert.equal(translate('en', 'selected', '用户选项原文'), 'Selected 用户选项原文; tap again to deselect');
  assert.equal(translate('en', '用户题稿保持原文'), '用户题稿保持原文');
  for (const [key, row] of Object.entries(messages)) {
    const result = translate('en', key, '1', '2', '3');
    assert.doesNotMatch(result, /\p{Script=Han}|\{\d+\}/u, key);
    assert.ok(result.length > 0, key);
  }
});
