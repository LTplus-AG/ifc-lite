/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-instance run-supersession guard for `useSandbox().execute()`.
 *
 * `useSandbox()` is instantiated independently in `ScriptPanel`, `ChatPanel`,
 * `CommandPalette` and `ExecutableCodeBlock` — each call gets its own
 * `activeSandboxRef`/closure, with nothing shared between instances. Every
 * instance still publishes to the SAME store fields
 * (`scriptLastResult`/`scriptLastError`/`scriptExecutionState`) via
 * `setScriptResult`/`setScriptError`, which apply unconditionally. Nothing
 * stopped an OLDER run (started from one instance) from publishing over a
 * NEWER run's already-displayed result (started from a different instance)
 * merely because the older one happened to settle later — e.g. a Script
 * Console run racing a `ChatPanel` auto-executed code block.
 * `useClash`/`useIDS`/`useCompare` guard the equivalent race with a per-hook
 * `runEpochRef`, but that shape cannot work here: each `useSandbox()` instance
 * has its OWN ref, so instance B's epoch never compares against instance A's
 * — they are unrelated counters. The fix (`scriptSlice.ts`'s
 * `scriptRunEpoch`) lives in the store instead, so every instance
 * reads/writes the same counter.
 *
 * **Two concerns, two epochs.** The store epoch gates only the SHARED-STORE
 * write. Collapsing "my store write is stale" and "my own script failed" into
 * one signal would itself be a bug: a slow, UNRELATED chat code block would
 * render a false error the instant a quick, separate script ran anywhere else
 * in the app (`ExecutableCodeBlock.handleRun` and `ChatPanel`'s auto-execute
 * both treat `execute()` returning `null` as "this script failed"). So
 * `execute()`'s RETURN VALUE is gated by a separate, per-instance
 * `runEpochRef` inside `useSandbox()` — only this SAME instance's own newer
 * call, or its own `reset()`, can make its own earlier call resolve `null`.
 *
 * **SETTLE ORDER IS THE PROPERTY, SO THE FIXTURE OWNS IT.** The clobber half
 * of this story only exists when the older run settles LAST — an older run
 * that settles first cannot overwrite anything, so a test where it does is
 * asserting nothing. Slowness cannot be approximated with a CPU busy loop
 * here: QuickJS is synchronous and single-threaded, so a script burning
 * millions of iterations settles its own run BEFORE a "fast" run started
 * after it has even created its sandbox — exactly backwards. The order is
 * therefore made a property of the fixture: instance A's script parks on a
 * HOST promise (`bim.clash.run`, the #2305 host-promise bridge) that this
 * file resolves by hand, and `Sandbox.runEval`'s `settleHostWork()` cannot
 * finish A's run until it does. Every test below asserts the realised settle
 * order explicitly, so a change that quietly reorders them fails loudly
 * rather than passing vacuously.
 */

import '@/test/setup-dom.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BimContext } from '@ifc-lite/sdk';
import type { ScriptResult, SandboxConfig } from '@ifc-lite/sandbox';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { useViewerStore } from '@/store';
import { SANDBOX_ABORT_MESSAGE } from '@/lib/sandboxAbort.js';
import { useSandbox } from './useSandbox.js';

const CONFIG: SandboxConfig = { limits: { memoryBytes: 64 * 1024 * 1024, timeoutMs: 10_000 } };

/**
 * Resolvers for every in-flight `bim.clash.run(...)` the guest has issued, in
 * call order. The bridge delivers a host promise into the realm (#2305) and
 * `settleHostWork()` alternates the host and guest queues until the host has
 * no work left, so a script awaiting one of these cannot complete — and its
 * `execute()` cannot settle — until this file resolves it.
 */
let gates: Array<(value: unknown) => void> = [];

const bim = {
  clash: {
    run: () => new Promise((resolve) => { gates.push(resolve); }),
  },
} as unknown as BimContext;

/**
 * Parks on a host gate, then reports the value the host handed back.
 *
 * `out` is the eval's completion value, but `vm.dump` reads it only AFTER
 * `settleHostWork()`, so `out.v` carries what the gate resolved with. That
 * makes the returned value itself proof the run really went through the gate
 * rather than short-circuiting past it. Top-level `await` is not available in
 * the realm — hence the fire-and-forget async IIFE, the same shape #1922's
 * reproducer uses.
 */
const GATED = 'const out = {}; (async () => { const r = await bim.clash.run([], []); out.v = r.marker; })(); out';
const UNGATED = '"B-result"';

/**
 * The #1922 reproducer, parked behind the same host gate.
 *
 * `eval()` still resolves normally — the OOM happens in a *drained promise
 * job*, so the run reports success and only `dispose()` reports the damage —
 * which is what puts this on `execute()`'s SUCCESS path: the teardown that
 * settles the run before it is reported (`useSandbox.ts`'s `teardown()` call
 * above the success publish) is the one that aborts, and the `finally`'s
 * teardown is then a no-op. The gate is what lets a second instance's run
 * start, finish and publish while this one is still in flight.
 */
const GATED_OOM_AT_TEARDOWN =
  'const out = {}; (async () => { const r = await bim.clash.run([], []); out.v = r.marker; const a = []; for (;;) { a.push({ k: "v" }); } })(); out';

/**
 * The same abort, but on a run whose `eval()` also THROWS.
 *
 * The synchronous `throw` rejects `eval()`, so the success-path teardown never
 * runs and the abort surfaces from the `finally`'s teardown instead — the
 * other of the two teardown-abort publishes. The control test below pins that
 * routing: the store's error must end up as the ABORT message, not
 * `late-boom`, which can only happen if the `finally` publish ran after the
 * catch block's `setError`.
 */
const GATED_OOM_AT_TEARDOWN_AFTER_THROW =
  'const out = {}; (async () => { await bim.clash.run([], []); const a = []; for (;;) { a.push({ k: "v" }); } })(); out; throw new Error("late-boom")';

/**
 * A heap small enough that the reproducer above trips in tens of
 * milliseconds. The default 64 MiB would take seconds to fill.
 */
const SMALL_HEAP: SandboxConfig = { limits: { memoryBytes: 4 * 1024 * 1024, timeoutMs: 10_000 } };

let execute1: ((code: string) => Promise<ScriptResult | null>) | null = null;
let reset1: (() => void) | null = null;
let execute2: ((code: string) => Promise<ScriptResult | null>) | null = null;
let executeOom: ((code: string) => Promise<ScriptResult | null>) | null = null;

/**
 * INDEPENDENT `useSandbox()` instances — the real ScriptPanel/ChatPanel shape.
 *
 * The third differs from the first two only in its heap limit; it is the one
 * that runs the #1922 reproducer, and it is a separate instance for the same
 * reason the other two are: the runs that must supersede each other have to
 * come from different hooks, or the per-instance `runEpochRef` alone would
 * explain the outcome and the shared store epoch would go untested.
 */
function ProbePair() {
  ({ execute: execute1, reset: reset1 } = useSandbox(CONFIG));
  ({ execute: execute2 } = useSandbox(CONFIG));
  ({ execute: executeOom } = useSandbox(SMALL_HEAP));
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

before(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <BimReactContext.Provider value={bim}>
        <ProbePair />
      </BimReactContext.Provider>,
    );
  });
  assert.ok(execute1 && execute2 && reset1 && executeOom, 'the probe pair must have mounted and exposed every hook');
});

