/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2419 — cancelling the host work, not merely un-awaiting it.
 *
 * #2305 made an async bridge method deliverable and #2387 bounded the wait for
 * it. Neither bounded the *work*: a run that exceeded `limits.timeoutMs`, or a
 * sandbox disposed mid-run, stopped waiting for `bim.clash.run` while the clash
 * engine kept intersecting geometry to completion in the background, on the
 * user's machine, for a result discarded the moment it arrived.
 *
 * These drive the real QuickJS realm; the probe suites stand in for any host
 * work that honours a signal, and the last suite runs the real `ClashNamespace`
 * end to end. Kept out of `bridge-async.test.ts` both for size and because a
 * suite that disposes sandboxes mid-run is better off in its own vitest worker
 * (see the note in `rejected-promise.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClashNamespace, type BimContext } from '@ifc-lite/sdk';
import { HostWorkQueue } from './bridge-async.js';
import { createSandbox, isSandboxRuntimeAborted } from './sandbox.js';

/** A unit cube at `x`, meshed as 12 triangles — enough for the engine to run for real. */
function cube(key: string, x: number, tag: string): Record<string, unknown> {
  return {
    key,
    ref: key === 'a' ? 1 : 2,
    model: 'm',
    tag,
    bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] },
    positions: [
      x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0,
      x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1,
    ],
    indices: [
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 3, 7, 0, 7, 4,
    ],
  };
}

const RULES = [{ id: 'r1', name: 'wall x slab', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' }];

/** A script that starts one host call and then has nothing left to do. */
const STALL_SCRIPT = `
  const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
  (async () => { await bim.clash.run(elements, ${JSON.stringify(RULES)}, {}); })();
`;

function sdkWithClash(): BimContext {
  return { clash: new ClashNamespace() } as unknown as BimContext;
}

/** Node reports an unhandled rejection on the process — the uncaught half of #2305. */
let unhandled: unknown[] = [];
const record = (err: unknown): void => { unhandled.push(err); };

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', record);
});

afterEach(() => {
  process.off('unhandledRejection', record);
});

/** Give any orphaned rejection a turn to be reported before asserting there is none. */
async function flushRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Bound a wait so a missing settle is reported as a value, never as a hang. */
function within<T>(ms: number, promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, expiry]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Reported instead of hanging when a promise never settles. */
const NEVER_SETTLED = 'never settled';

/** What one `sdk.clash.*` call saw when the bridge invoked it. */
interface ProbedCall {
  signal: AbortSignal | undefined;
  /** Whether that signal was ALREADY aborted when the call was made. */
  abortedAtCall: boolean;
}

/**
 * An SDK whose clash methods settle only by observing the signal the bridge
 * hands them — a stand-in for any host work that honours cancellation. Without
 * a signal they never settle, which is exactly the pre-fix behaviour, so a test
 * that fails here fails loudly rather than silently passing.
 */
function cancelProbe(): {
  sdk: BimContext;
  calls: ProbedCall[];
  cancelReason: (withinMs: number) => Promise<string>;
} {
  const calls: ProbedCall[] = [];
  let announce: ((reason: string) => void) | undefined;
  const cancelled = new Promise<string>((resolve) => { announce = resolve; });
  const observe = (options?: { signal?: AbortSignal }): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      const signal = options?.signal;
      calls.push({ signal, abortedAtCall: signal?.aborted ?? false });
      signal?.addEventListener('abort', () => {
        const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
        announce?.(reason);
        reject(new Error(reason));
      });
    });
  const sdk = {
    clash: {
      run: (_elements: unknown, _rules: unknown, options?: { signal?: AbortSignal }) => observe(options),
      // `matrix` is the second async method on this namespace, threaded by the
      // same one-line change — and a sibling copy left behind is the defect
      // shape this repo keeps meeting.
      matrix: (_elements: unknown, options?: { signal?: AbortSignal }) => observe(options),
    },
  } as unknown as BimContext;
  return {
    sdk,
    calls,
    cancelReason: (withinMs) => within(withinMs, cancelled, NEVER_SETTLED),
  };
}

describe('#2419 — HostWorkQueue cancellation state', () => {
  it('does not hand out a live signal again once disposed', () => {
    // `dispose()` deliberately does not install a replacement controller, so a
    // call arriving after teardown sees an aborted signal. But a dispose that
    // lands while a run is parked in `settle()` wakes that wait, and
    // `settleHostWork` calls `abandonInFlight()` on its way out — which would
    // otherwise put a fresh, live controller on an already-disposed queue.
    const queue = new HostWorkQueue();
    queue.dispose();
    queue.abandonInFlight();
    expect(queue.signal.aborted).toBe(true);
    expect((queue.signal.reason as Error).message).toBe('the sandbox was disposed');
  });

  it('hands out a live signal again after a run merely times out', () => {
    // The control: outside disposal, abandoning IS followed by a fresh
    // controller, or every later run on the sandbox starts cancelled.
    const queue = new HostWorkQueue();
    const first = queue.signal;
    queue.abandonInFlight();
    expect(first.aborted).toBe(true);
    expect(queue.signal.aborted).toBe(false);
    queue.dispose();
  });
});

describe('#2419 — a timed-out or disposed run cancels its host work', () => {
  it('aborts the in-flight call when the run stops waiting for it', async () => {
    // #2387 made the run stop *waiting*; the clash engine kept computing to
    // completion in the background on a model the user had already moved on
    // from. Un-awaited is not cancelled.
    const probe = cancelProbe();
    const isolated = await createSandbox(probe.sdk, { limits: { timeoutMs: 300 } });
    try {
      await expect(isolated.eval(STALL_SCRIPT)).rejects.toThrow('interrupted');
      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0].signal).toBeInstanceOf(AbortSignal);
      expect(await probe.cancelReason(500)).toBe('the script run stopped waiting for this call');
      // Tearing down with a cancelled deferred outstanding must not abort the
      // module. Asserted here rather than in the `finally`: an assertion that
      // throws during unwinding replaces whatever failed first, and the
      // original failure is the one worth reading.
      expect(() => isolated.dispose()).not.toThrow();
    } finally {
      // Idempotent, so this only frees the realm when the body threw first.
      isolated.dispose();
    }
  });

  it('aborts an in-flight bim.clash.matrix on the same terms', async () => {
    const probe = cancelProbe();
    const isolated = await createSandbox(probe.sdk, { limits: { timeoutMs: 300 } });
    try {
      const script = `
        const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
        (async () => { await bim.clash.matrix(elements, {}); })();
      `;
      await expect(isolated.eval(script)).rejects.toThrow('interrupted');
      expect(probe.calls).toHaveLength(1);
      expect(await probe.cancelReason(500)).toBe('the script run stopped waiting for this call');
    } finally {
      isolated.dispose();
    }
  });

  it('aborts the in-flight call when the sandbox is disposed mid-run', async () => {
    const probe = cancelProbe();
    const isolated = await createSandbox(probe.sdk, { limits: { timeoutMs: 10_000 } });
    // The disposal here is the subject, not the cleanup — but it is also the
    // only thing that frees this realm, so a failing assertion before it would
    // leak a QuickJS sandbox into the rest of the suite. `dispose()` is
    // idempotent (each field is cleared before the step that frees it, so a
    // step that throws is never retried), so the guarantee below is the same
    // call as the assertion inside and only does work if the test threw first.
    try {
      const pending = isolated.eval(STALL_SCRIPT).catch((err: unknown) => err);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(() => isolated.dispose()).not.toThrow();
      expect(await probe.cancelReason(500)).toBe('the sandbox was disposed');

      const settled = await pending;
      expect((settled as Error).message).toContain('Sandbox disposed');
      // Cancelling must not orphan the deferred it settles: an unfreed resolver
      // handle makes `JS_FreeRuntime` abort the shared module for the rest of
      // the process (#1922), and a fresh sandbox still working is the only real
      // oracle for that.
      expect(isSandboxRuntimeAborted()).toBe(false);
      const fresh = await createSandbox(sdkWithClash());
      try {
        expect((await fresh.eval('1 + 1')).value).toBe(2);
      } finally {
        fresh.dispose();
      }
    } finally {
      isolated.dispose();
    }
  });

  it('hands the next run on the same sandbox a signal that is not already aborted', async () => {
    // The queue is sandbox-scoped and the extension host keeps one sandbox
    // across many evals, so cancelling one run must not pre-cancel every later
    // one — an already-aborted signal would make every subsequent clash call
    // refuse to start.
    const probe = cancelProbe();
    // Both runs share one realm, so the declarations have to be block-scoped —
    // a second top-level `const elements` is a redeclaration, not a stall.
    // Built before the sandbox exists, so nothing sits between creating a realm
    // and the `try` that guarantees it is freed.
    const repeatable = `(() => { ${STALL_SCRIPT} })();`;
    const isolated = await createSandbox(probe.sdk, { limits: { timeoutMs: 300 } });
    try {
      await expect(isolated.eval(repeatable)).rejects.toThrow('interrupted');
      await expect(isolated.eval(repeatable)).rejects.toThrow('interrupted');
      expect(probe.calls.map((call) => call.abortedAtCall)).toEqual([false, false]);
      expect(probe.calls[1].signal).not.toBe(probe.calls[0].signal);
    } finally {
      isolated.dispose();
    }
  });

  it('delivers the cancellation to the script as a catchable bim.clash.run error', async () => {
    // The guest promise must SETTLE, not be stranded: an unsettled one is the
    // never-delivered failure #2305 exists to remove. The first run is over by
    // the time the rejection lands, so the second run is what observes it —
    // its `await` resumes only after the queued reaction job has run.
    const probe = cancelProbe();
    const isolated = await createSandbox(probe.sdk, { limits: { timeoutMs: 300 } });
    try {
      await expect(isolated.eval(`
        const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
        globalThis.observed = '${NEVER_SETTLED}';
        bim.clash.run(elements, ${JSON.stringify(RULES)}, {}).then(
          () => { globalThis.observed = 'resolved'; },
          (err) => { globalThis.observed = err.message; },
        );
      `)).rejects.toThrow('interrupted');

      const seen = await isolated.eval('(async () => { await 0; return globalThis.observed; })();');
      expect(seen.value).toEqual({
        type: 'fulfilled',
        value: 'bim.clash.run: the script run stopped waiting for this call',
      });
    } finally {
      isolated.dispose();
    }
  });
});

/** One `sdk.clash.run` against the REAL engine, timed from call to settle. */
interface TimedRun {
  ms: number;
  outcome: string;
  /**
   * The rejection's `name`, captured on the HOST side of the boundary. The
   * bridge deliberately flattens a rejection to a plain `Error` with a string
   * message for the realm (a non-plain object thrown across the QuickJS native
   * callback corrupts it), so `AbortError` is only observable out here — and
   * `name` is what every engine consumer discriminates on.
   */
  name: string;
  total: number;
}

/**
 * The real `ClashNamespace`, wrapped only to time its promise and record how it
 * settled. The engine, the bridge, the realm and the signal are all real.
 */
function timedClashSdk(): {
  sdk: BimContext;
  signals: (AbortSignal | undefined)[];
  settled: (withinMs: number) => Promise<TimedRun>;
} {
  const real = new ClashNamespace();
  const signals: (AbortSignal | undefined)[] = [];
  let announce: ((run: TimedRun) => void) | undefined;
  const done = new Promise<TimedRun>((resolve) => { announce = resolve; });
  const sdk = {
    clash: {
      run: (elements: never, rules: never, options: never) => {
        signals.push((options as { signal?: AbortSignal } | undefined)?.signal);
        const started = Date.now();
        const promise = real.run(elements, rules, options);
        void promise.then(
          (result) => announce?.({
            ms: Date.now() - started,
            outcome: 'completed',
            name: '',
            total: result.summary.total,
          }),
          (err: unknown) => announce?.({
            ms: Date.now() - started,
            outcome: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : typeof err,
            total: -1,
          }),
        );
        return promise;
      },
    },
  } as unknown as BimContext;
  return {
    sdk,
    signals,
    settled: (withinMs) => within(withinMs, done, { ms: -1, outcome: NEVER_SETTLED, name: '', total: -1 }),
  };
}

/**
 * Builds the elements inside the realm rather than inlining them as JSON, so
 * the workload can be large enough to interrupt without a 150 KB script.
 * 64 walls x 64 slabs, all overlapping: 4096 candidate pairs.
 */
const WORKLOAD_SCRIPT = `
  const elements = [];
  for (let i = 0; i < 128; i += 1) {
    const x = i * 0.001;
    elements.push({
      key: 'k' + i, ref: i + 1, model: 'm', tag: i % 2 === 0 ? 'IfcWall' : 'IfcSlab',
      bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] },
      positions: [
        x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0,
        x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1,
      ],
      indices: [
        0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
        2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 3, 7, 0, 7, 4,
      ],
    });
  }
  (async () => { await bim.clash.run(elements, ${JSON.stringify(RULES)}, {}); })();
