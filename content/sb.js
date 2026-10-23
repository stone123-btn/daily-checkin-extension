(() => {
  'use strict';
  const D = globalThis.CheckinDOM;
  function inspect(doc) {
    const hero = doc.querySelector('.signin-hero');
    const completed = [...(hero?.querySelectorAll('.signin-hero-action button') || [])].some(b => b.disabled && D.text(b) === '今日已签到' && D.visible(b));
    if (completed) return { status: 'already_done', message: '网站确认今日已签到。' };
    const blocked = D.blockers(doc, hero);
    if (blocked) return blocked;
    const forms = [...doc.querySelectorAll('form')].filter(f => {
      try { return (f.getAttribute('method') || '').toLowerCase() === 'post' && CheckinCore.siteForUrl(new URL(f.getAttribute('action') || '', CheckinCore.SITES.sb.url).href) === 'sb'; }
      catch { return false; }
    });
    if (!forms.length) {
      if (D.loginEntry(doc, 'sb')) return { status: 'needs_login', message: '请重新登录烧饼后返回签到页。' };
      const notices = [...doc.querySelectorAll('main [role="alert"], main .alert')].filter(el => D.visible(el) && !el.closest('article, blockquote, pre, code') && !el.querySelector('article, blockquote, pre, code'));
      for (const notice of notices) {
        const login = D.blockers(doc, notice);
        if (login?.status === 'needs_login') return login;
      }
      return D.loading('form_missing');
    }
    if (forms.length !== 1) return D.failed('未找到唯一的签到表单，请打开网站确认页面结构。', 'ambiguous_form');
    const form = forms[0];
    const fields = [...form.querySelectorAll('input:not([type]), input[type="text"], textarea')].filter(f => !f.disabled && !f.readOnly && D.visible(f) && !/captcha|turnstile/i.test(f.name || ''));
    const buttons = [...form.querySelectorAll('button, input[type="submit"]')].filter(b => /^(?:立即|每日|开始)?签到$/.test(D.text(b)) && D.visible(b));
    if (fields.length > 1 || buttons.length > 1) return D.failed('留言框或签到按钮不唯一，已停止自动操作。', 'ambiguous_controls');
    if (!fields.length || !buttons.length) return D.loading('controls_pending');
    const check = D.verification(form);
    const modal = form.matches('.signin-form') ? form.querySelector('[data-signin-cap]') : null;
    const nativeVerification = !!modal?.querySelector('cap-widget');
    const result = { form, field: fields[0], button: buttons[0], nativeVerification };
    if (nativeVerification && D.visible(modal)) {
      const widgets = [...modal.querySelectorAll('cap-widget')].filter(D.visible);
      if (widgets.length === 1) {
        const captcha = widgets[0].shadowRoot?.querySelector('.captcha');
        result.verificationState = captcha?.getAttribute('data-state') || undefined;
        const triggers = [...(captcha?.querySelectorAll('.captcha-trigger[role="button"]') || [])].filter(D.visible);
        if (triggers.length === 1 && !triggers[0].hasAttribute('disabled') && triggers[0].getAttribute('aria-disabled') !== 'true' && (!result.verificationState || result.verificationState === 'idle')) result.verificationButton = triggers[0];
      }
    }
    // The site's own submit listener reveals this modal, and its solve listener
    // requestSubmits the form. Never click the submit button a second time.
    if (nativeVerification && modal.hidden && !check.passed && !buttons[0].disabled) return { ...result, status: 'ready', message: '点击签到后由网站打开验证框。' };
    if (check.required && !check.passed) return { ...result, status: 'waiting_verification', message: '留言已准备好，请在网站点击机器人验证，通过后继续。' };
    if (buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') return D.loading('button_disabled');
    return { ...result, status: 'ready', message: '今日尚未签到。' };
  }
  globalThis.CheckinAdapters.sb = Object.freeze({ inspect });
})();