beforeEach(() => {
  gates = [];
  useViewerStore.setState({
    scriptLastResult: null,
    scriptLastError: null,
    scriptLastDiagnostics: [],
    scriptExecutionState: 'idle',
  });
});

after(() => {
  act(() => root?.unmount());
  container?.remove();
});

/** Let the host microtask/timer queues turn so a parked run can make progress. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('useSandbox().execute() — cross-instance run supersession', () => {
  it('lets instance B settle FIRST and instance A settle LAST, by fixture and not by timing', async () => {
    const settleOrder: string[] = [];
    let rA: ScriptResult | null | undefined;
    let rB: ScriptResult | null | undefined;
    const seqBefore = useViewerStore.getState().scriptRunSeq;

    await act(async () => {
      // No `await` between these two calls: both run their synchronous
      // prefix (including the epoch bump) back-to-back, so A is the older
      // run and B the newer one.
      const pA = execute1!(GATED).then((r) => { settleOrder.push('A'); rA = r; });
      const pB = execute2!(UNGATED).then((r) => { settleOrder.push('B'); rB = r; });

      // B has nothing to park on, so it settles on its own. A is parked on a
      // gate that only this file can open, so it CANNOT have settled yet —
      // that is what the assertion below pins.
      await pB;
      assert.deepEqual(
        settleOrder,
        ['B'],
        'the older run A must still be in flight when the newer run B settles — without that ordering there is no clobber to guard against and this whole test is vacuous',
      );
      assert.equal(gates.length, 1, 'instance A must be parked on exactly one host gate');

      gates[0]!({ marker: 'A-result' });
      await pA;
    });

    assert.deepEqual(
      settleOrder,
      ['B', 'A'],
      'the older run A must settle AFTER the newer run B — the fixture, not the CPU, decides this',
    );

    // Half 1 — the false-error half. Instance A's own script genuinely ran to
    // completion, gate value and all. A completely unrelated instance (B)
    // starting and finishing its own script must not turn A's real success
    // into a fabricated `null` for A's own caller: that is exactly what makes
    // `ExecutableCodeBlock`/`ChatPanel` render an error for a script that
    // succeeded.
    assert.ok(rA, "instance A's own successful run must resolve with its own real result");
    assert.deepEqual(
      (rA as ScriptResult).value,
      { v: 'A-result' },
      "instance A's result must carry the value its own gate resolved with",
    );
    assert.ok(rB, 'the newer (instance B) run must resolve with its result');
    assert.equal((rB as ScriptResult).value, 'B-result');

    // Half 2 — the clobber half. The SHARED store must still show instance
    // B's (genuinely more current) result. A settled last; without the store
    // epoch its `setScriptResult` lands last and silently replaces what the
    // user is already looking at.
    const state = useViewerStore.getState();
    assert.deepEqual(
      state.scriptLastResult?.value,
      'B-result',
      "instance A's late completion must not overwrite instance B's already-current result in the store",
    );
    assert.equal(state.scriptExecutionState, 'success');
    assert.equal(
      state.scriptLastError,
      null,
      "a superseded run must not write an error over the current run's clean state either",
    );
    assert.equal(
      useViewerStore.getState().scriptRunSeq,
      seqBefore + 1,
      'only the run that actually became the document state may advance the run gate — the superseded run must not count',
    );
  });

  it('does not gate a run that nothing supersedes', async () => {
    // The counter-example to the test above: same fixture, same gate, same
    // late settle — but no second instance running. Every store write must
    // land. A guard that swallowed this one would pass every assertion above
    // while breaking the ordinary single-run path.
    let r: ScriptResult | null | undefined;
    const seqBefore = useViewerStore.getState().scriptRunSeq;

    await act(async () => {
      const p = execute1!(GATED).then((x) => { r = x; });
      await tick();
      assert.equal(gates.length, 1, 'the lone run must be parked on its gate');
      gates[0]!({ marker: 'lone-result' });
      await p;
    });

    assert.ok(r, 'an unsuperseded run must resolve with its result');
    assert.deepEqual((r as ScriptResult).value, { v: 'lone-result' });
    const state = useViewerStore.getState();
    assert.deepEqual(state.scriptLastResult?.value, { v: 'lone-result' }, 'an unsuperseded run must publish to the store');
    assert.equal(state.scriptExecutionState, 'success');
    assert.equal(state.scriptLastError, null);
    assert.equal(
      useViewerStore.getState().scriptRunSeq,
      seqBefore + 1,
      'an unsuperseded successful run must still advance the run gate',
    );
  });

  it('lets an unsuperseded run that fails still report its error', async () => {
    // The error path is gated by the same epoch. For a run nothing
    // supersedes, the error must reach the store and the caller must still
    // get `null`.
    let r: ScriptResult | null | undefined;
    await act(async () => {
      r = await execute1!('throw new Error("boom")');
    });

    assert.equal(r, null, 'a failing run must resolve null');
    const state = useViewerStore.getState();
    assert.match(
      state.scriptLastError ?? '',
      /boom/,
      "an unsuperseded run's error must still reach the store",
    );
    assert.equal(state.scriptExecutionState, 'error');
  });

  it('does not let a superseded run publish its error over the newer run', async () => {
    // Same shape as the headline test, but A FAILS instead of succeeding.
    // Without the epoch on the error path, A's late `setScriptError` flips
    // the store to 'error' for a run the user is no longer looking at.
    const settleOrder: string[] = [];
    let rA: ScriptResult | null | undefined;

    await act(async () => {
      const pA = execute1!(
        'const out = {}; (async () => { await bim.clash.run([], []); })(); out; throw new Error("late-boom")',
      ).then((r) => { settleOrder.push('A'); rA = r; });
      const pB = execute2!(UNGATED).then(() => { settleOrder.push('B'); });
      await pB;
      assert.deepEqual(settleOrder, ['B'], 'A must still be parked when B settles');
      assert.equal(gates.length, 1, 'A must be parked on its host gate');
      gates[0]!({ marker: 'unused' });
      await pA;
    });

    assert.deepEqual(settleOrder, ['B', 'A'], 'the failing run A must settle after B');
    assert.equal(rA, null, 'a run that threw must resolve null to its own caller');
    const state = useViewerStore.getState();
    assert.equal(
      state.scriptLastError,
      null,
      "a superseded run's error must not be published over the newer run's result",
    );
    assert.deepEqual(
      state.scriptLastResult?.value,
      'B-result',
      "the newer run's result must survive the superseded run's failure",
    );
    assert.equal(state.scriptExecutionState, 'success');
  });

  it('reset() on instance A bumps both epochs, so its own in-flight run cannot resurrect after the reset', async () => {
    let rA: ScriptResult | null | undefined;
    await act(async () => {
      const pA = execute1!(GATED).then((r) => { rA = r; });
      await tick();
      assert.equal(gates.length, 1, "instance A's run must be in flight when reset() fires");
      reset1!();
      gates[0]!({ marker: 'stale' });
      await pA;
    });

    assert.equal(rA, null, "a run superseded by its own instance's reset() must resolve null");
    const state = useViewerStore.getState();
    assert.equal(state.scriptLastResult, null, "reset()'s clear must not be resurrected by the stale run");
    assert.equal(state.scriptLastError, null, "reset()'s clear must not be resurrected by the stale run");
    assert.equal(
      state.scriptExecutionState,
      'idle',
      "reset() must leave the state it cleared coherent — 'success' with no result and no error is a state no consumer can render",
    );
  });

  it('captures the epoch synchronously, before the first await, so a reset() landing in that window still supersedes the run', async () => {
    // WHERE the epoch is captured is load-bearing, not just WHETHER. Capturing
    // it after `await import('@ifc-lite/sandbox')` (or after `createSandbox`)
    // reads a counter a `reset()` has already bumped, so the run captures the
    // POST-reset value, believes it is current, and republishes over the state
    // reset() just cleared. The test above cannot see that: it has to let the
    // run reach its gate before resetting, by which point a
    // capture-after-await has already happened. Here `reset()` fires
    // synchronously, in the same turn as `execute()`, before any await —
    // exactly the window a late capture would miss.
    let rA: ScriptResult | null | undefined;
    await act(async () => {
      const pA = execute1!(GATED).then((r) => { rA = r; });
      reset1!();
      await tick();
      assert.equal(gates.length, 1, 'the superseded run still runs to its gate — reset() only bumps the epoch here, it has no sandbox to dispose yet');
      gates[0]!({ marker: 'stale' });
      await pA;
    });

    assert.equal(rA, null, "a run reset() superseded before its first await must resolve null");
    const state = useViewerStore.getState();
    assert.equal(state.scriptLastResult, null, "the run must not publish over what reset() cleared");
    assert.equal(state.scriptLastError, null, "the run must not publish an error over what reset() cleared");
  });

  it("a second execute() on the SAME instance makes the first resolve null to its own caller", async () => {
    // The per-instance half, distinct from the cross-instance one above: this
    // instance itself started a newer run, so its own earlier call really did
    // lose, and its caller must be told so.
    const settleOrder: string[] = [];
    let rFirst: ScriptResult | null | undefined;
    let rSecond: ScriptResult | null | undefined;

    await act(async () => {
      const pFirst = execute1!(GATED).then((r) => { settleOrder.push('first'); rFirst = r; });
      const pSecond = execute1!(UNGATED).then((r) => { settleOrder.push('second'); rSecond = r; });
      await pSecond;
      assert.deepEqual(settleOrder, ['second'], 'the first run must still be parked when the second settles');
      assert.equal(gates.length, 1, 'the first run must be parked on its host gate');
      gates[0]!({ marker: 'superseded' });
      await pFirst;
    });

    assert.deepEqual(settleOrder, ['second', 'first'], 'the first run must settle last');
    assert.equal(
      rFirst,
      null,
      "a run this same instance superseded with its own newer execute() must resolve null — unlike a DIFFERENT instance's run, this one genuinely lost",
    );
    assert.ok(rSecond, 'the newer run on the same instance must resolve with its result');
    assert.equal((rSecond as ScriptResult).value, 'B-result');
    assert.deepEqual(useViewerStore.getState().scriptLastResult?.value, 'B-result');
  });

  it("reset() on instance A leaves a coherent state while a DIFFERENT instance's run is in flight", async () => {
    // The cross-instance half of the reset story, which the same-instance test
    // above cannot reach. `reset()` bumps the SHARED epoch, so instance B's
    // in-flight run — which instance A knows nothing about — is superseded and
    // skips its store write. Whatever `reset()` left behind is therefore
    // FINAL: nothing lands after it to correct it. `setScriptResult(null)`
    // used to report that cleared state as `'success'`, so the store came to
    // rest permanently claiming a successful run with no result and no error,
    // while `execute()` handed B's own caller the real result — two answers
    // with nothing left to reconcile them.
    let rB: ScriptResult | null | undefined;

    await act(async () => {
      const pB = execute2!(GATED).then((r) => { rB = r; });
      await tick();
      assert.equal(gates.length, 1, "instance B's run must be in flight when instance A resets");
      reset1!();
      gates[0]!({ marker: 'B-result' });
      await pB;
    });

    // B's own caller still gets B's real outcome: an unrelated instance's
    // reset is not evidence that B's script failed (the `runEpochRef` half).
    assert.ok(rB, "a DIFFERENT instance's reset() must not fabricate a failure for B's own caller");
    assert.deepEqual((rB as ScriptResult).value, { v: 'B-result' });

    const state = useViewerStore.getState();
    assert.equal(state.scriptLastResult, null, "the superseded run must not resurrect what reset() cleared");
    assert.equal(state.scriptLastError, null, "the superseded run must not write an error over what reset() cleared");
    assert.equal(
      state.scriptExecutionState,
      'idle',
      "the state reset() comes to rest in must be coherent with the result it cleared — a terminal 'success' with a null result and a null error describes a run that never happened",
    );
  });

  // ---------------------------------------------------------------------
  // The #1922 teardown-abort publishes. These run LAST on purpose: each one
  // aborts a real QuickJS WASM module. The package retires the aborted module
  // and builds the next sandbox on a fresh one, so a later run still works —
  // but emscripten latches `ABORT` per module instance, so keeping the healthy
  // tests ahead of them costs nothing and removes the question entirely.
  // ---------------------------------------------------------------------

  it('publishes a teardown abort for an unsuperseded run (success-path teardown)', async () => {
    // The control for the test below, and the proof that the fixture really
    // produces a #1922 abort rather than some ordinary failure: nothing
    // supersedes this run, so the abort MUST reach the store.
    let r: ScriptResult | null | undefined;
    await act(async () => {
      const p = executeOom!(GATED_OOM_AT_TEARDOWN).then((x) => { r = x; });
      await tick();
      assert.equal(gates.length, 1, 'the reproducer must be parked on its host gate');
      gates[0]!({ marker: 'A-result' });
      await p;
    });

    assert.equal(r, null, 'a run the teardown abort proves died must resolve null');
    const state = useViewerStore.getState();
    assert.equal(
      state.scriptLastError,
      SANDBOX_ABORT_MESSAGE,
      'the reproducer must actually produce a teardown abort — without this the superseded test below could pass vacuously',
    );
    assert.equal(state.scriptExecutionState, 'error');
    assert.ok(state.scriptLastResult, 'the abort publish keeps the captured logs');
    assert.equal(
      (state.scriptLastResult as ScriptResult).value,
      undefined,
      'the abort publish must not keep the value — it is a lie about a dead run',
    );
  });

  it('does not publish a superseded run\'s teardown abort (success-path teardown)', async () => {
    // Same reproducer, now superseded by a newer run from a DIFFERENT
    // instance that settles first. The abort is a real failure of THIS run,
    // but it is no longer the document's current story: publishing it would
    // replace a newer, already-displayed result with an error about a run the
    // user has moved on from.
    const settleOrder: string[] = [];
    let rA: ScriptResult | null | undefined;

    await act(async () => {
      const pA = executeOom!(GATED_OOM_AT_TEARDOWN).then((r) => { settleOrder.push('A'); rA = r; });
      const pB = execute2!(UNGATED).then(() => { settleOrder.push('B'); });
      await pB;
      assert.deepEqual(settleOrder, ['B'], 'the aborting run must still be parked when the newer run settles');
      assert.equal(gates.length, 1, 'the aborting run must be parked on its host gate');
      gates[0]!({ marker: 'A-result' });
      await pA;
    });

    assert.deepEqual(settleOrder, ['B', 'A'], 'the aborting run must settle LAST — otherwise there is nothing for it to clobber');
    assert.equal(rA, null, 'a run that died at teardown resolves null to its own caller regardless of either epoch');
    const state = useViewerStore.getState();
    assert.equal(
      state.scriptLastError,
      null,
      "a superseded run's teardown abort must not be published over the newer run's clean state",
    );
    assert.deepEqual(
      state.scriptLastResult?.value,
      'B-result',
      "the newer run's result must survive the superseded run's teardown abort",
    );
    assert.equal(state.scriptExecutionState, 'success');
  });

  it('publishes a teardown abort for an unsuperseded run that also threw (finally teardown)', async () => {
    // The other teardown-abort publish. `eval()` REJECTS here, so the
    // success-path teardown never runs and the abort can only come from the
    // `finally`. The error assertion is what pins that routing: the catch
    // block has already called `setError('late-boom')`, so the store reading
    // back as the ABORT message proves the `finally` publish ran after it.
    let r: ScriptResult | null | undefined;
    await act(async () => {
      const p = executeOom!(GATED_OOM_AT_TEARDOWN_AFTER_THROW).then((x) => { r = x; });
      await tick();
      assert.equal(gates.length, 1, 'the reproducer must be parked on its host gate');
      gates[0]!({ marker: 'unused' });
      await p;
    });

    assert.equal(r, null, 'a run that threw must resolve null');
    const state = useViewerStore.getState();
    assert.equal(
      state.scriptLastError,
      SANDBOX_ABORT_MESSAGE,
      "the finally's teardown abort must be published, and must replace the ordinary script error the catch block reported",
    );
    assert.equal(state.scriptExecutionState, 'error');
  });

  it('does not publish a superseded run\'s teardown abort (finally teardown)', async () => {
    const settleOrder: string[] = [];
    let rA: ScriptResult | null | undefined;

    await act(async () => {
      const pA = executeOom!(GATED_OOM_AT_TEARDOWN_AFTER_THROW).then((r) => { settleOrder.push('A'); rA = r; });
      const pB = execute2!(UNGATED).then(() => { settleOrder.push('B'); });
      await pB;
      assert.deepEqual(settleOrder, ['B'], 'the aborting run must still be parked when the newer run settles');
      assert.equal(gates.length, 1, 'the aborting run must be parked on its host gate');
      gates[0]!({ marker: 'unused' });
      await pA;
    });

    assert.deepEqual(settleOrder, ['B', 'A'], 'the aborting run must settle LAST');
    assert.equal(rA, null, 'a run that threw resolves null to its own caller');
    const state = useViewerStore.getState();
    assert.equal(
      state.scriptLastError,
      null,
      "the finally's teardown-abort publish must be gated too — a superseded run's abort must not land over the newer run's result",
    );
    assert.deepEqual(
      state.scriptLastResult?.value,
      'B-result',
      "the newer run's result must survive the superseded run's finally-path abort",
    );
    assert.equal(state.scriptExecutionState, 'success');
  });
});
