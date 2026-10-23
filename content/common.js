(() => {
  'use strict';
  const C = globalThis.CheckinCore;
  const siteId = C.siteForUrl(location.href);
  const adapter = globalThis.CheckinAdapters?.[siteId];
  if (!siteId || !adapter || globalThis.__dailyCheckinLoaded) return;
  globalThis.__dailyCheckinLoaded = true;
  let task = null;
  let message = '666';
  let stopped = false;
  let working = false;
  let ownDispatch = false;
  let attempted = false;
  let messagePrepared = false;
  let submitClicked = false;
  let verificationAttempted = false;
  let verificationClicked = false;
  let external = false;
  let lastReport = '';
  let attachAt = 0;
  let structureAt = 0;
  let timer;
  let notice;

  async function send(value) {
    return chrome.runtime.sendMessage({ ...value, taskId: task?.id, siteId });
  }
  function show(status, detail) {
    if (!notice) {
      const host = document.createElement('div');
      host.id = 'daily-checkin-notice';
      host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{color-scheme:light}section{box-sizing:border-box;width:304px;border:1px solid #cbd9d0;border-radius:16px;background:#f8f8f0;color:#203d31;padding:17px 18px;box-shadow:0 6px 28px #173e2624;font:13px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}strong{display:block;font-size:14px;margin:0 0 5px}p{margin:0 0 12px}button{border:1px solid #c5d0c8;background:transparent;color:#254f3e;padding:5px 10px;border-radius:6px;cursor:pointer;font:inherit}button:focus-visible{outline:2px solid #275e46;outline-offset:2px}';
      const section = document.createElement('section');
      const title = document.createElement('strong');
      const text = document.createElement('p'); text.setAttribute('aria-live', 'polite');
      const stop = document.createElement('button'); stop.textContent = '停止本次自动操作';
      stop.addEventListener('click', () => {
        stopped = true; cleanup();
        send({ type: 'CHECKIN_REPORT', status: attempted ? 'unknown' : 'cancelled' }).catch(() => {});
        text.textContent = '已停止。可从插件弹窗重新检查状态。'; stop.hidden = true;
      });
      section.append(title, text, stop); shadow.append(style, section); document.documentElement.append(host);
      notice = { host, title, text, stop };
    }
    const title = `每日签到 · ${C.LABELS[status] || '处理中'}`;
    if (notice.title.textContent !== title) notice.title.textContent = title;
    if (notice.text.textContent !== detail) notice.text.textContent = detail;
  }
  function cleanup() { clearInterval(timer); observer.disconnect(); }
  async function report(status, reason, detail) {
    const key = `${status}:${reason || ''}:${detail || ''}:${document.readyState}`;
    if (lastReport === key) return;
    const response = await send({ type: 'CHECKIN_REPORT', status, reason, detail, readyState: document.readyState });
    if (response?.ok) lastReport = key;
  }
  function fill(field) {
    if (!field || field.value === message) return;
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, message);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function attach() {
    const response = await chrome.runtime.sendMessage({ type: 'CHECKIN_HELLO' });
    attachAt = Date.now();
    if (!response?.task) { stopped = true; cleanup(); return; }
    if (task?.id !== response.task.id) { attempted = false; messagePrepared = false; submitClicked = false; verificationAttempted = false; verificationClicked = false; external = false; lastReport = ''; structureAt = 0; notice?.host.remove(); notice = null; }
    task = response.task;
    attempted ||= task.submittedAt != null;
    messagePrepared ||= task.messagePreparedAt != null;
    submitClicked ||= task.submitClickedAt != null;
    verificationAttempted ||= task.verificationAttemptedAt != null;
    verificationClicked ||= task.verificationClickedAt != null;
    message = response.message;
    if (task.status === 'unknown') external = true;
  }
  async function tick() {
    if (stopped || working) return;
    working = true;
    try {
      if (Date.now() - attachAt > 5000) await attach();
      if (!task || stopped || C.siteForUrl(location.href) !== siteId) return;
      const view = adapter.inspect(document);
      if (view.status === 'already_done') {
        await report('already_done'); cleanup(); notice?.host.remove(); stopped = true; return;
      }
      if (view.status === 'failed') {
        if (!structureAt) structureAt = Date.now();
        if (Date.now() - structureAt < 2500) return;
        await report(attempted || external ? 'unknown' : 'failed', view.reason, view.detail);
        show(attempted || external ? 'unknown' : 'failed', view.message); return;
      }
      structureAt = 0;
      if (view.status === 'loading') {
        await report('loading', undefined, view.detail);
        return;
      }
      const inspecting = task.mode === 'inspect' || external;
      if (!inspecting && !attempted) {
        fill(view.field);
        if (siteId === 'sb' && view.field && view.field.value === message && !messagePrepared) {
          const progress = await send({ type: 'CHECKIN_PROGRESS', phase: 'message_prepared' });
          messagePrepared = progress?.ok === true;
        }
      }
      if (view.status === 'waiting_verification' || view.status === 'needs_login') {
        const nativeWaiting = view.status === 'waiting_verification' && view.nativeVerification && attempted;
        const detail = view.verificationState === 'error' ? 'verification_error' : view.verificationState === 'verifying' ? 'verification_running' : nativeWaiting && verificationClicked ? 'verification_clicked' : undefined;
        await report(view.status, nativeWaiting ? 'native_verification' : undefined, detail);
        if (nativeWaiting && !external && !verificationAttempted && view.verificationButton) {
          verificationAttempted = true;
          const allowed = await send({ type: 'CHECKIN_VERIFY_GRANT' });
          if (allowed?.allowed && !stopped) {
            const current = adapter.inspect(document);
            if (current.status === 'waiting_verification' && current.nativeVerification && current.verificationButton?.isConnected) {
              current.verificationButton.click();
              verificationClicked = true;
              await send({ type: 'CHECKIN_PROGRESS', phase: 'verification_clicked' });
              await report('waiting_verification', 'native_verification', 'verification_clicked');
              show('waiting_verification', '已尝试点击网站验证，正在等待网站结果。'); return;
            }
            await report('waiting_verification', 'native_verification', 'verification_unavailable');
          }
        }
        show(view.status, detail ? `${C.DETAILS[detail]}。如未继续，请打开原页面手动处理。` : view.message); return;
      }
      if (view.status !== 'ready') return;
      if ((task.status === 'needs_login' && task.mode === 'execute' && !attempted) ||
          (task.status === 'unknown' && task.attentionReason === 'login_required')) {
        await report('ready');
        await attach();
        if (!task || stopped) return;
      }
      if (attempted) {
        show(task.status === 'unknown' ? 'unknown' : 'submitting', task.status === 'unknown' ? task.message : submitClicked ? '已点击签到，正在等待网站确认结果。' : '已发放签到点击许可，正在核对网站结果。');
        return;
      }
      if (inspecting) {
        await report('ready');
        show(external ? 'unknown' : 'idle', external ? '已出现提交操作，插件只观察结果。' : '今日尚未签到。可从插件弹窗发起签到。');
        if (!external) { cleanup(); stopped = true; }
        return;
      }
      const allowed = await send({ type: 'CHECKIN_GRANT', nativeVerification: view.nativeVerification === true });
      if (!allowed?.allowed) { await attach(); return; }
      attempted = true;
      const current = adapter.inspect(document);
      if (current.status !== 'ready' || !current.button?.isConnected || stopped) {
        await report('unknown', undefined, 'page_changed'); show('unknown', '取得提交许可后页面发生变化，请检查网站结果。'); return;
      }
      ownDispatch = true;
      try { current.button.click(); } finally { ownDispatch = false; }
      submitClicked = true;
      await send({ type: 'CHECKIN_PROGRESS', phase: 'submit_clicked' });
      show('submitting', '已点击签到，正在等待网站确认。需要验证时请在网站处理。');
    } catch {
      if (attempted) show('unknown', '结果尚未确认。请重新打开插件查看状态。');
    } finally { working = false; }
  }
  document.addEventListener('submit', event => {
    if (!task || stopped || ownDispatch || attempted || external) return;
    const current = adapter.inspect(document);
    if (event.target !== current.form) return;
    external = true;
    report('unknown', undefined, 'unknown_result').catch(() => {});
  }, true);
  const observer = new MutationObserver(() => { void tick(); });
  function watch() {
    stopped = false;
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'data-state', 'aria-disabled'], characterData: true });
    clearInterval(timer);
    timer = setInterval(() => { void tick(); }, 750);
  }
  for (const event of ['solve', 'reset', 'online', 'pageshow']) window.addEventListener(event, () => { void tick(); });
  chrome.runtime.onMessage.addListener((incoming, _sender, respond) => {
    if (incoming.type === 'CHECKIN_STOP' && task?.id === incoming.taskId) {
      stopped = true; cleanup(); notice?.host.remove(); respond({ ok: true });
    } else if (incoming.type === 'CHECKIN_POLL') {
      // Reply before reattaching: restore holds the controller lock until this ACK.
      respond({ ok: true });
      attachAt = 0; watch(); void tick();
    }
    return false;
  });
  watch();
  void tick();
})();
