/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The JOIN between the `clashSolidRequestSeq` producers and the consumer that
 * reads it.
 *
 * Four sibling suites pin the PRODUCER side — that Home reset, the clash tour
 * cleanup, `clearClashFocus` and the model-lifecycle teardowns each bump
 * `clashSolidRequestSeq`:
 *
 *   - `store/homeView.solid-teardown.test.ts`
 *   - `store/slices/clashSlice.solid.test.ts`
 *   - `lib/tours/tours/clash.solid-teardown.test.ts`
 *   - `store/modelLifecycle.solid-teardown.test.ts`
 *
 * `lib/clash/intersection-solid.test.ts` pins the CALLEE — the wasm kernel
 * wrapper — by calling it directly. Nothing pinned the line that connects
 * them: the staleness check in `useClash.ts` that compares the seq captured
 * before `computeClashIntersectionSolid()` against the seq at resolve time and
 * drops the result if they differ. Deleting BOTH copies of that check (the
 * `.then` and the `.catch`) left all four producer suites, the callee suite,
 * `useClash.solid-invalidation.test.tsx`, `ClashPanel.focus-teardown.test.tsx`
 * and `modelLifecycle.visibility-ownership.test.ts` green — 36 tests, zero
 * failures. Those suites write `clashSolidStatus: 'computing'` as a plain
 * string and assert only that the seq CHANGED; no compute was ever in flight,
 * so nothing observed whether a stale one still painted.
 *
 * This file drives the REAL hook over the REAL wasm kernel and lets a genuine
 * compute be in flight across each teardown.
 *
 * ## The interleaving is real, not simulated
 *
 * `focusClash` calls `setClashSolidComputing()` synchronously, one statement
 * before it launches `computeClashIntersectionSolid(...)` and after it has
 * already captured its request seq. A store subscription on that status
 * transition therefore fires INSIDE `focusClash`, with the compute about to be
 * launched under an already-captured seq — the exact window. There is
 * deliberately NO `await flush()` / `tick()` / `Promise.resolve()` between the
 * teardown firing and the compute landing: such a flush would let the compute
 * resolve and paint first, the teardown would then clear the painted solid
 * itself, and every assertion below would pass against a hook with no
 * staleness check at all.
 *
 * The companion suite at the bottom pins that an UNDISTURBED focus still
 * paints its solid, so a guard that discarded every result cannot pass this
 * file.
 *
 * ## Known residual
 *
 * Only the `.then` copy of the staleness check is covered here. The `.catch`
 * copy needs the kernel to REJECT, and it does not reject on any input reached
 * from the hook: a malformed operand comes back as a resolved
 * `{ isSolid: false }` (verified against the real wasm binding), not a thrown
 * error. Forcing a rejection would mean mocking the kernel — a production seam
 * that does not exist today — so the `.catch` guard stays unpinned rather than
 * being pinned by reshaping the hook to suit a test.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { initSync } from '@ifc-lite/wasm';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Clash, ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';

import { useViewerStore, type FederatedModel } from '@/store';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import { CLASH_TOUR } from '@/lib/tours/tours/clash';
import { useClash } from './useClash.js';

// ─── Real wasm, loaded from disk ────────────────────────────────────────────
// Same rationale and pattern as `lib/clash/intersection-solid.test.ts`: the
// wrapper's own `init()` resolves the binary through `fetch()`, which this
// runner has no answer for, and `initSync` shares the same module singleton so
// pre-loading it here makes that `init()` a no-op. Skipped per-test when the
// build artifact is absent, so a missing `bash scripts/build-wasm.sh` skips
// visibly instead of throwing before the first test.

const wasmPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm',
);

let wasmReady = false;
function ensureWasm(t: { skip: (msg: string) => void }): boolean {
  if (wasmReady) return true;
  if (!existsSync(wasmPath)) {
    t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
    return false;
  }
  initSync({ module: readFileSync(wasmPath) });
  wasmReady = true;
  return true;
}

// ─── Fixture: two overlapping unit boxes in one model ───────────────────────
// Lifted from `useClash.stale-run-teardown.test.tsx`; the 0.5 m overlap is deep
// enough that the kernel resolves a real intersection solid (asserted by the
// companion suite), so "a stale compute painted" is observable, not vacuous.

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

