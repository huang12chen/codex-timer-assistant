import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings } from '../src/core/validation.mjs';
import { resolveLanguage, setLanguage, systemMessage, tr } from '../ui/i18n.mjs';
import { quotaWindowLabel } from '../ui/time.mjs';

test('language follows the system unless the user chooses explicitly', () => {
  assert.equal(resolveLanguage('system', 'zh-CN'), 'zh-CN');
  assert.equal(resolveLanguage('system', 'en-US'), 'en');
  assert.equal(resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(validateSettings({}).language, 'system');
  assert.equal(validateSettings({}).timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(validateSettings({timeZone:'Asia/Shanghai'}).timeZone, 'Asia/Shanghai');
  assert.equal(validateSettings({ language: 'en' }).language, 'en');
  assert.throws(() => validateSettings({ language: 'invalid' }));
});

test('static UI translations change with the language and do not rewrite unknown user text', () => {
  setLanguage('en');
  assert.equal(tr('任务计划'), 'Tasks');
  assert.equal(tr('新建任务'), 'New task');
  assert.equal(tr('任务已删除'), 'Task deleted');
  assert.equal(tr('目标聊天出现新的运行状态，定时消息已确认送达'), 'The scheduled message was confirmed delivered to the target chat.');
  assert.equal(systemMessage('任务已删除'), 'Task deleted');
  assert.equal(systemMessage('目标聊天出现新的运行状态，定时消息已确认送达'), 'The scheduled message was confirmed delivered to the target chat.');
  assert.equal(tr('这是用户自己的聊天标题'), '这是用户自己的聊天标题');
  setLanguage('zh-CN');
  assert.equal(tr('任务计划'), '任务计划');
});

test('quota labels use the reported window instead of assuming five hours or a week', () => {
  setLanguage('zh-CN');
  assert.equal(quotaWindowLabel({windowDurationMins:300}), '5 小时剩余');
  assert.equal(quotaWindowLabel({windowDurationMins:10080}), '本周剩余');
  assert.equal(quotaWindowLabel({windowDurationMins:43200}), '30 天剩余');
  assert.equal(quotaWindowLabel(null), '额度剩余');
  setLanguage('en');
  assert.equal(quotaWindowLabel({windowDurationMins:300}), '5-hour limit');
  assert.equal(quotaWindowLabel({windowDurationMins:10080}), 'Weekly limit');
  assert.equal(quotaWindowLabel({windowDurationMins:43200}), '30-day limit');
  assert.equal(quotaWindowLabel({windowDurationMins:null}), 'Usage limit');
  setLanguage('zh-CN');
});
