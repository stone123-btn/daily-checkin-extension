import { createSettingsEditor, scheduleSummary } from './settings-editor.js';

const $ = selector => document.querySelector(selector);
const saveButton = $('#settings-form button[type="submit"]');
const inputs = { enabled: $('#enabled'), time: $('#time'), message: $('#message'), 'sites.sb': $('#site-sb'), 'sites.nodeseek': $('#site-nodeseek'), notifications: $('#notifications') };
let saving = false, requestingPermission = false, loadId = 0;
function feedback(text, error = false) { $('#feedback').textContent = text; $('#feedback').classList.toggle('error', error); }
function validateMessage() {
  const error = CheckinCore.messageError($('#message').value);
  $('#message-error').textContent = error;
  $('#message').setAttribute('aria-invalid', String(!!error));
  return error;
}
const editor = createSettingsEditor(inputs, (key, field) => {
  const error = key === 'message' ? validateMessage() : key === 'time' ? CheckinCore.timeError($('#time').value) : '';
  feedback(error || (field.dirty ? field.external ? '其他页面已更新；你的草稿未保存，保存后将覆盖该项。' : '有未保存的设置，请点击“保存设置”。' : editor.isDirty() ? '其他设置已同步；你的草稿尚未保存。' : '已同步其他页面保存的设置。'), !!error);
});
async function send(message) {
  const value = await chrome.runtime.sendMessage(message);
  if (!value?.ok) throw new Error(value?.error || '设置未能保存，请重试。');
  return value;
}
async function load() {
  const requestId = ++loadId;
  const { settings, records } = await send({ type: 'UI_SNAPSHOT' });
  const permitted = await chrome.permissions.contains({ permissions: ['notifications'] });
  if (requestId !== loadId) return;
  editor.sync({ ...settings, notifications: settings.notifications && permitted });
  $('#time-plan').textContent = scheduleSummary(settings, records);
  saveButton.disabled = saving || requestingPermission;
}
$('#notifications').addEventListener('change', async event => {
  if (!event.target.checked) return;
  requestingPermission = true; saveButton.disabled = true;
  try {
    const granted = await chrome.permissions.request({ permissions: ['notifications'] });
    event.target.checked = granted;
    event.target.dispatchEvent(new Event('input', { bubbles: true }));
    feedback(granted ? '通知权限已开启，保存设置后生效。' : '未授予通知权限，仍可查看图标提醒。');
  } catch {
    event.target.checked = false;
    event.target.dispatchEvent(new Event('input', { bubbles: true }));
    feedback('通知权限未开启，仍可查看图标提醒。', true);
  } finally { requestingPermission = false; saveButton.disabled = saving; }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (saveButton.disabled) return;
  const error = validateMessage() || CheckinCore.timeError($('#time').value);
  if (error) { feedback(error, true); (CheckinCore.messageError($('#message').value) ? $('#message') : $('#time')).focus(); return; }
  saving = true; saveButton.disabled = true; editor.busy(Object.keys(inputs), true);
  const patch = editor.patch();
  try {
    await send({ type: 'UI_SAVE_SETTINGS', settings: patch });
    editor.accept(patch);
    await load();
    feedback('已保存。下次新签到任务起使用保存的留言；时间按上方计划执行。');
  } catch (error) { feedback(error.message, true); }
  finally { saving = false; saveButton.disabled = requestingPermission; editor.busy(Object.keys(inputs), false); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.records)) load().catch(error => feedback(error.message, true));
});
load().catch(error => feedback(error.message, true));
