(() => {
  'use strict';
  const text = el => (el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
  function visible(el) {
    if (!el || el.type === 'hidden') return false;
    for (let node = el; node?.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.style?.display === 'none' || node.style?.visibility === 'hidden') return false;
    }
    const view = el.ownerDocument?.defaultView;
    if (typeof view?.getComputedStyle === 'function') {
      const style = view.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;
  }
  function blockers(doc, scope) {
    if (doc.querySelector('form input[type="password"]') || /请(?:先|重新)?登录|(?:尚未|未)登录|登录(?:信息|状态)?(?:已)?(?:失效|过期)|登录后.{0,15}签到/.test(text(scope))) {
      return { status: 'needs_login', message: '请在网站登录后返回签到页。' };
    }
    if (doc.querySelector('#challenge-form, #challenge-running, #cf-challenge-running') || /just a moment|attention required/i.test(doc.title)) {
      return { status: 'waiting_verification', message: '请打开网站完成访问验证，通过后自动继续。' };
    }
    return null;
  }
  function loginEntry(doc, siteId) {
    const site = CheckinCore.SITES[siteId];
    return [...doc.querySelectorAll('header a[href], nav a[href]')].some(link => {
      if (!visible(link) || link.closest('article, blockquote, pre, code') || !/^(?:登录|登入|log\s*in|sign\s*in)$/i.test(text(link))) return false;
      try {
        const url = new URL(link.getAttribute('href'), site.url);
        return url.protocol === 'https:' && !url.port && url.hostname === site.host && /^\/(?:login|signin)(?:\.html)?\/?$/i.test(url.pathname);
      } catch { return false; }
    });
  }
  function verification(scope) {
    if (!scope) return { required: false, passed: true };
    const widgets = [...scope.querySelectorAll('cap-widget, .cf-turnstile, .h-captcha, .g-recaptcha')];
    const fields = [...scope.querySelectorAll('input[name="cap-token"],input[name="capToken"],input[name="cap_token"],input[name="cf-turnstile-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"],input[name="g-recaptcha-response"]')];
    const frames = [...scope.querySelectorAll('iframe')].filter(f => /captcha|challenge|turnstile/i.test(`${f.getAttribute('src') || ''} ${f.title || ''}`) && visible(f));
    const required = widgets.length > 0 || fields.length > 0 || frames.length > 0;
    const states = widgets.map(w => w.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state') || w.getAttribute('data-state'));
    if (states.some(s => s === 'verifying' || s === 'error')) return { required: true, passed: false };
    // Values stay on the page. Only the boolean result is exposed to the adapter.
    const passed = !required || (fields.length > 0 && fields.every(f => !!f.value?.trim())) || (widgets.length > 0 && states.every(s => s === 'done'));
    return { required, passed };
  }
  const failed = (message, detail = 'unknown_controls') => ({ status: 'failed', reason: 'structure', detail, message });
  const loading = detail => ({ status: 'loading', detail, message: `${CheckinCore.DETAILS[detail]}，正在等待。` });
  globalThis.CheckinDOM = Object.freeze({ text, visible, blockers, loginEntry, verification, failed, loading });
  globalThis.CheckinAdapters ||= {};
})();
