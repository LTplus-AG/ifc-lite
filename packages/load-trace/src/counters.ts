/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural perf counters (#6957): plain named sums (messages, bytes copied,
 * GPU buffers, setState calls, ...) that any package bumps without knowing
 * which load is running. A load trace reads the registry when the load starts
 * and again when it ends, so each load reports the delta (`LoadTraceSnapshot.counters`).
 *
 * OFF until `enable()`: every bump is then one boolean test, so the call sites
 * in hot paths (renderer, store, worker message wrapper) cost nothing
 * measurable in production. The viewer enables it only under `?perfTrace=1`
 * and in benchmark runs.
 */

export type CounterValues = Record<string, number>;

export interface PerfCounterRegistry {
  readonly enabled: boolean;
  enable(): void;
  /** End a worker load epoch and discard its retained counters. */
  reset(): void;
  add(name: string, n?: number): void;
  /** Copy of every counter's running total. */
  read(): CounterValues;
  /** Increments since the previous `drain` (or since enable), or `null` when nothing moved. */
  drain(): CounterValues | null;
}

export function createPerfCounters(): PerfCounterRegistry {
  const totals = new Map<string, number>();
  let pending = new Map<string, number>();
  let enabled = false;
  return {
    get enabled() { return enabled; },
    enable() { enabled = true; },
    reset() { enabled = false; totals.clear(); pending.clear(); },
    add(name, n = 1) {
      if (!enabled) return;
      totals.set(name, (totals.get(name) ?? 0) + n);
      pending.set(name, (pending.get(name) ?? 0) + n);
    },
    read: () => Object.fromEntries(totals),
    drain() {
      if (pending.size === 0) return null;
      const out = Object.fromEntries(pending);
      pending = new Map();
      return out;
    },
  };
}

/**
 * One registry per JS realm, kept on `globalThis` so two bundled copies of
 * this package (a published package's `dist` plus the app's source) still
 * share it. Each worker has its own realm and therefore its own registry; it
 * reaches the main thread through `createWorkerTraceHost`.
 */
const REGISTRY_KEY = Symbol.for('ifc-lite.perf-counters');
const realm = globalThis as typeof globalThis & { [REGISTRY_KEY]?: PerfCounterRegistry };
export const perfCounters: PerfCounterRegistry = realm[REGISTRY_KEY] ??= createPerfCounters();

/** Bump `name` by `n` (default 1) when counters are on. */
export function perfCount(name: string, n = 1): void {
  if (perfCounters.enabled) perfCounters.add(name, n);
}

/** Bump `<name>.count` by one and `<name>.<unit>` by `amount` (e.g. a copy and its bytes). */
export function perfTally(name: string, amount: number, unit = 'bytes'): void {
  if (!perfCounters.enabled) return;
  perfCounters.add(`${name}.count`);
  perfCounters.add(`${name}.${unit}`, amount);
}

/** Count a full copy of a buffer as `copy.<kind>` and hand the copy back unchanged. */
export function countCopy<T extends ArrayBufferLike | ArrayBufferView>(kind: string, copy: T): T {
  if (perfCounters.enabled) perfTally(`copy.${kind}`, copy.byteLength);
  return copy;
}

/** `after - before` per name, dropping zeros (counters only grow). */
export function diffCounters(after: CounterValues, before: CounterValues): CounterValues {
  const out: CounterValues = {};
  for (const [name, value] of Object.entries(after)) {
    const delta = value - (before[name] ?? 0);
    if (delta !== 0) out[name] = delta;
  }
  return out;
}

/** Add `delta` into `into` in place. */
export function addCounters(into: CounterValues, delta: Readonly<CounterValues>): void {
  for (const [name, value] of Object.entries(delta)) into[name] = (into[name] ?? 0) + value;
}
