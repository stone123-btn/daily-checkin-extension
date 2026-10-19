import { createSettingsEditor, scheduleSummary } from './settings-editor.js';

const C = globalThis.CheckinCore;
const $ = selector => document.querySelector(selector);
const attention = new Set(['waiting_verification', 'needs_login', 'unknown', 'failed']);
const active = new Set([...C.ACTIVE, 'retry_pending']);
const completed = new Set(['success', 'already_done']);
let signature = '';
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '操作未完成，请重试。');
  return response;
}
function feedback(text, error = false) { $('#feedback').textContent = text; $('#feedback').classList.toggle('error', error); }
function button(text, action, siteId, className = '') {
  const element = document.createElement('button'); element.textContent = text; element.dataset.action = action; element.dataset.site = siteId; element.className = className; return element;
}
function element(tag, className, value) { const el = document.createElement(tag); el.className = className; if (value) el.textContent = value; return el; }
function checkedAt(task) {
  const value = task?.checkedAt || task?.updatedAt;
  if (!value) return '尚未检查';
  return (task?.checkedAt ? '网站核对于 ' : '尝试于 ') + new Intl.DateTimeFormat('zh-CN', { timeZone: C.TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
}
const cards = new Map();
for (const [index, site] of Object.values(C.SITES).entries()) {
  const card = element('article', 'site'); card.dataset.site = site.id;
  const heading = element('div', 'site-heading');
  const title = element('div', 'site-title'); title.append(element('h2', '', site.name), element('p', 'site-domain', site.host));
  const status = element('span', 'pill');
  status.setAttribute('role', 'status');
  heading.append(element('span', 'site-number', `0${index + 1}`), title, status);
  const description = element('p', 'site-message');
  const bottom = element('div', 'site-bottom');
  const checked = element('span', 'checked-at');
  const actions = element('div', 'site-actions');
  bottom.append(checked, actions); card.append(heading);
  if (site.id === 'sb') card.append($('#message-editor-template').content.cloneNode(true));
  card.append(description, bottom); $('#sites').append(card);
  cards.set(site.id, { card, status, description, checked, actions });
}
function fieldFeedback(key, text, error = false) {
  const output = $(`#${key}-feedback`);
  output.textContent = text; output.classList.toggle('error', error);
  $(`#${key}`).setAttribute('aria-invalid', String(error));
}
const editor = createSettingsEditor({ message: $('#message'), time: $('#time') }, (key, field) => {
  const error = key === 'message' ? C.messageError(field.input.value) : C.timeError(field.input.value);
  fieldFeedback(key, error || (field.dirty ? field.external ? '其他页面已更新；你的草稿未保存，保存后将覆盖该项。' : '未保存，请点击保存。' : '已同步保存的设置。'), !!error);
});
let refreshId = 0;
async function refresh() {
  const requestId = ++refreshId;
  const value = await send({ type: 'UI_SNAPSHOT' });
  const notificationPermission = await chrome.permissions.contains({ permissions: ['notifications'] });
  if (requestId !== refreshId) return;
  editor.sync(value.settings);
  $('#notification-hint').hidden = value.settings.notifications && notificationPermission;
  $('#schedule-zone').textContent = scheduleSummary(value.settings, value.records);
  if (!saving) { $('#save-message').disabled = false; $('#save-time').disabled = false; }
  const next = JSON.stringify([value.settings, value.tasks]);
  if (next === signature) return;
  signature = next;
  $('#today').textContent = `${C.dayKey()} / TODAY`;
  $('#schedule-time').textContent = `每日 ${value.settings.time}`;
  $('#schedule-label').textContent = value.settings.enabled ? '自动签到 · UTC+8' : '自动签到已关闭';
  $('#schedule-dot').classList.toggle('off', !value.settings.enabled);
  for (const site of Object.values(C.SITES)) {
    const task = value.tasks[site.id];
    const enabled = value.settings.sites[site.id];
    const { card, status, description, checked, actions } = cards.get(site.id);
    const verificationExpired = task?.attentionReason === 'verification_timeout';
    const verificationRunning = task?.status === 'waiting_verification' && ['verification_clicked', 'verification_running'].includes(task.lastObservation?.code);
    const state = !enabled ? 'muted' : completed.has(task?.status) ? 'complete' : task?.status === 'idle' ? 'todo' :
      attention.has(task?.status) && !verificationRunning ? 'attention' : active.has(task?.status) ? 'pending' : 'muted';
    const statusLabel = verificationExpired ? '验证已超时' : verificationRunning ? '验证中' :
      state === 'complete' ? '今日已签到' : state === 'todo' ? '今日未签到' : C.LABELS[task?.status] || '待检查';
    const icon = element('span', 'status-icon', { complete: '✓', todo: '○', attention: '!', pending: '…', muted: '—' }[state]);
    icon.setAttribute('aria-hidden', 'true');
    status.replaceChildren(icon, document.createTextNode(enabled ? statusLabel : '已停用'));
    status.className = `pill ${state}`;
    card.dataset.state = state;
    description.textContent = !enabled ? '在设置中启用此网站后即可运行。' : task?.message || (site.id === 'sb' ? '使用已保存的固定留言签到。' : '默认固定领取 5 鸡腿，需要验证时提醒你。');
    checked.textContent = checkedAt(task);
    const buttons = [];
    if (enabled && active.has(task?.status)) buttons.push(button('停止', 'cancel', site.id, 'stop'));
    if (enabled && !active.has(task?.status)) buttons.push(button(task?.status === 'unknown' ? '查询结果' : '签到', task?.status === 'unknown' ? 'inspect' : 'start', site.id));
    buttons.push(button(verificationExpired ? '继续验证 ↗' : attention.has(task?.status) ? '打开处理 ↗' : '打开网站 ↗', 'open', site.id));
    actions.replaceChildren(...buttons);
  }
  const none = !Object.values(value.settings.sites).some(Boolean);
  $('#run-all').disabled = none; $('#inspect-all').disabled = none;
}
let saving = false;
for (const key of ['message', 'time']) {
  $(`#${key}-form`).addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || $(`#save-${key}`).disabled) return;
    const error = key === 'message' ? C.messageError($('#message').value) : C.timeError($('#time').value);
    if (error) { fieldFeedback(key, error, true); $(`#${key}`).focus(); return; }
    saving = true; editor.busy([key], true);
    $('#save-message').disabled = true; $('#save-time').disabled = true;
    fieldFeedback(key, '正在保存…');
    const patch = editor.patch([key]);
    try {
      await send({ type: 'UI_SAVE_SETTINGS', settings: patch });
      editor.accept(patch);
      await refresh();
      fieldFeedback(key, key === 'message' ? '已保存，下次新任务起持续使用。' : '已保存，按上方计划执行。');
    } catch (error) { fieldFeedback(key, error.message, true); }
    finally { saving = false; editor.busy([key], false); $('#save-message').disabled = false; $('#save-time').disabled = false; }
  });
}
async function action(message, text) {
  try {
    const unsaved = message.type === 'UI_START' && message.mode !== 'inspect' && editor.isDirty();
    await send(message); feedback(unsaved ? '有未保存的设置，本次签到使用已保存配置。' : text); await refresh();
  }
  catch (error) { feedback(error.message, true); }
}
$('#run-all').addEventListener('click', () => action({ type: 'UI_START' }, '已开始；需要处理时会保留网站页面。'));
$('#inspect-all').addEventListener('click', () => action({ type: 'UI_START', mode: 'inspect' }, '正在读取网站状态。'));
$('#settings').addEventListener('click', () => action({ type: 'UI_OPTIONS' }, ''));
$('#enable-notifications').addEventListener('click', async event => {
  const control = event.currentTarget; control.disabled = true;
  try {
    const granted = await chrome.permissions.request({ permissions: ['notifications'] });
    if (!granted) { feedback('未开启桌面提醒；需要验证时请查看插件图标并打开处理。'); return; }
    await action({ type: 'UI_SAVE_SETTINGS', settings: { notifications: true } }, '桌面提醒已开启。');
  } catch { feedback('通知权限未开启，仍可查看插件图标提醒。', true); }
  finally { control.disabled = false; }
});
$('#export-diagnostics').addEventListener('click', async () => {
  try {
    const value = await send({ type: 'UI_SNAPSHOT' });
    const report = C.diagnosticReport(value, chrome.runtime.getManifest().version);
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `checkin-diagnostics-${C.dayKey()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback('已导出诊断，不包含留言、账号凭据或验证码内容。');
  } catch (error) { feedback(error.message, true); }
});
$('#sites').addEventListener('click', event => {
  const control = event.target.closest('button[data-action]'); if (!control) return;
  const type = { start: 'UI_START', inspect: 'UI_START', open: 'UI_OPEN', cancel: 'UI_CANCEL' }[control.dataset.action];
  action({ type, siteId: control.dataset.site, mode: control.dataset.action === 'inspect' ? 'inspect' : 'execute' }, control.dataset.action === 'cancel' ? '已停止自动操作。已发出的提交仍需查看结果。' : '');
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') refresh().catch(() => {}); });
$('#version').textContent = `V ${chrome.runtime.getManifest().version}`;
refresh().then(() => send({ type: 'UI_RECHECK_STALE' })).then(refresh).catch(error => feedback(error.message, true));
