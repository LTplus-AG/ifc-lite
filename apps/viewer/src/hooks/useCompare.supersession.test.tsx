/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Supersession races on the compare path (issue #2802 sweep).
 *
 * `compareSlice` has no guard of its own - by design, it is "deliberately
 * dumb" and orchestration lives entirely in `useCompare`. The only staleness
 * check that hook has is `isCurrentFor` / `buildAtCurrentVersion`, and that
 * check exists SOLELY to protect the fingerprint CACHE against a federation
 * re-alignment that moves meshes in place. It says nothing about whether a
 * given `runComparison()` call is still the one the user is waiting on.
 *
 * These tests drive the REAL hook (`useCompare`) over real parsed fixtures and
 * demonstrate, by execution, that:
 *
 *   1. Two overlapping `runComparison()` calls for two different A/B pairs -
 *      the older, slower one publishes its answer AFTER a newer one already
 *      finished, clobbering it (`supersedes the newer pair`).
 *   2. `clearCompare()` mid-flight does not stop the in-flight run from
 *      resurrecting the just-cleared result once it resolves.
 *   3. Changing `compareBaseModelId` / `compareHeadModelId` mid-flight (no
 *      second Run click) still publishes the OLD pair's result, and nothing
 *      stops the panel's `compareResult` from disagreeing with the currently
 *      selected pair.
 *   5. A run that fails AFTER a newer run already published a good result
 *      clobbers that result with an error / null.
 *
 * ## The interleaving is real, not simulated
 *
 * As in `useCompare.midRunOptions.test.tsx`, `runComparison()`'s first
 * `await` is a `setTimeout(0)` macrotask, and `buildEntityFingerprints` yields
 * again every 1500 entities via the same mechanism. Starting run A (many
 * entities, so it needs an extra yield) synchronously via `act(() => {...})`
 * before starting run B (few entities, one yield) guarantees B's callback is
 * scheduled and drained before A's continuation gets a second turn - so B
 * really does finish first without any wall-clock timing or fake timers.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { useCompare } from './useCompare.js';

// ─── Fixture ──────────────────────────────────────────────────────────────

function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** `n` distinct walls, one line each, GUIDs derived from the index so they are
 *  valid IFC base64-ish GlobalIds (22 chars) without colliding. */
function wallsBody(n: number, tag: string): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const guid = `${tag}${String(i).padStart(21, '0')}`.slice(0, 22);
    lines.push(`#${i + 1}=IFCWALL('${guid}',$,'Wall ${tag}${i}',$,$,$,$,$,.STANDARD.);`);
  }
  return lines.join('\n');
}

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A model with `n` walls and no meshes (no meshes -> no geometry scope work,
 *  keeps the fixture cheap - the entity SCAN loop in `buildFingerprints.ts`
 *  is what yields every 1500, and it iterates the data store directly). */
function model(id: string, store: IfcDataStore, n: number): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: store,
    geometryResult: { meshes: [] as MeshData[] } as unknown as GeometryResult,
    idOffset: 0,
    maxExpressId: n,
  } as unknown as FederatedModel;
}

// ─── Harness ────────────────────────────────────────────────────────────

let hook: ReturnType<typeof useCompare> | null = null;

function Probe(): null {
  hook = useCompare();
  return null;
}

let root: Root | null = null;

interface Pair {
  baseId: string;
  headId: string;
}

/** Slow pair: 1600 walls a side (>= 2 yields in the scan loop at 1500-entity
 *  boundaries). Fast pair: 2 walls a side (zero extra yields). */
let SLOW: Pair;
let FAST: Pair;

