/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** All constructors, messages and transfers delegate to genuine browser Workers. */
export function installWorkerObserver({ capturePayloads = false } = {}) {
  const events = [], ids = new WeakMap();
  let next = 0;
  globalThis.__POOL_PAYLOADS__ = [];
  const record = (worker, direction, data) => {
    if (events.length >= 100_000) throw new Error('Worker observer event budget exceeded');
    events.push({ sequence: events.length, at: performance.now(), id: identify(worker), direction,
      type: data?.type ?? null, token: data?.token ?? null, wasmHeapBytes: data?.wasmHeapBytes ?? null });
    if (capturePayloads && direction === 'in' && data?.type === 'batch') {
      globalThis.__POOL_PAYLOADS__.push(structuredClone(data));
    }
  };
  const identify = worker => {
    if (!ids.has(worker)) {
      ids.set(worker, ++next);
      worker.addEventListener('message', event => record(worker, 'in', event.data));
      worker.addEventListener('error', event => record(worker, 'error', { type: event.message }));
    }
    return ids.get(worker);
  };
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget);
      record(worker, 'construct', null);
      return worker;
    },
  });
  const post = NativeWorker.prototype.postMessage, terminate = NativeWorker.prototype.terminate;
  NativeWorker.prototype.postMessage = function (...args) {
    record(this, 'out', args[0]);
    return Reflect.apply(post, this, args);
  };
  NativeWorker.prototype.terminate = function (...args) {
    record(this, 'terminate', null);
    return Reflect.apply(terminate, this, args);
  };
  globalThis.__PRIVATE_POOL_EVENTS__ = events;
}
