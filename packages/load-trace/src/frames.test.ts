/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createLoadTracer, startFrameMonitor, type ObserverCtor } from './index.js';

interface FakeEntry { startTime: number; duration: number; blockingDuration?: number }

/** A PerformanceObserver double: `deliver` queues entries the way the browser does before the callback runs. */
function fakeObserver(supported: string[]) {
  const live = new Map<string, { cb: (l: { getEntries(): FakeEntry[] }) => void; queued: FakeEntry[] }>();
  const Ctor = class {
    private type = '';
    constructor(private readonly cb: (l: { getEntries(): FakeEntry[] }) => void) {}
    observe(o: { type: string }) { this.type = o.type; live.set(o.type, { cb: this.cb, queued: [] }); }
    takeRecords() { const slot = live.get(this.type)!; const q = slot.queued; slot.queued = []; return q; }
    disconnect() { live.delete(this.type); }
    static supportedEntryTypes = supported;
  } as unknown as ObserverCtor;
  return {
    Ctor,
    /** Fire the callback now. */
    fire(type: string, entries: FakeEntry[]) { live.get(type)?.cb({ getEntries: () => entries }); },
    /** Leave entries undelivered (only `takeRecords` sees them). */
    queue(type: string, entries: FakeEntry[]) { live.get(type)?.queued.push(...entries); },
  };
}

describe('long-frame summary per load (#6957)', () => {
  it('sums LoAF blocking time in the load window and attributes it to the innermost open span', () => {
    let now = 0;
    const obs = fakeObserver(['long-animation-frame', 'longtask']);
    const frames = startFrameMonitor(obs.Ctor);
    const tracer = createLoadTracer({ enabled: true, sink: null, counters: null, frames, now: () => now });
    obs.fire('long-animation-frame', [{ startTime: 5, duration: 300, blockingDuration: 250 }]); // before the load
    const trace = tracer.startLoad('l', {}, 100);
    now = 100;
    const finalize = trace.begin('load.finalize');
    now = 400;
    const inner = trace.begin('cache.write');
    now = 500;
    trace.end(inner);
    trace.end(finalize);
    trace.milestone('geometry.streamComplete'); // milestones never own a frame
    obs.fire('long-animation-frame', [
      { startTime: 150, duration: 80, blockingDuration: 20 },
      { startTime: 420, duration: 200, blockingDuration: 140 },
      { startTime: 600, duration: 60, blockingDuration: 5 },
    ]);
    obs.queue('longtask', [{ startTime: 420, duration: 190 }]);
    now = 700;
    tracer.startLoad('next', {}, 650);
    obs.fire('long-animation-frame', [{ startTime: 660, duration: 90, blockingDuration: 30 }]); // the next load's

    const summary = tracer.snapshots()[0].mainThread!;
    expect(summary.supported).toEqual({ loaf: true, longtask: true });
    expect(summary.loaf).toEqual({ count: 3, over50: 3, totalMs: 340, blockingMs: 165, longestMs: 200 });
    // The undelivered long task was flushed by takeRecords; blocked = 190 - 50.
    expect(summary.longtask).toEqual({ count: 1, over50: 1, totalMs: 190, blockingMs: 140, longestMs: 190 });
    expect(summary.bySpan).toEqual({
      'load.finalize': { count: 1, blockingMs: 20, durationMs: 80 },
      'cache.write': { count: 1, blockingMs: 140, durationMs: 200 },
      load: { count: 1, blockingMs: 5, durationMs: 60 },
    });
  });

  it('reports unsupported entry types instead of a clean zero', () => {
    const tracer = createLoadTracer({ enabled: true, sink: null, counters: null, frames: startFrameMonitor(fakeObserver([]).Ctor), now: () => 1 });
    tracer.startLoad('l', {}, 0);
    const summary = tracer.latest()!.mainThread!;
    expect(summary.supported).toEqual({ loaf: false, longtask: false });
    expect(summary.loaf.count).toBe(0);
    expect(startFrameMonitor(undefined).supported).toEqual({ loaf: false, longtask: false });
  });
});