const TWO_WALLS = [
  "#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);",
  "#2=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,$,$,$,.STANDARD.);",
].join('\n');

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A unit box (12 triangles) with its min corner at `(dx, 0, 0)`. */
function boxMesh(expressId: number, dx: number): MeshData {
  const positions = new Float32Array([
    dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0,
    dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

function geometry(meshes: MeshData[]): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } };
  const coordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: false,
  };
  return { meshes, totalTriangles: 12 * meshes.length, totalVertices: 8 * meshes.length, coordinateInfo };
}

function model(id: string, store: IfcDataStore, meshes: MeshData[]): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: store,
    geometryResult: geometry(meshes),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 2,
  };
}

/** The rule `runAll` builds: every element vs every other, hard clash. */
const ALL_RULE: ClashRule = { id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' };

// ─── Harness ────────────────────────────────────────────────────────────────

type ClashApi = ReturnType<typeof useClash>;

let api: ClashApi | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useClash();
  return null;
}

/**
 * Mount the real hook over one model of two overlapping walls, run detection,
 * and return the clash a user would click. `elementsByRef` — the map
 * `focusClash` resolves its two operand meshes through — is populated by
 * `run()`, so the run is not optional set-up dressing: without it `focusClash`
 * never reaches the compute at all.
 */
async function seedAndRun(): Promise<Clash> {
  const store = await parse(TWO_WALLS);
  useViewerStore.setState({
    models: new Map([['A', model('A', store, [boxMesh(1, 0), boxMesh(2, 0.5)])]]),
    activeModelId: 'A',
    clashResult: null,
    clashRawResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
    clashSolidStatus: 'none',
    clashSolidMesh: null,
    clashSolidVolumeM3: 0,
  });
  useViewerStore.getState().registerModelOffset('A', 100);

  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  assert.ok(api, 'useClash must be mounted');

  await act(async () => { await api!.run([ALL_RULE]); });
  const clash = useViewerStore.getState().clashResult?.clashes[0];
  assert.ok(clash, 'setup: the two overlapping walls must produce a clash to focus');
  return clash;
}

/**
 * Fire `action` the instant `focusClash` marks the solid compute as started —
 * `setClashSolidComputing()`, one statement after the request seq is captured
 * and one before `computeClashIntersectionSolid()` is called. The subscription
 * runs synchronously inside `focusClash`, so nothing awaits between the
 * teardown and the compute landing. That is the whole window under test.
 */
function tearDownMidCompute(action: () => void): () => void {
  let fired = false;
  return useViewerStore.subscribe((s) => {
    if (fired || s.clashSolidStatus !== 'computing') return;
    fired = true;
    action();
  });
}

/**
 * Focus `clash`, letting the compute launched by that focus settle. `act`
 * drains the microtask queue the compute's `.then` lives on, so by the time
 * this returns the compute has either painted or been dropped.
 */