`;

/**
 * The run's deadline cannot be shorter than this and still land after the
 * script has finished building its elements — a run cut short before it ever
 * reaches `bim.clash.run` would prove nothing.
 */
const DEADLINE_FLOOR_MS = 120;

/**
 * A workload only qualifies if a QUARTER of it clears that floor. Otherwise the
 * floor, not the derived fraction, sets the deadline, and it lands so late in
 * the run that the `< 0.75 * naturalMs` cancellation assertion has no margin
 * left — the test would be measuring the floor rather than the cancellation.
 * Requiring the fraction to win keeps the deadline a real quarter of the run
 * and the assertion a real comparison.
 *
 * A host fast enough to fall below this skips with a stated reason. The
 * engine-level cancellation tests in `@ifc-lite/clash` are deterministic and
 * carry that half regardless; this suite is the integration check on top.
 */
const MEASURABLE_MS = DEADLINE_FLOOR_MS * 4;

describe('#2419 — the real clash engine stops when the run does', () => {
  it('leaves a run that completes normally untouched', async () => {
    const probe = timedClashSdk();
    const isolated = await createSandbox(probe.sdk, { limits: { timeoutMs: 30_000 } });
    try {
      const script = `
        const elements = ${JSON.stringify([cube('a', 0, 'IfcWall'), cube('b', 0.5, 'IfcSlab')])};
        (async () => {
          const result = await bim.clash.run(elements, ${JSON.stringify(RULES)}, {});
          return { clashes: result.clashes.length, total: result.summary.total };
        })();
      `;
      const result = await isolated.eval(script);
      // Byte-for-byte the pre-existing expectation: threading a signal must not
      // change a single delivered value.
      expect(result.value).toEqual({ type: 'fulfilled', value: { clashes: 1, total: 1 } });
      const run = await probe.settled(1_000);
      expect(run.outcome).toBe('completed');
      // The seam is live on the happy path too — a live, un-aborted signal
      // reached the engine and nothing cancelled it.
      expect(probe.signals[0]).toBeInstanceOf(AbortSignal);
      expect(probe.signals[0]?.aborted).toBe(false);
      await flushRejections();
      expect(unhandled).toEqual([]);
    } finally {
      isolated.dispose();
    }
  }, 30_000);

  it('stops the engine mid-run rather than letting it finish unobserved', async (ctx) => {
    // The whole point of the issue: on timeout the engine used to keep
    // intersecting triangles to completion for a result nobody would read.
    const complete = timedClashSdk();
    let naturalMs: number;
    const generous = await createSandbox(complete.sdk, { limits: { timeoutMs: 60_000 } });
    try {
      await generous.eval(WORKLOAD_SCRIPT);
      const run = await complete.settled(60_000);
      expect(run.outcome).toBe('completed');
      expect(run.total).toBeGreaterThan(0);
      naturalMs = run.ms;
    } finally {
      generous.dispose();
    }
    if (naturalMs <= MEASURABLE_MS) {
      ctx.skip(`workload ran in ${naturalMs}ms on this host — too fast to place a deadline inside it`);
      return;
    }
    // Every bound below is derived from that measured cost, so the margins hold
    // on a slow CI box and a fast laptop alike. Past the gate above the
    // fraction always wins, so the floor is a guard, not the value in use.
    const deadlineMs = Math.max(DEADLINE_FLOOR_MS, Math.round(naturalMs / 4));

    const cancelled = timedClashSdk();
    const isolated = await createSandbox(cancelled.sdk, { limits: { timeoutMs: deadlineMs } });
    try {
      await expect(isolated.eval(WORKLOAD_SCRIPT)).rejects.toThrow('interrupted');
      const run = await cancelled.settled(Math.max(naturalMs * 2, 300));
      // The contract, not a proxy for it: the engine rejected with a real
      // `AbortError`, and it did so well before it would have finished.
      expect(run.name).toBe('AbortError');
      expect(run.outcome).toContain('aborted');
      expect(run.ms).toBeLessThan(naturalMs * 0.75);
    } finally {
      isolated.dispose();
    }
  }, 120_000);
});
