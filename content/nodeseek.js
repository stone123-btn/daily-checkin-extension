(() => {
  'use strict';
  const D = globalThis.CheckinDOM;
  function inspect(doc) {
    const head = doc.querySelector('.board .head-info');
    if (head && /今日签到获得鸡腿\s*\d+\s*个/.test(D.text(head))) return { status: 'already_done', message: '网站确认今日已签到。' };
    const blocked = D.blockers(doc, head);
    if (blocked) return blocked;
    if (!head) return D.loading('region_missing');
    if (/^Loading$/i.test(D.text(head))) return D.loading('loading_data');
    const check = D.verification(head);
    if (check.required && !check.passed) return { status: 'waiting_verification', message: '请在网站完成机器人验证，通过后继续。' };
    const candidates = [...head.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(D.visible);
    if (!candidates.length && (!D.text(head) || /今日还未签到/.test(D.text(head)))) return D.loading('controls_pending');
    // Verified in the site's board bundle: fixed reward calls attendance(false).
    // Require the complete pending-state contract before choosing that reward.
    const fixed = candidates.filter(b => b.matches('button.btn') && /^鸡腿\s*[x×]\s*5$/.test(D.text(b)));
    const random = candidates.filter(b => b.matches('button.btn') && D.text(b) === '试试手气');
    const native = /今日还未签到/.test(D.text(head)) && candidates.length === 2 && fixed.length === 1 && random.length === 1;
    const buttons = native ? fixed : candidates.filter(b => /^(?:立即|每日|开始|固定|随机|一键)?签到(?:[（(].*[)）])?$/.test(D.text(b)));
    if (buttons.length !== 1) return D.failed('未找到唯一的签到按钮；请在网站确认签到方式。');
    const button = buttons[0];
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return D.loading('button_disabled');
    return { status: 'ready', button, form: button.closest('form'), message: '今日尚未签到。' };
  }
  globalThis.CheckinAdapters.nodeseek = Object.freeze({ inspect });
})();