async function focusAndSettle(clash: Clash): Promise<void> {
  await act(async () => { api!.focusClash(clash, 'ghost'); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** Everything the resolved-solid branch of the compute writes. Nothing here
 *  may be set by a compute that was superseded before it landed. */
function assertNoSolidPainted(where: string): void {
  const s = useViewerStore.getState();
  assert.notEqual(s.clashSolidStatus, 'solid',
    `${where}: a superseded compute must not paint the intersection solid`);
  assert.equal(s.clashSolidMesh, null,
    `${where}: a superseded compute must not install its mesh`);
  assert.equal(s.clashSolidVolumeM3, 0,
    `${where}: a superseded compute must not publish its volume`);
  assert.notEqual(s.clashSolidStatus, 'unavailable',
    `${where}: a superseded compute must not report its degenerate reason either — ` +
    'the panel would say "no solid" about a clash the user is no longer looking at');
}

beforeEach(() => { api = null; });

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.setState({ models: new Map(), clashResult: null, clashRawResult: null, clashGroups: null });
});

// ─── RED: a compute that lands after its focus was torn down paints nothing ──

describe('an intersection-solid compute in flight across a teardown must not paint', () => {
  it('Home / "Show all" mid-compute: the landing compute must not paint the solid', async (t) => {
    if (!ensureWasm(t)) return;
    const clash = await seedAndRun();
    const unsub = tearDownMidCompute(() => resetVisibilityForHomeFromStore());

    await focusAndSettle(clash);
    unsub();

    assert.equal(useViewerStore.getState().clashSelectedId, null,
      'setup sanity: the Home reset really ran while the compute was in flight');
    assertNoSolidPainted('Home reset mid-compute');
  });

  it('clash-tour cleanup mid-compute: the landing compute must not paint the solid', async (t) => {
    if (!ensureWasm(t)) return;
    const zoomStep = CLASH_TOUR.steps.find((s) => s.id === 'zoom-to-clash');
    assert.ok(zoomStep?.cleanup, 'zoom-to-clash step must have a cleanup()');
    const clash = await seedAndRun();
    const unsub = tearDownMidCompute(() => {
      zoomStep!.cleanup!(useViewerStore, { baseline: { hadResultAtEntry: 0 }, artifacts: new Map() });
    });

    await focusAndSettle(clash);
    unsub();

    assert.equal(useViewerStore.getState().clashSelectedId, null,
      'setup sanity: the tour cleanup really ran while the compute was in flight');
    assertNoSolidPainted('tour cleanup mid-compute');
  });

  it('clearClashFocus mid-compute: the landing compute must not paint the solid', async (t) => {
    if (!ensureWasm(t)) return;
    const clash = await seedAndRun();
    const unsub = tearDownMidCompute(() => useViewerStore.getState().clearClashFocus());

    await focusAndSettle(clash);
    unsub();

    assert.equal(useViewerStore.getState().clashSelectedId, null,
      'setup sanity: the focus was really ended while the compute was in flight');
    assertNoSolidPainted('clearClashFocus mid-compute');
  });

  it('"Clear all" mid-compute: the landing compute must not paint a solid for a model that is gone', async (t) => {
    if (!ensureWasm(t)) return;
    const clash = await seedAndRun();
    const unsub = tearDownMidCompute(() => useViewerStore.getState().clearAllModels());

    await focusAndSettle(clash);
    unsub();

    assert.equal(useViewerStore.getState().models.size, 0,
      'setup sanity: the models really went away while the compute was in flight');
    assertNoSolidPainted('clearAllModels mid-compute');
  });

  it('a SECOND focus mid-compute: the first compute must not paint over the second focus', async (t) => {
    if (!ensureWasm(t)) return;
    const clash = await seedAndRun();
    // The narrowest case: no teardown at all, just the user clicking another
    // row. `setClashSelectedId` bumps the seq, so the first compute is stale
    // even though the second focus leaves a perfectly valid presentation
    // standing — only the SEQ distinguishes them, nothing else does.
    const unsub = tearDownMidCompute(() => {
      useViewerStore.getState().setClashSelectedId('clash-other');
    });

    await focusAndSettle(clash);
    unsub();

    assert.equal(useViewerStore.getState().clashSelectedId, 'clash-other',
      'setup sanity: the selection really moved on while the compute was in flight');
    assertNoSolidPainted('superseded by a second focus');
  });
});

// ─── GREEN companion: a guard that discarded everything must fail here ──────

describe('an undisturbed intersection-solid compute still paints', () => {
  it('focusClash with no teardown resolves and paints the solid', async (t) => {
    if (!ensureWasm(t)) return;
    const clash = await seedAndRun();

    await focusAndSettle(clash);

    const s = useViewerStore.getState();
    assert.equal(s.clashSolidStatus, 'solid',
      'the 0.5 m deep overlap must resolve to a real solid — without this, every ' +
      'assertion in the suite above would pass against a hook that discards everything');
    assert.ok(s.clashSolidMesh && s.clashSolidMesh.indices.length > 0,
      'the resolved solid must install a non-empty mesh');
    assert.ok(s.clashSolidVolumeM3 > 0, 'the resolved solid must publish its volume');
  });
});
