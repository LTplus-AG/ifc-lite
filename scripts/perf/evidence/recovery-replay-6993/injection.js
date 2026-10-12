/* SPDX-License-Identifier: MPL-2.0 */
(() => {
  const records = [];
  const events = [];
  const original = GPUAdapter.prototype.requestDevice;
  let holding = false;
  let releaseHeld;
  let timeout;
  const hold = new Promise(resolve => { releaseHeld = resolve; });
  const release = () => {
    if (!holding) return;
    holding = false;
    clearTimeout(timeout);
    events.push({ event: 'replacement-released', at: performance.now() });
    releaseHeld();
  };
  GPUAdapter.prototype.requestDevice = async function (...args) {
    if (holding) {
      events.push({ event: 'replacement-held', at: performance.now() });
      await hold;
    }
    const device = await original.apply(this, args);
    const nativeLost = device.lost;
    let resolveLost;
    const lost = new Promise(resolve => { resolveLost = resolve; });
    const record = { device, alive: true, forced: false, resolveLost };
    records.push(record);
    nativeLost.then(info => {
      record.alive = false;
      if (!record.forced) resolveLost(info);
    });
    Object.defineProperty(device, 'lost', { configurable: true, get: () => lost });
    events.push({ event: 'device-created', at: performance.now(), index: records.length - 1 });
    return device;
  };
  let renderedStats;
  let armed = new URL(location.href).searchParams.get('qaForce') === '1';
  Object.defineProperty(globalThis, '__ifc_lite_render_stats__', {
    configurable: true,
    get: () => renderedStats,
    set(value) {
      renderedStats = value;
      events.push({ event: 'renderer-published', at: performance.now() });
      if (armed) {
        armed = false;
        queueMicrotask(() => globalThis.__REPLAY_QA__.lose());
      }
    },
  });
  globalThis.__REPLAY_QA__ = {
    lose() {
      const record = records.find(entry => entry.alive);
      if (!record) throw new Error('No live drawing device to lose');
      holding = true;
      timeout = setTimeout(() => {
        events.push({ event: 'hold-timeout', at: performance.now() });
        release();
      }, 20000);
      record.forced = true;
      record.alive = false;
      record.device.destroy();
      record.resolveLost({ reason: 'unknown', message: 'Controlled GPU loss for #6993 arrival/recovery qualification' });
      events.push({ event: 'drawing-device-lost', at: performance.now(), index: records.indexOf(record) });
      return records.indexOf(record);
    },
    release,
    snapshot: () => ({ holding, events: events.slice(), devices: records.length }),
  };
})();
