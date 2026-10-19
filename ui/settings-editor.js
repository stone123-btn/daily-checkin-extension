// Shared draft handling for the popup and options page. Storage updates merge
// untouched fields; an explicit save writes only the user's edited fields.
export function createSettingsEditor(inputs, onChange = () => {}) {
  const fields = new Map(Object.entries(inputs).map(([key, input]) => [key, { input, dirty: false, external: false, loaded: false, busy: false }]));
  const read = field => field.input.type === 'checkbox' ? field.input.checked : field.input.value;
  const valueAt = (settings, key) => key.split('.').reduce((value, part) => value?.[part], settings);
  const put = (target, key, value) => {
    const parts = key.split('.');
    if (parts.length === 2) (target[parts[0]] ||= {})[parts[1]] = value;
    else target[key] = value;
  };
  for (const [key, field] of fields) {
    field.input.disabled = true;
    field.input.addEventListener('input', () => {
      field.dirty = read(field) !== field.saved;
      if (!field.dirty) field.external = false;
      onChange(key, field);
    });
  }
  return {
    sync(settings) {
      for (const [key, field] of fields) {
        const value = valueAt(settings, key);
        const changed = field.loaded && field.saved !== value;
        field.saved = value;
        if (!field.dirty) {
          if (read(field) !== value) field.input[field.input.type === 'checkbox' ? 'checked' : 'value'] = value;
        } else if (read(field) === value) {
          field.dirty = false; field.external = false;
        } else if (changed) field.external = true;
        field.loaded = true;
        field.input.disabled = field.busy;
        if (changed) onChange(key, field);
      }
    },
    patch(keys = [...fields.keys()]) {
      const result = {};
      for (const key of keys) if (fields.get(key).dirty) put(result, key, read(fields.get(key)));
      return result;
    },
    accept(patch) {
      for (const [key, field] of fields) if (valueAt(patch, key) !== undefined && read(field) === valueAt(patch, key)) {
        field.dirty = false; field.external = false;
      }
    },
    busy(keys, busy) {
      for (const key of keys) {
        const field = fields.get(key); field.busy = busy; field.input.disabled = busy || !field.loaded;
      }
    },
    isDirty: key => key ? fields.get(key).dirty : [...fields.values()].some(field => field.dirty)
  };
}

export function scheduleSummary(settings, records = {}, now = Date.now()) {
  const C = globalThis.CheckinCore;
  if (!settings.enabled) return '自动签到已关闭，保存时间不会开启。';
  const sites = Object.keys(C.SITES).filter(id => settings.sites[id]);
  if (!sites.length) return '网站均已停用，可在设置中启用。';
  if (C.dueSites(settings, records, now).length) return '今天尚有任务待补跑 · UTC+8';
  let at = Math.max(C.nextDailyAt(now, settings.time), settings.scheduleNotBefore || 0);
  if (C.dayKey(at) === C.dayKey(now) && sites.every(id => records[id]?.lastScheduledDay === C.dayKey(now))) at += 24 * 60 * 60000;
  const formatted = new Intl.DateTimeFormat('zh-CN', { timeZone: C.TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  return `下次计划：${formatted} · UTC+8`;
}
