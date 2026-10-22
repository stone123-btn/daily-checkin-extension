(() => {
  'use strict';

  const TIME_ZONE = 'Asia/Singapore';
  const SITES = Object.freeze({
    sb: Object.freeze({ id: 'sb', name: '烧饼论坛', short: 'SB', url: 'https://sb.sb/checkin/', host: 'sb.sb' }),
    nodeseek: Object.freeze({ id: 'nodeseek', name: 'NodeSeek', short: 'NS', url: 'https://www.nodeseek.com/board', host: 'www.nodeseek.com' })
  });
  const LABELS = Object.freeze({
    idle: '尚未签到', checking: '检查中', waiting_verification: '需要验证', needs_login: '需要登录',
    submitting: '提交中', success: '签到成功', already_done: '今日已签到', unknown: '结果待确认',
    failed: '检查失败', retry_pending: '等待重试', cancelled: '已停止'
  });
  const ACTIVE = new Set(['checking', 'waiting_verification', 'needs_login', 'submitting']);
  const RECOVERY_CHECK_MS = 30000;
  const DETAILS = Object.freeze({
    region_missing: '尚未找到签到区域', form_missing: '尚未找到签到表单',
    controls_pending: '签到控件尚未加载完成', button_disabled: '签到按钮暂不可用',
    loading_data: '网站正在读取签到数据', ambiguous_form: '签到表单不唯一',
    ambiguous_controls: '留言框或签到按钮不唯一', unknown_controls: '未找到唯一、明确的签到按钮',
    network: '页面加载失败', page_timeout: '等待网站签到区域超时',
    verification_timeout: '机器人验证等待已超时', login_timeout: '登录等待已超时',
    verification_clicked: '已尝试点击网站原生验证', verification_running: '网站正在执行机器人验证',
    verification_error: '网站验证未通过，需要手动处理', verification_unavailable: '验证按钮发生变化，需要手动处理',
    message_prepared: '签到留言已准备', submit_permitted: '已发放一次签到点击许可', submit_clicked: '页面已点击签到按钮',
    verification_permitted: '已发放一次原生验证点击许可',
    page_changed: '取得提交许可后页面发生变化', unknown_result: '提交后尚未获得网站确认'
  });

  function messageError(value) {
    if (typeof value !== 'string' || !value.trim()) return '签到留言不能为空或只有空格。';
    if (value.length > 120) return '签到留言最多 120 个字符，请缩短后再保存。';
    if (/[\u0000-\u001f\u007f]/.test(value)) return '签到留言不能包含换行或控制字符。';
    return '';
  }

  function timeError(value) {
    return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? '' : '请选择有效的每日时间（00:00–23:59）。';
  }

  function normalizeSettings(input = {}) {
    return {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
      time: timeError(input.time) ? '09:00' : input.time,
      scheduleNotBefore: Number.isSafeInteger(input.scheduleNotBefore) && input.scheduleNotBefore > 0 ? input.scheduleNotBefore : 0,
      timeZone: TIME_ZONE,
      message: messageError(input.message) ? '666' : input.message,
      notifications: input.notifications === true,
      sites: { sb: input.sites?.sb !== false, nodeseek: input.sites?.nodeseek !== false }
    };
  }

  function dayKey(time = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time));
    const get = type => parts.find(p => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function dailyAt(time, clock) {
    return Date.parse(`${dayKey(time)}T${clock}:00+08:00`);
  }

  function nextDailyAt(time, clock) {
    const at = dailyAt(time, clock);
    return at > time ? at : at + 24 * 60 * 60 * 1000;
  }

  function dueSites(settings, records, time = Date.now()) {
    if (!settings.enabled || time < (settings.scheduleNotBefore || 0) || time < dailyAt(time, settings.time)) return [];
    return Object.keys(SITES).filter(id => settings.sites[id] && records[id]?.lastScheduledDay !== dayKey(time));
  }

  function siteForUrl(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.port) return null;
      if (u.hostname === SITES.sb.host && /^\/checkin\/?$/.test(u.pathname)) return 'sb';
      if (u.hostname === SITES.nodeseek.host && /^\/board\/?$/.test(u.pathname)) return 'nodeseek';
    } catch { /* An invalid or transient tab URL is not a supported page. */ }
    return null;
  }

  function canSubmit(task, request, now = Date.now()) {
    return !!task && task.id === request.taskId && task.tabId === request.tabId &&
      task.submittedAt == null && task.expiresAt > now && ['checking', 'waiting_verification'].includes(task.status);
  }

  function retryAt(task, now = Date.now()) {
    if (task.submittedAt != null || !task.retryable || task.retryCount >= 2) return null;
    return now + (task.retryCount === 0 ? 5 : 15) * 60 * 1000;
  }

  function publicTask(task) {
    if (!task) return null;
    const keys = ['id', 'siteId', 'status', 'message', 'startedAt', 'updatedAt', 'submittedAt', 'expiresAt', 'retryCount', 'nextRetryAt', 'source', 'mode', 'scheduledFor', 'checkedAt', 'confirmedAt', 'attentionReason', 'verificationAttemptedAt', 'nativeVerification', 'tabId', 'owned', 'uncertain', 'recoveryReason', 'recoveryOriginTaskId', 'messagePreparedAt', 'submitPermitAt', 'submitClickedAt', 'verificationPermitAt', 'verificationClickedAt'];
    const result = Object.fromEntries(keys.filter(key => task[key] !== undefined).map(key => [key, task[key]]));
    function observation(value, phaseKey) {
      const safe = {};
      if (Number.isFinite(value.at)) safe.at = value.at;
      if (Object.hasOwn(LABELS, value[phaseKey]) || ['loading', 'ready'].includes(value[phaseKey])) safe[phaseKey] = value[phaseKey];
      if (Object.hasOwn(DETAILS, value.code)) safe.code = value.code;
      if (['loading', 'interactive', 'complete'].includes(value.readyState)) safe.readyState = value.readyState;
      return safe;
    }
    if (task.lastObservation) result.lastObservation = observation(task.lastObservation, 'status');
    if (Array.isArray(task.diagnostics)) result.diagnostics = task.diagnostics.slice(-20).map(value => observation(value, 'phase'));
    return result;
  }

  function publicRecovery(recovery, task, now = Date.now()) {
    if (!recovery) return null;
    const keys = ['originTaskId', 'day', 'createdAt', 'checkTaskId', 'checkedAt'];
    const result = Object.fromEntries(keys.filter(key => recovery[key] !== undefined).map(key => [key, recovery[key]]));
    result.reason = Object.hasOwn(DETAILS, recovery.reason) ? recovery.reason : 'unknown_result';
    result.canRetry = task?.id === recovery.checkTaskId && task?.recoveryOriginTaskId === recovery.originTaskId &&
      task.mode === 'inspect' && task.status === 'unknown' && task.lastObservation?.status === 'ready' &&
      Number.isFinite(recovery.checkedAt) && now >= recovery.checkedAt && now - recovery.checkedAt <= RECOVERY_CHECK_MS;
    return result;
  }

  function diagnosticReport(snapshot, version, now = Date.now()) {
    const settings = normalizeSettings(snapshot.settings);
    const recordKeys = ['lastScheduledDay', 'lastAttemptDay', 'lastAttemptAt', 'lastSuccessDay', 'lastConfirmedAt'];
    return {
      extensionVersion: version, exportedAt: new Date(now).toISOString(), timeZone: TIME_ZONE,
      settings: { enabled: settings.enabled, time: settings.time, timeZone: TIME_ZONE, notifications: settings.notifications, sites: settings.sites },
      records: Object.fromEntries(Object.keys(SITES).filter(id => snapshot.records?.[id]).map(id => [id, Object.fromEntries(recordKeys.filter(key => snapshot.records[id][key] !== undefined).map(key => [key, snapshot.records[id][key]]))])),
      tasks: Object.fromEntries(Object.keys(SITES).filter(id => snapshot.tasks?.[id]).map(id => [id, publicTask(snapshot.tasks[id])])),
      recoveries: Object.fromEntries(Object.keys(SITES).filter(id => snapshot.recoveries?.[id]).map(id => [id, publicRecovery(snapshot.recoveries[id], snapshot.tasks?.[id], now)])),
      history: (snapshot.history || []).slice(0, 40).map(publicTask)
    };
  }

  globalThis.CheckinCore = Object.freeze({ SITES, LABELS, DETAILS, TIME_ZONE, ACTIVE, RECOVERY_CHECK_MS, messageError, timeError, normalizeSettings, dayKey, nextDailyAt, dueSites, siteForUrl, canSubmit, retryAt, publicTask, publicRecovery, diagnosticReport });
})();
