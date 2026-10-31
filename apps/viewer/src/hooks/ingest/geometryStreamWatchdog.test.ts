/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The geometry stream watchdog and the `geometry_stream_stalled` capture.
 *
 * Invariants: a window of RUNNING silence fails the load on time; a timer that
 * fires late because the page was suspended (frozen tab, sleep) re-arms instead
 * of reporting work that never ran; and the first attempt's capture (the one
 * that triggers the lower-detail retry) carries the same diagnostics as the
 * terminal one, surviving the analytics scrubber. Production showed every stall
 * whose retry also stalled arriving as a first event with neither `stall_phase`
 * nor `file_size_mb`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGeometryStreamWatchdogMs, type StallPhase } from '@ifc-lite/geometry';
import { scrubEvent } from '@/lib/analytics-scrub';
import { classifyLoadError, errorCaptureProps } from '@/lib/load-errors';
import {
  SUSPEND_LATENESS_MS,
  createStreamWatchdogState,
  geometryFailureCaptureProps,
  pullWithStallWatchdog,
  type WatchdogClock,
} from './geometryStreamWatchdog.js';

/** Manual clock: `advance` runs due timers in order; `suspend` moves time
 *  without running any, the way a frozen page does. */
class FakeClock implements WatchdogClock {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  hidden = false;
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  isHidden(): boolean { return this.hidden; }
  get pending(): number { return this.timers.size; }
  suspend(ms: number): void { this.time += ms; }
  /** Run every timer due by now (a resumed page runs overdue timers at once). */
  resume(): void { this.advance(0); }
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
    }
    this.time = until;
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const never = <T>() => new Promise<T>(() => {});
const WINDOW = getGeometryStreamWatchdogMs({ desktopStableWasm: false, batchCount: 1, fileSizeMB: 16.87 });

function outcome<T>(promise: Promise<T>): { value?: T; error?: Error; settled: boolean } {
  const state: { value?: T; error?: Error; settled: boolean } = { settled: false };
  promise.then(
    (value) => { state.value = value; state.settled = true; },
    (error: Error) => { state.error = error; state.settled = true; },
  );
  return state;
}

describe('pullWithStallWatchdog', () => {
  it('fails a pool silent for one running window, on time, with the classified stall message', async () => {
    const clock = new FakeClock();
    clock.hidden = true;
    const state = createStreamWatchdogState();
    const pull = outcome(pullWithStallWatchdog(never(), WINDOW, 165, state, clock));
    clock.advance(WINDOW - 1);
    await settle();
    assert.equal(pull.settled, false, 'one ms short of the window is not a stall');
    clock.advance(1);
    await settle();
    assert.equal(pull.error?.message, `Geometry stream stalled after ${WINDOW}ms. Last rendered meshes: 165.`);
    assert.equal(classifyLoadError(pull.error, 'geometry_processing'), 'geometry_stream_stalled');
    assert.deepEqual(state.stall, { lateMs: 0, hidden: true });
    assert.equal(state.suspendedRearms, 0);
  });

  it('re-arms a window whose timer fired late because the page was suspended', async () => {
    const clock = new FakeClock();
    const state = createStreamWatchdogState();
    let deliver!: (value: string) => void;
    const pull = outcome(pullWithStallWatchdog(new Promise<string>((r) => { deliver = r; }), WINDOW, 321, state, clock));
    clock.advance(10_000);
    // Frozen for ten minutes: the worker posts nothing and no timer runs.
    clock.suspend(600_000);
    clock.resume();
    await settle();
    assert.equal(pull.settled, false, 'the overdue timer must not report a stall the pool never had a chance to answer');
    assert.equal(state.suspendedRearms, 1);
    // The resumed worker's next heartbeat arrives a second later.
    clock.advance(1_000);
    deliver('heartbeat');
    await settle();
    assert.equal(pull.value, 'heartbeat');
    assert.equal(state.stall, undefined);
    assert.equal(clock.pending, 0, 'the re-armed timer is cleared once the pull resolves');
  });

  it('still fails a pool that stays silent for a full running window after the page resumes', async () => {
    const clock = new FakeClock();
    const state = createStreamWatchdogState();
    const pull = outcome(pullWithStallWatchdog(never(), WINDOW, 0, state, clock));
    clock.suspend(WINDOW + SUSPEND_LATENESS_MS + 1);
    clock.resume();
    await settle();
    assert.equal(pull.settled, false);
    clock.advance(WINDOW);
    await settle();
    assert.match(pull.error?.message ?? '', /^Geometry stream stalled after/);
    assert.deepEqual(state.stall, { lateMs: 0, hidden: false });
    assert.equal(state.suspendedRearms, 1);
  });

  it('treats lateness up to the threshold as an ordinary on-time stall', async () => {
    const clock = new FakeClock();
    const state = createStreamWatchdogState();
    const pull = outcome(pullWithStallWatchdog(never(), WINDOW, 7, state, clock));
    clock.suspend(WINDOW + SUSPEND_LATENESS_MS);
    clock.resume();
    await settle();
    assert.match(pull.error?.message ?? '', /stalled/);
    assert.equal(state.stall?.lateMs, SUSPEND_LATENESS_MS);
    assert.equal(state.suspendedRearms, 0);
  });

  it('propagates a failing pull and leaves no timer armed', async () => {
    const clock = new FakeClock();
    const state = createStreamWatchdogState();
    const boom = new Error('Geometry worker failed: worker terminated unexpectedly');
    const pull = outcome(pullWithStallWatchdog(Promise.reject(boom), WINDOW, 0, state, clock));
    await settle();
    assert.equal(pull.error, boom);
    assert.equal(clock.pending, 0);
    assert.equal(state.stall, undefined);
  });
});

