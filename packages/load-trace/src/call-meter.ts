/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { perfCounters, type PerfCounterRegistry } from './counters.js';

/**
 * Count the typed-array bytes handed to an object's methods (#6957). Wrapped
 * around a wasm-bindgen API object it measures what crosses INTO wasm linear
 * memory: wasm-bindgen copies every `&[u8]` / `&[u32]` argument there, so a
 * whole-file `Uint8Array` argument is one full source copy per call.
 *
 *   <prefix>.bytesIn             all typed-array argument bytes
 *   <prefix>.<method>.calls      calls that carried at least one typed array
 *   <prefix>.<method>.bytes      their typed-array bytes
 *
 * With counters off it returns `target` itself (no Proxy). Methods run with
 * the real object as `this`, so wasm-bindgen's pointer checks still pass.
 */
export function meterTypedArrayArgs<T extends object>(
  target: T, prefix: string, registry: PerfCounterRegistry = perfCounters,
): T {
  if (!registry.enabled) return target;
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      let fn = wrapped.get(prop);
      if (fn === undefined) {
        const method = value as (...args: unknown[]) => unknown;
        fn = (...args: unknown[]) => {
          let bytes = 0, views = 0;
          for (const a of args) if (ArrayBuffer.isView(a)) { bytes += a.byteLength; views++; }
          if (views > 0) {
            registry.add(`${prefix}.bytesIn`, bytes);
            registry.add(`${prefix}.${prop}.calls`);
            registry.add(`${prefix}.${prop}.bytes`, bytes);
          }
          return method.apply(obj, args);
        };
        wrapped.set(prop, fn);
      }
      return fn;
    },
  });
}
