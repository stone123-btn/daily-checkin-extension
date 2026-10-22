import '../shared/core.js';
import { createController } from './tasks.js';
import { createScheduler } from './scheduler.js';

const C = globalThis.CheckinCore;
const controller = createController({ chrome });
const scheduler = createScheduler({ chrome, controller });
let ready;
const safely = promise => promise.catch(() => { /* Task deadlines and the UI retain recovery controls. */ });

function isUI(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('ui/'));
}

async function handle(message, sender) {
  await ready;
  if (!message || typeof message.type !== 'string') return { ok: false };
  if (message.type === 'CHECKIN_HELLO') return controller.attach(sender);
  if (message.type === 'CHECKIN_GRANT') return controller.grant(message, sender);
  if (message.type === 'CHECKIN_VERIFY_GRANT') return controller.grantVerification(message, sender);
  if (message.type === 'CHECKIN_REPORT') return controller.report(message, sender);
  if (message.type === 'CHECKIN_PROGRESS') return controller.progress(message, sender);
  if (!isUI(sender)) return { ok: false };
  if (message.type === 'UI_SNAPSHOT') return { ok: true, ...await controller.snapshot() };
  if (message.type === 'UI_RECHECK_STALE') return controller.recheckStale();
  if (message.type === 'UI_RECOVERY_CHECK') return controller.checkRecovery(message.siteId);
  if (message.type === 'UI_RECOVERY_RETRY') return controller.retryRecovery(message.siteId, { taskId: message.taskId, confirmed: message.confirmed === true });
  if (message.type === 'UI_START') {
    const sites = message.siteId ? [message.siteId] : Object.keys(C.SITES);
    if (sites.some(id => !C.SITES[id])) return { ok: false };
    const results = [];
    for (const id of sites) results.push(await controller.start(id, { mode: message.mode === 'inspect' ? 'inspect' : 'execute' }));
    return { ok: true, results };
  }
  if (message.type === 'UI_CANCEL') { await controller.cancel(message.siteId); return { ok: true }; }
  if (message.type === 'UI_OPEN') return controller.open(message.siteId);
  if (message.type === 'UI_OPTIONS') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
  if (message.type === 'UI_SAVE_SETTINGS') {
    const error = (Object.hasOwn(message.settings || {}, 'message') ? C.messageError(message.settings.message) : '') ||
      (Object.hasOwn(message.settings || {}, 'time') ? C.timeError(message.settings.time) : '');
    if (error) return { ok: false, error };
    const settings = await controller.saveSettings(message.settings || {});
    await scheduler.refresh();
    return { ok: true, settings };
  }
  return { ok: false };
}

// Register listeners synchronously, before any storage reads or restore work.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, () => respond({ ok: false, error: '操作未能完成，请重试或重新打开插件。' }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => safely(ready.then(() => scheduler.refresh())));
chrome.runtime.onStartup.addListener(() => safely(ready.then(() => scheduler.refresh({ catchUp: true }))));
chrome.alarms.onAlarm.addListener(alarm => safely(ready.then(async () => {
  if (alarm.name === 'daily-checkin' || alarm.name === 'checkin-watchdog') {
    await scheduler.refresh({ catchUp: true });
    return;
  }
  const match = /^(deadline|retry):(sb|nodeseek):(.+)$/.exec(alarm.name);
  if (match) await controller[match[1] === 'deadline' ? 'expire' : 'retry'](match[2], match[3]);
})));
chrome.tabs.onRemoved.addListener(tabId => safely(ready.then(() => controller.tabClosed(tabId))));
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url) safely(ready.then(() => controller.tabUpdated(tabId, change.url))); });
let notificationsRegistered = false;
function registerNotificationClicks() {
  if (notificationsRegistered || !chrome.notifications) return;
  notificationsRegistered = true;
  chrome.notifications.onClicked.addListener(id => {
    const siteId = id.startsWith('checkin:') ? id.slice(8) : null;
    if (C.SITES[siteId]) safely(ready.then(() => controller.open(siteId)));
  });
}
registerNotificationClicks();
chrome.permissions.onAdded.addListener(registerNotificationClicks);

ready = (async () => {
  await controller.restore();
  await scheduler.refresh();
})();
safely(ready);
