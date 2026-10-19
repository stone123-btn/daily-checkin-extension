import '../shared/core.js';

const C = globalThis.CheckinCore;
const LOAD_MS = 45000;
const VERIFY_MS = 10 * 60000;
const RESULT_MS = 30000;
const VERIFICATION_TIMEOUT_MESSAGE = '机器人验证等待已超时。请打开原页面完成验证，网站会继续提交；插件只核对结果，不重复点击。';
const ATTENTION = new Set(['waiting_verification', 'needs_login', 'unknown', 'failed']);
const FINAL = new Set(['success', 'already_done', 'unknown', 'failed', 'idle', 'cancelled']);
const MESSAGES = {
  checking: '正在检查网站的签到状态。',
  waiting_verification: '请打开处理页面完成验证，通过后自动继续。',
  needs_login: '请在网站登录，再返回签到页继续。',
  already_done: '网站确认今日已签到。', success: '网站已显示签到成功。',
  idle: '今日尚未签到，可点击签到按钮执行。',
  unknown: '已尝试提交，结果尚未确认；只查询状态，不重复提交。',
  failed: '页面结构或控件未能确认，请打开网站检查。',
  retry_pending: '页面加载失败，将在稍后重试。',
  cancelled: '已停止本次自动操作，页面保留。'
};
const marker = id => `#daily-checkin=${encodeURIComponent(id)}`;
const deadlineName = task => `deadline:${task.siteId}:${task.id}`;
const retryName = task => `retry:${task.siteId}:${task.id}`;