async function seed(): Promise<void> {
  const [slowA, slowB, fastA, fastB] = await Promise.all([
    parse(wallsBody(1600, 'sA')),
    parse(wallsBody(1600, 'sB')),
    parse(wallsBody(2, 'fA')),
    parse(wallsBody(2, 'fB')),
  ]);
  SLOW = { baseId: 'SlowA', headId: 'SlowB' };
  FAST = { baseId: 'FastA', headId: 'FastB' };
  useViewerStore.setState({
    models: new Map([
      ['SlowA', model('SlowA', slowA, 1600)],
      ['SlowB', model('SlowB', slowB, 1600)],
      ['FastA', model('FastA', fastA, 2)],
      ['FastB', model('FastB', fastB, 2)],
    ]),
    compareBaseModelId: SLOW.baseId,
    compareHeadModelId: SLOW.headId,
    compareScope: 'both',
    compareExcludedTypes: [],
    compareResult: null,
    compareError: null,
    compareRunning: false,
    compareRunSeq: 0,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

function setPair(p: Pair): void {
  useViewerStore.setState({ compareBaseModelId: p.baseId, compareHeadModelId: p.headId });
}

beforeEach(async () => {
  hook = null;
  await seed();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

// ─── Scenario 1: slow run started first must not clobber a fast run that
// finished first, for a DIFFERENT pair ───────────────────────────────────

describe('useCompare - supersession (#2802)', () => {
  it('scenario 1: a slow run for pair A does not overwrite a fast run for pair B that finished first', async () => {
    // Start the slow run against SLOW while it is selected.
    let slowPending: Promise<void> | undefined;
    act(() => {
      slowPending = hook!.runComparison();
    });
    assert.strictEqual(useViewerStore.getState().compareResult, null, 'slow run must still be in flight');

    // Switch selection to FAST and start a second run before the slow one's
    // first continuation has a chance to run - no await between the two
    // starts, so the interleaving is forced, not raced for.
    setPair(FAST);
    let fastPending: Promise<void> | undefined;
    act(() => {
      fastPending = hook!.runComparison();
    });

    // Drain both. The fast one (2 walls, no extra yield) resolves on its very
    // first continuation; the slow one (1600 walls) needs extra macrotask
    // turns and resolves after it.
    await act(async () => {
      await fastPending;
    });
    const afterFast = useViewerStore.getState().compareResult;
    assert.ok(afterFast, 'the fast run must have published');
    assert.strictEqual(afterFast!.baseModelId, FAST.baseId);

    await act(async () => {
      await slowPending;
    });
    const afterSlow = useViewerStore.getState().compareResult;
    assert.ok(afterSlow, 'a result must still be present');
    assert.strictEqual(
      afterSlow!.baseModelId,
      FAST.baseId,
      'the slow (older, no-longer-selected) run must not overwrite the fast run\'s result for the pair that is actually selected',
    );
  });

  it('scenario 2: clearCompare() mid-flight is not undone by the in-flight run resolving afterward', async () => {
    let pending: Promise<void> | undefined;
    act(() => {
      pending = hook!.runComparison();
    });
    assert.strictEqual(useViewerStore.getState().compareResult, null, 'run must still be in flight');

    act(() => {
      hook!.clearCompare();
    });
    assert.strictEqual(useViewerStore.getState().compareResult, null, 'cleared');

    await act(async () => {
      await pending;
    });

    assert.strictEqual(
      useViewerStore.getState().compareResult,
      null,
      'the stale result must not reappear after the user cleared it',
    );
  });

  it('scenario 3: changing the selected pair mid-flight (no second Run click) does not publish a result for the old pair under the new selection', async () => {
    let pending: Promise<void> | undefined;
    act(() => {
      pending = hook!.runComparison();
    });
    assert.strictEqual(useViewerStore.getState().compareResult, null, 'run must still be in flight');

    // The user changes the selection to FAST but never clicks Run again.
    act(() => {
      setPair(FAST);
    });

    await act(async () => {
      await pending;
    });

    const result = useViewerStore.getState().compareResult;
    const state = useViewerStore.getState();
    if (result) {
      assert.strictEqual(
        result.baseModelId,
        state.compareBaseModelId,
        'a published result must describe the currently selected pair, not a stale one',
      );
      assert.strictEqual(result.headModelId, state.compareHeadModelId);
    }
    // Either nothing published (acceptable - the stale run was dropped) or
    // what published agrees with the current selection. What must NEVER
    // happen is a published result for SLOW while FAST is selected.
    assert.ok(
      !result || (result.baseModelId === FAST.baseId) === (state.compareBaseModelId === FAST.baseId),
      'the panel must not show a diff for a pair that is no longer selected',
    );
  });

  it('scenario 5: a failed slow run does not clobber a newer, already-published successful result', async () => {
    let slowPending: Promise<void> | undefined;
    act(() => {
      slowPending = hook!.runComparison();
    });
    assert.strictEqual(useViewerStore.getState().compareResult, null, 'slow run must still be in flight');

    // Break the SLOW pair's head model out from under the in-flight run by
    // clearing its geometryResult - not literally, since the closure already
    // captured valid handles; instead simulate a fast, successful second run
    // for FAST, then force the slow run to fail by making its diff throw.
    // Simplest reliable failure: remove the SLOW head model's data store
    // reference is already captured, so instead corrupt `maxExpressId` is not
    // observed by the diff. Use scope='data' vs an unparseable store swap:
    // easiest is to delete the model entry entirely once the run has grabbed
    // its closure-local handles - buildEntityFingerprints reads only `store`/
    // `meshes`, already captured, so removal from the map does not fail it.
    // Instead, directly monkey-patch the SLOW head store to throw when
    // iterated, forcing `buildEntityFingerprints` (called on it) to reject.
    const slowHead = useViewerStore.getState().models.get(SLOW.headId)!;
    const originalEntities = (slowHead.ifcDataStore as unknown as { entities: unknown }).entities;
    Object.defineProperty(slowHead.ifcDataStore as object, 'entities', {
      get() {
        throw new Error('synthetic extraction failure');
      },
      configurable: true,
    });

    setPair(FAST);
    let fastPending: Promise<void> | undefined;
    act(() => {
      fastPending = hook!.runComparison();
    });

    await act(async () => {
      await fastPending;
    });
    const afterFast = useViewerStore.getState().compareResult;
    assert.ok(afterFast, 'the fast run must have published');
    assert.strictEqual(afterFast!.baseModelId, FAST.baseId);

    await act(async () => {
      await slowPending;
    });

    // Restore for hygiene (not strictly required, root gets torn down anyway).
    Object.defineProperty(slowHead.ifcDataStore as object, 'entities', {
      value: originalEntities,
      configurable: true,
      writable: true,
    });

    const finalResult = useViewerStore.getState().compareResult;
    assert.ok(
      finalResult && finalResult.baseModelId === FAST.baseId,
      'a failed superseded run must not clobber the newer successful result with an error / null',
    );
  });
});
