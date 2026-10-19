import '../shared/core.js';

const C = globalThis.CheckinCore;

export function createScheduler({ chrome: api, controller, now = Date.now }) {
  let queue = Promise.resolve();
  return {
    refresh({ catchUp = false } = {}) {
      const result = queue.then(async () => {
        const { settings, records } = await controller.snapshot();
        if (!settings.enabled || !Object.values(settings.sites).some(Boolean)) {
          await api.alarms.clear('daily-checkin');
          await api.alarms.clear('checkin-watchdog');
          return;
        }
        if (catchUp) {
          for (const siteId of C.dueSites(settings, records, now())) {
            await controller.start(siteId, { source: 'scheduled' });
          }
        }
        await api.alarms.create('daily-checkin', { when: Math.max(C.nextDailyAt(now(), settings.time), settings.scheduleNotBefore || 0) });
        if (!await api.alarms.get('checkin-watchdog')) {
          await api.alarms.create('checkin-watchdog', { delayInMinutes: 15, periodInMinutes: 15 });
        }
      });
      queue = result.catch(() => {});
      return result;
    }
  };
}
