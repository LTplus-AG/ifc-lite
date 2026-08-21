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

let execute1: ((code: string) => Promise<ScriptResult | null>) | null = null;
let reset1: (() => void) | null = null;
let execute2: ((code: string) => Promise<ScriptResult | null>) | null = null;

/** Two INDEPENDENT `useSandbox()` instances — the real ScriptPanel/ChatPanel shape. */
function ProbePair() {
  ({ execute: execute1, reset: reset1 } = useSandbox(CONFIG));
  ({ execute: execute2 } = useSandbox(CONFIG));
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
  assert.ok(execute1 && execute2 && reset1, 'the probe pair must have mounted and exposed both hooks');
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
    // `scriptExecutionState` is deliberately NOT asserted here. `reset()` ends
    // with `setExecutionState('idle')` → `setResult(null)` → `setError(null)`,
    // and `setScriptResult` sets `scriptExecutionState: 'success'`
    // unconditionally (scriptSlice.ts) — so `reset()` has never left the state
    // at `'idle'`, with or without this guard. That ordering defect is real but
    // is not this change's, and pinning either value here would either assert a
    // bug or fail for a reason unrelated to run supersession.
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
});