describe('geometry_processing capture props', () => {
  const stallError = new Error(`Geometry stream stalled after ${WINDOW}ms. Last rendered meshes: 165.`);

  function scrubbedCapture(extra: Record<string, unknown>, isRetry: boolean, phase: StallPhase) {
    const props = geometryFailureCaptureProps({
      fileSizeMB: 16.8712,
      stallPhaseHandle: { getStallPhase: () => phase },
      watchdog: { suspendedRearms: 2, stall: { lateMs: 12, hidden: true } },
      wasHidden: true,
    });
    const event = scrubEvent({
      event: '$exception',
      properties: {
        context: 'geometry_processing',
        ...errorCaptureProps(stallError, 'geometry_processing'),
        load_stage: 'geometry-stream',
        is_retry: isRetry,
        ...extra,
        ...props,
      },
    });
    assert.ok(event?.properties);
    return event.properties;
  }

  it('gives the first attempt and the terminal retry the same stall diagnostics, intact after scrubbing', () => {
    const first = scrubbedCapture({ resource_retry: 'lowest' }, false, 'workers');
    const terminal = scrubbedCapture({}, true, 'workers');
    for (const props of [first, terminal]) {
      assert.equal(props.error_kind, 'geometry_stream_stalled');
      assert.equal(props.file_size_mb, 16.87);
      assert.equal(props.stall_phase, 'workers');
      assert.equal(props.was_hidden, true);
      assert.equal(props.hidden_at_stall, true);
      assert.equal(props.stall_late_ms, 12);
      assert.equal(props.watchdog_suspended_rearms, 2);
    }
    assert.equal(first.resource_retry, 'lowest');
  });

  it('omits the stall timing for a failure the watchdog did not raise', () => {
    const props = geometryFailureCaptureProps({
      fileSizeMB: 9.5, stallPhaseHandle: {}, watchdog: createStreamWatchdogState(), wasHidden: false,
    });
    assert.equal(props.stall_phase, undefined);
    assert.equal('stall_late_ms' in props, false);
    assert.equal('hidden_at_stall' in props, false);
    assert.equal(props.watchdog_suspended_rearms, 0);
  });
});