export function createController({ chrome: api, now = Date.now, uuid = () => crypto.randomUUID() }) {
  let queue = Promise.resolve();
  function locked(fn) {
    const result = queue.then(async () => {
      const value = await api.storage.local.get(['settings', 'tasks', 'records', 'history']);
      const state = { settings: C.normalizeSettings(value.settings), tasks: value.tasks || {}, records: value.records || {}, history: value.history || [] };
      // Freeze legacy tasks before a settings update can replace their message.
      for (const task of Object.values(state.tasks)) {
        if (task.siteId === 'sb' && typeof task.checkinMessage !== 'string') task.checkinMessage = state.settings.message;
      }
      return fn(state);
    });
    queue = result.catch(() => {});
    return result;
  }
  async function save(state) {
    await api.storage.local.set(state);
    const tasks = Object.values(state.tasks);
    const attention = tasks.filter(t => ATTENTION.has(t.status)).length;
    const active = tasks.some(t => C.ACTIVE.has(t.status));
    await api.action.setBadgeText({ text: attention ? String(attention) : active ? '…' : '' });
    await api.action.setBadgeBackgroundColor({ color: attention ? '#a4482c' : '#255c49' });
  }
  function valid(task, message, sender) {
    return !!task && task.id === message.taskId && sender.frameId === 0 &&
      sender.tab?.id === task.tabId && C.siteForUrl(sender.tab.url) === task.siteId && message.siteId === task.siteId;
  }
  async function notify(state, task) {
    if (!ATTENTION.has(task.status) || !state.settings.notifications) return;
    try {
      if (!await api.permissions.contains({ permissions: ['notifications'] })) return;
      await api.notifications.create(`checkin:${task.siteId}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: `${C.SITES[task.siteId].name} · ${C.LABELS[task.status]}`, message: task.message });
    } catch { /* The badge remains available when OS notifications are unavailable. */ }
  }
  async function closeOwned(task) {
    if (!task.owned || !['success', 'already_done'].includes(task.status)) return;
    try {
      const tab = await api.tabs.get(task.tabId);
      if (C.siteForUrl(tab.url) === task.siteId && new URL(tab.url).hash === marker(task.id)) await api.tabs.remove(task.tabId);
    } catch { /* A user may have already closed or navigated this tab. */ }
  }
  function history(state, task) {
    state.history.unshift(C.publicTask(task));
    state.history = state.history.slice(0, 40);
  }
  function trace(task, phase, code) {
    const entry = { at: now(), phase };
    if (Object.hasOwn(C.DETAILS, code)) entry.code = code;
    task.diagnostics = [...(task.diagnostics || []), entry].slice(-20);
  }
  function observe(task, message) {
    const observation = { status: message.status, at: now() };
    if (Object.hasOwn(C.DETAILS, message.detail)) observation.code = message.detail;
    else if (message.reason === 'network') observation.code = 'network';
    if (['loading', 'interactive', 'complete'].includes(message.readyState)) observation.readyState = message.readyState;
    const previous = task.lastObservation;
    if (previous?.status === observation.status && previous?.code === observation.code && previous?.readyState === observation.readyState) return;
    task.lastObservation = observation;
    trace(task, message.status, observation.code);
  }
  async function finish(state, task, status, message) {
    const changed = task.status !== status;
    if (status === 'unknown' && changed) task.uncertainAt = now();
    task.status = status;
    task.message = message || MESSAGES[status];
    task.updatedAt = now();
    if (changed) trace(task, status, task.attentionReason || task.lastObservation?.code);
    if (['success', 'already_done'].includes(status)) {
      task.confirmedAt = now(); task.checkedAt = now(); delete task.attentionReason;
      state.records[task.siteId] = { ...state.records[task.siteId], lastSuccessDay: C.dayKey(now()), lastConfirmedAt: now() };
    }
    if (changed && FINAL.has(status)) history(state, task);
    await save(state);
    if (FINAL.has(status)) await api.alarms.clear(deadlineName(task));
    if (changed) await notify(state, task);
    await closeOwned(task);
  }
  async function deadline(task) { await api.alarms.create(deadlineName(task), { when: task.expiresAt }); }
  async function fail(state, task, retryable) {
    if (task.submittedAt != null || task.uncertain) return finish(state, task, 'unknown');
    task.retryable = retryable && task.mode === 'execute';
    const when = C.retryAt(task, now());
    const detail = C.DETAILS[task.lastObservation?.code] || C.DETAILS[retryable ? 'page_timeout' : 'unknown_controls'];
    if (when) {
      task.status = 'retry_pending'; task.message = `${detail}，将在${task.retryCount === 0 ? 5 : 15}分钟后重试。`; task.updatedAt = now(); task.nextRetryAt = when;
      trace(task, 'retry_pending', task.lastObservation?.code || 'page_timeout');
      history(state, task);
      await save(state);
      await api.alarms.clear(deadlineName(task));
      await api.alarms.create(retryName(task), { when });
    } else await finish(state, task, 'failed', retryable && task.retryCount >= 2 ? `${detail}，已达到重试次数上限，请打开网站检查。` : `${detail}，请打开网站检查。`);
  }
  async function startWithin(state, siteId, options = {}) {
    if (!C.SITES[siteId]) throw new Error('不支持的网站');
    if (!state.settings.sites[siteId]) return { ok: false, disabled: true };
    const previous = state.tasks[siteId];
    if (previous?.status === 'retry_pending' && options.mode === 'inspect') return { ok: true, busy: true, task: { ...previous } };
    if (previous && C.ACTIVE.has(previous.status) && previous.expiresAt > now()) {
      if (options.source === 'scheduled') {
        state.records[siteId] = { ...state.records[siteId], lastScheduledDay: C.dayKey(now()) };
        await save(state);
      }
      return { ok: true, busy: true, task: { ...previous } };
    }
    const unresolved = previous && (previous.submittedAt != null || previous.uncertain) && !['success', 'already_done'].includes(previous.status) && C.dayKey(previous.uncertainAt ?? previous.submittedAt ?? previous.startedAt) === C.dayKey(now());
    // The native CAP callback belongs to this document. Keep it alive when a
    // user rechecks an expired verification; replacing the task loses its result.
    if (unresolved && ['unknown', 'waiting_verification', 'submitting'].includes(previous.status) && previous.nativeVerification && previous.owned) {
      try {
        const page = await api.tabs.get(previous.tabId);
        if (C.siteForUrl(page.url) === siteId && new URL(page.url).hash === marker(previous.id)) {
          if (C.ACTIVE.has(previous.status)) {
            if (previous.status === 'waiting_verification') previous.attentionReason = 'verification_timeout';
            await finish(state, previous, 'unknown', previous.attentionReason === 'verification_timeout' ? VERIFICATION_TIMEOUT_MESSAGE : undefined);
          }
          previous.mode = 'inspect'; previous.lastRecheckedAt = now();
          await save(state);
          try { await api.tabs.sendMessage(previous.tabId, { type: 'CHECKIN_POLL' }); } catch { /* A loading original document attaches later. */ }
          return { ok: true, resumed: true, task: { ...previous } };
        }
      } catch { /* A closed verification page can only be checked in a new read-only task. */ }
    }
    const task = {
      id: uuid(), siteId, status: 'checking', message: MESSAGES.checking, startedAt: now(), updatedAt: now(),
      expiresAt: now() + LOAD_MS, submittedAt: null, owned: true, tabId: null,
      source: options.source === 'scheduled' ? 'scheduled' : 'manual',
      mode: options.mode === 'inspect' || unresolved ? 'inspect' : 'execute',
      uncertain: !!unresolved, retryCount: options.retryCount || 0
    };
    if (siteId === 'sb') task.checkinMessage = options.checkinMessage ?? state.settings.message;
    state.tasks[siteId] = task;
    trace(task, 'checking');
    if (task.source === 'scheduled') task.scheduledFor = Date.parse(`${C.dayKey(now())}T${state.settings.time}:00+08:00`);
    if (task.mode === 'execute') state.records[siteId] = { ...state.records[siteId], lastAttemptDay: C.dayKey(now()), lastAttemptAt: now() };
    if (task.source === 'scheduled') state.records[siteId] = { ...state.records[siteId], lastScheduledDay: C.dayKey(now()) };
    await save(state);
    try {
      const url = C.SITES[siteId].url + marker(task.id);
      let tab;
      if (previous?.owned && previous.submittedAt == null && ['failed', 'retry_pending', 'cancelled', 'idle'].includes(previous.status)) {
        try {
          const old = await api.tabs.get(previous.tabId);
          if (!old.active && C.siteForUrl(old.url) === siteId && new URL(old.url).hash === marker(previous.id)) tab = await api.tabs.update(old.id, { url });
        } catch { /* Recreate a closed task tab. */ }
      }
      if (!tab) tab = await api.tabs.create({ url, active: options.active === true });
      task.tabId = tab.id;
      await save(state);
      await deadline(task);
      try { await api.tabs.sendMessage(task.tabId, { type: 'CHECKIN_POLL' }); } catch { /* A newly loading page attaches at document_idle. */ }
      return { ok: true, task: { ...task } };
    } catch {
      await fail(state, task, true);
      return { ok: false, task: { ...task } };
    }
  }

  const controller = {
    start: (siteId, options) => locked(state => startWithin(state, siteId, options)),
    recheckStale: () => locked(async state => {
      const results = [];
      for (const siteId of Object.keys(C.SITES)) {
        const task = state.tasks[siteId];
        if (!state.settings.sites[siteId] || !task || !['success', 'already_done', 'failed', 'unknown', 'idle'].includes(task.status)) continue;
        if (now() - (task.lastRecheckedAt || task.updatedAt || task.startedAt) < 5 * 60000) continue;
        results.push(await startWithin(state, siteId, { mode: 'inspect' }));
      }
      return { ok: true, results };
    }),
    snapshot: () => locked(async state => ({ settings: state.settings, tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, C.publicTask(task)])), records: state.records, history: state.history })),
    attach: sender => locked(async state => {
      const siteId = C.siteForUrl(sender.tab?.url);
      if (!siteId || sender.frameId !== 0) return { task: null };
      const task = state.tasks[siteId];
      if (!task) return { task: null };
      if (task.tabId !== sender.tab.id) {
        if (new URL(sender.tab.url).hash !== marker(task.id) || !task.owned) return { task: null };
        task.tabId = sender.tab.id;
        await save(state);
      }
      if (!C.ACTIVE.has(task.status) && task.status !== 'unknown') return { task: null };
      return { task: { ...C.publicTask(task), mode: task.submittedAt != null || task.status === 'unknown' ? 'inspect' : task.mode }, message: task.checkinMessage };
    }),
    grant: (message, sender) => locked(async state => {
      const task = state.tasks[message.siteId];
      if (!valid(task, message, sender) || task.mode !== 'execute' || !state.settings.sites[task.siteId] || (task.source === 'scheduled' && !state.settings.enabled) || !C.canSubmit(task, { taskId: message.taskId, tabId: sender.tab.id }, now())) return { allowed: false };
      task.nativeVerification = task.siteId === 'sb' && message.nativeVerification === true;
      task.submittedAt = now(); task.updatedAt = now(); task.status = 'submitting'; task.message = '已发放一次提交许可，正在等待网站确认。'; task.expiresAt = now() + RESULT_MS;
      trace(task, 'submitting');
      // Persist before responding: a lost response must never produce a second permit.
      await save(state);
      await deadline(task);
      return { allowed: true };
    }),
    grantVerification: (message, sender) => locked(async state => {
      const task = state.tasks[message.siteId];
      if (!valid(task, message, sender) || task.siteId !== 'sb' || !task.owned || !task.nativeVerification || task.mode !== 'execute' || task.submittedAt == null || task.verificationAttemptedAt != null || task.uncertain || task.expiresAt <= now() || !['submitting', 'waiting_verification'].includes(task.status) || !state.settings.sites.sb || (task.source === 'scheduled' && !state.settings.enabled)) return { allowed: false };
      // Like the submit permit, persist before replying so a lost response or
      // worker restart cannot cause a second verification click.
      task.verificationAttemptedAt = now(); task.updatedAt = now();
      trace(task, 'waiting_verification', 'verification_clicked');
      await save(state);
      return { allowed: true };
    }),
    report: (message, sender) => locked(async state => {
      const task = state.tasks[message.siteId];
      if (!valid(task, message, sender)) return { ok: false };
      if (['success', 'already_done', 'cancelled', 'failed', 'retry_pending', 'idle'].includes(task.status)) return { ok: true, stopped: true };
      if (!['loading', 'already_done', 'ready', 'waiting_verification', 'needs_login', 'failed', 'cancelled', 'unknown'].includes(message.status)) return { ok: false };
      observe(task, message);
      if (message.status === 'loading') {
        if (task.status === 'checking') task.message = `${C.DETAILS[task.lastObservation?.code] || '网站正在加载'}，正在等待。`;
        await save(state);
      } else if (message.status === 'already_done') {
        await finish(state, task, task.submittedAt != null ? 'success' : 'already_done');
      } else if (message.status === 'ready') {
        task.checkedAt = now();
        if (task.submittedAt != null || task.uncertain || task.status === 'unknown') await finish(state, task, 'unknown');
        else if (task.mode === 'inspect') await finish(state, task, 'idle');
        else {
          task.status = 'checking'; task.message = '页面已准备，等待提交许可。'; task.updatedAt = now(); await save(state);
        }
      } else if (['waiting_verification', 'needs_login'].includes(message.status)) {
        if (message.status === 'waiting_verification' && message.reason === 'native_verification' && task.nativeVerification && task.submittedAt != null && ['submitting', 'waiting_verification'].includes(task.status)) {
          const detail = ['verification_clicked', 'verification_running', 'verification_error', 'verification_unavailable'].includes(message.detail) ? message.detail : null;
          const verificationMessage = detail ? `${C.DETAILS[detail]}。${['verification_error', 'verification_unavailable'].includes(detail) ? '请打开原页面手动完成验证。' : '正在等待网站结果，如未继续请打开原页面处理。'}` : undefined;
          if (task.status !== 'waiting_verification') {
            task.expiresAt = now() + VERIFY_MS;
            await finish(state, task, 'waiting_verification', verificationMessage);
            await deadline(task);
          } else if (verificationMessage) { task.message = verificationMessage; task.updatedAt = now(); await save(state); }
        } else if (task.submittedAt != null || task.uncertain) await finish(state, task, 'unknown', task.attentionReason === 'verification_timeout' ? task.message : undefined);
        else if (task.status !== message.status) {
          task.expiresAt = now() + VERIFY_MS;
          await finish(state, task, message.status);
          await deadline(task);
        }
      } else if (message.status === 'failed') await fail(state, task, message.reason === 'network');
      else if (message.status === 'cancelled') await finish(state, task, task.submittedAt != null || task.uncertain ? 'unknown' : 'cancelled');
      else if (message.status === 'unknown') { task.uncertain = true; await finish(state, task, 'unknown'); }
      return { ok: true, status: task.status };
    }),
    expire: (siteId, taskId) => locked(async state => {
      const task = state.tasks[siteId];
      if (!task || task.id !== taskId || !C.ACTIVE.has(task.status) || now() < task.expiresAt) return;
      if (task.status === 'waiting_verification') {
        task.attentionReason = 'verification_timeout';
        await finish(state, task, task.submittedAt != null || task.uncertain ? 'unknown' : 'failed', task.submittedAt != null ? VERIFICATION_TIMEOUT_MESSAGE : '机器人验证等待已超时。请打开网站完成验证后，再点击签到继续。');
      } else if (task.submittedAt != null) await finish(state, task, 'unknown');
      else if (['waiting_verification', 'needs_login'].includes(task.status)) await finish(state, task, 'failed', '等待处理已超时，页面保留；处理后可重新发起签到。');
      else await fail(state, task, true);
    }),
    retry: (siteId, taskId) => locked(async state => {
      const task = state.tasks[siteId];
      if (!task || task.id !== taskId || task.status !== 'retry_pending' || task.submittedAt != null || task.nextRetryAt > now() || !state.settings.sites[siteId] || (task.source === 'scheduled' && !state.settings.enabled) || C.dayKey(task.startedAt) !== C.dayKey(now())) return;
      return startWithin(state, siteId, { source: task.source, retryCount: task.retryCount + 1, checkinMessage: task.checkinMessage });
    }),
    cancel: siteId => locked(async state => {
      const task = state.tasks[siteId];
      if (!task || !['checking', 'waiting_verification', 'needs_login', 'submitting', 'retry_pending', 'unknown'].includes(task.status)) return;
      await finish(state, task, task.submittedAt != null || task.uncertain ? 'unknown' : 'cancelled');
      await api.alarms.clear(retryName(task));
      try { await api.tabs.sendMessage(task.tabId, { type: 'CHECKIN_STOP', taskId: task.id }); } catch { /* Tab may be closed. */ }
    }),
    saveSettings: input => locked(async state => {
      const error = Object.hasOwn(input, 'message') ? C.messageError(input.message) : '';
      if (error) throw new Error(error);
      const timeError = Object.hasOwn(input, 'time') ? C.timeError(input.time) : '';
      if (timeError) throw new Error(timeError);
      // Only a real clock change establishes a new plan. Other saves preserve
      // startup recovery, and callers cannot override the internal boundary.
      const scheduleNotBefore = Object.hasOwn(input, 'time') && input.time !== state.settings.time
        ? C.nextDailyAt(now(), input.time) : state.settings.scheduleNotBefore;
      state.settings = C.normalizeSettings({ ...state.settings, ...input, scheduleNotBefore, sites: { ...state.settings.sites, ...input.sites } });
      for (const task of Object.values(state.tasks)) {
        if ((!state.settings.sites[task.siteId] || (!state.settings.enabled && task.source === 'scheduled')) && ['checking', 'waiting_verification', 'needs_login', 'submitting', 'retry_pending'].includes(task.status)) {
          await finish(state, task, task.submittedAt != null ? 'unknown' : 'cancelled');
          await api.alarms.clear(retryName(task));
          try { await api.tabs.sendMessage(task.tabId, { type: 'CHECKIN_STOP', taskId: task.id }); } catch { /* Tab may be closed. */ }
        }
      }
      await save(state);
      return state.settings;
    }),
    tabClosed: tabId => locked(async state => {
      for (const task of Object.values(state.tasks)) if (task.tabId === tabId && C.ACTIVE.has(task.status)) await finish(state, task, task.submittedAt != null ? 'unknown' : 'failed', task.submittedAt != null ? MESSAGES.unknown : '任务页面已关闭，可重新发起签到。');
    }),
    tabUpdated: (tabId, url) => locked(async state => {
      for (const task of Object.values(state.tasks)) {
        if (task.tabId !== tabId || !C.ACTIVE.has(task.status)) continue;
        try {
          const parsed = new URL(url);
          if (parsed.protocol === 'https:' && parsed.hostname === C.SITES[task.siteId].host && /^\/(?:login|signin)(?:\.html)?(?:\/|$)/i.test(parsed.pathname) && task.status !== 'needs_login') {
            task.expiresAt = now() + VERIFY_MS;
            await finish(state, task, task.submittedAt != null ? 'unknown' : 'needs_login');
            await deadline(task);
          }
        } catch { /* No stable URL yet. */ }
      }
    }),
    open: siteId => locked(async state => {
      if (!C.SITES[siteId]) throw new Error('不支持的网站');
      const task = state.tasks[siteId];
      if (task?.tabId) {
        try {
          const tab = await api.tabs.get(task.tabId);
          const u = new URL(tab.url);
          if (u.protocol === 'https:' && u.hostname === C.SITES[siteId].host && (C.siteForUrl(u.href) === siteId || /^\/(login|signin)(?:\.html)?(\/|$)/i.test(u.pathname))) {
            await api.tabs.update(tab.id, { active: true });
            if (tab.windowId != null) await api.windows.update(tab.windowId, { focused: true });
            if (task.owned && u.hash === marker(task.id)) {
              try { await api.tabs.sendMessage(tab.id, { type: 'CHECKIN_POLL' }); } catch { /* Login pages may not contain a content script. */ }
            }
            return { ok: true };
          }
        } catch { /* Open a normal website tab if the task tab no longer exists. */ }
      }
      await api.tabs.create({ url: C.SITES[siteId].url, active: true });
      return { ok: true };
    }),
    restore: () => locked(async state => {
      const pages = await api.tabs.query({ url: Object.values(C.SITES).map(site => `https://${site.host}/*`) });
      for (const task of Object.values(state.tasks)) {
        if (task.status === 'retry_pending') { if (task.nextRetryAt) await api.alarms.create(retryName(task), { when: Math.max(now() + 1000, task.nextRetryAt) }); continue; }
        if (!C.ACTIVE.has(task.status) && task.status !== 'unknown') continue;
        const page = pages.find(p => C.siteForUrl(p.url) === task.siteId && new URL(p.url).hash === marker(task.id)) || pages.find(p => p.id === task.tabId);
        if (!page) { await finish(state, task, task.submittedAt != null || task.uncertain ? 'unknown' : 'failed', task.submittedAt != null ? MESSAGES.unknown : '任务页面已关闭，可重新发起签到。'); continue; }
        task.tabId = page.id;
        await save(state);
        if (C.ACTIVE.has(task.status)) await api.alarms.create(deadlineName(task), { when: Math.max(now() + 1000, task.expiresAt) });
        try { await api.tabs.sendMessage(task.tabId, { type: 'CHECKIN_POLL' }); } catch { /* Content script will attach on page load. */ }
      }
      await save(state);
    })
  };
  return controller;
}
