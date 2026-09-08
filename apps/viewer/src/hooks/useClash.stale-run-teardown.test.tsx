/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A detection run that lands AFTER the models it examined are gone must not
 * repopulate `clashResult`.
 *
 * `useClash.run()` gathers elements from the live federation and then awaits the
 * engine for as long as the geometry takes. "Open file" / "Clear all" /
 * "Remove model" during that window tear the federation down
 * (`clearAllModels`, `resetViewerState`, `removeModel`), and a collab peer edit
 * replaces the active model's data store in place (`setIfcDataStore`). Before
 * the federation-identity guard, the finishing run wrote its result anyway: the
 * panel filled with pairs whose refs resolve to nothing, and every row was
 * inert (`focusClash` bails at `refs.length === 0`) with no indication why.
 *
 * ## The interleaving is real, not simulated
 *
 * The teardown is fired from a store subscription on `clashProgress` reaching
 * the NARROW phase - a progress event the TS kernel emits from inside
 * `detectRule`, i.e. after `gatherElements()` has read the federation and
 * before any result exists. There is deliberately NO `await flush()` /
 * `Promise.resolve()` between the teardown and the run landing: such a flush
 * would let the whole (fast, in-test) run complete first, the teardown would
 * then clear the result itself, and the assertion would pass against broken
 * code.
 *
 * The companion tests at the bottom pin that a NORMAL run still publishes, so a
 * guard that discarded everything cannot pass this file.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { posthog } from '@/lib/analytics';
import { useClash } from './useClash.js';

// ─── Fixture: two walls per model, meshed as overlapping unit boxes ──────────

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
  // disableWorkerScan keeps the scan in-process (no Worker under node:test).
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

function Probe(): null {
  api = useClash();
  return null;
}

let root: Root | null = null;

/** Seed `modelIds` models, each two overlapping walls, and mount the REAL hook. */
async function seed(modelIds: string[] = ['A']): Promise<void> {
  const models = new Map<string, FederatedModel>();
  for (const id of modelIds) {
    const store = await parse(TWO_WALLS);
    models.set(id, model(id, store, [boxMesh(1, 0), boxMesh(2, 0.5)]));
  }
  useViewerStore.setState({
    models,
    activeModelId: modelIds[0] ?? null,
    clashResult: null,
    clashRawResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
  });
  // focusClash resolves its pair through the federation registry; a model
  // seeded via setState never registered, so register it here, exactly what
  // addModel does on a real load.
  for (const id of modelIds) useViewerStore.getState().registerModelOffset(id, 100);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'useClash must be mounted');
}

/**
 * Fire `action` the moment the engine reports NARROW-phase progress — inside
 * `detectRule`, after `gatherElements()` read the federation and before any
 * result exists. This is the whole window under test; nothing may `await`
 * between this firing and the run landing.
 */
function tearDownMidRun(action: () => void): () => void {
  let fired = false;
  return useViewerStore.subscribe((s) => {
    if (fired || s.clashProgress?.phase !== 'narrow') return;
    fired = true;
    action();
  });
}

/**
 * Telemetry sink. `run()`'s only observable write after the publish guard is
 * `posthog.capture('clash_detection_run', ...)` — dropping the early return
 * changes nothing else in the store, so this is what pins "a discarded run must
 * not go on to write its dependent state".
 */
const captured: string[] = [];
const realCapture = posthog.capture;

beforeEach(() => {
  api = null;
  captured.length = 0;
  posthog.capture = ((event: string) => {
    captured.push(event);
  }) as typeof posthog.capture;
});

afterEach(async () => {
  posthog.capture = realCapture;
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

// ─── RED: a run that lands into a torn-down world must publish nothing ──────

describe('a clash run landing after its models are gone must not repopulate the result', () => {
  it('"Clear all" mid-run: the finishing run must not repopulate clashResult', async () => {
    await seed(['A']);
    const seqBefore = useViewerStore.getState().clashRunSeq;
    const unsub = tearDownMidRun(() => useViewerStore.getState().clearAllModels());

    await act(async () => { await api!.run([ALL_RULE]); });
    unsub();

    const s = useViewerStore.getState();
    assert.equal(s.models.size, 0, 'setup sanity: the teardown really ran mid-flight');
    assert.equal(s.clashResult, null, 'a run over models that are gone must not repopulate the result list');
    assert.equal(s.clashRawResult, null, 'the raw result must be discarded with the derived one');
    assert.equal(s.clashGroups, null, 'a discarded run must not publish its groups either');
    assert.equal(s.clashRunSeq, seqBefore, 'a discarded run must not signal a completed run');
    assert.ok(!captured.includes('clash_detection_run'),
      'a discarded run must not report itself as a completed detection run');
  });

  it('"Open file" mid-run (resetViewerState + clearAllModels): the finishing run must not repopulate clashResult', async () => {
    await seed(['A']);
    const seqBefore = useViewerStore.getState().clashRunSeq;
    const unsub = tearDownMidRun(() => {
      // The order the load path uses: reset the view, then drop the models.
      useViewerStore.getState().resetViewerState();
      useViewerStore.getState().clearAllModels();
    });

    await act(async () => { await api!.run([ALL_RULE]); });
    unsub();

    const s = useViewerStore.getState();
    assert.equal(s.models.size, 0, 'setup sanity: the teardown really ran mid-flight');
    assert.equal(s.clashResult, null, 'a run over models that are gone must not repopulate the result list');
    assert.equal(s.clashGroups, null, 'a discarded run must not publish its groups either');
    assert.equal(s.clashRunSeq, seqBefore, 'a discarded run must not signal a completed run');
  });

  it('removeModel mid-run: the run examined the removed model, so its result must be discarded', async () => {
    await seed(['A', 'B']);
    const seqBefore = useViewerStore.getState().clashRunSeq;
    const unsub = tearDownMidRun(() => useViewerStore.getState().removeModel('B'));

    await act(async () => { await api!.run([ALL_RULE]); });
    unsub();

    const s = useViewerStore.getState();
    assert.equal(s.models.size, 1, 'setup sanity: exactly one model was removed mid-flight');
    assert.equal(s.clashResult, null,
      'the gathered element set included B, so every pair naming B would be an inert row');
    assert.equal(s.clashGroups, null, 'a discarded run must not publish its groups either');
    assert.equal(s.clashRunSeq, seqBefore, 'a discarded run must not signal a completed run');
  });

  it('a collab peer edit mid-run (setIfcDataStore) must discard the result: express ids get reassigned', async () => {
    await seed(['A']);
    const seqBefore = useViewerStore.getState().clashRunSeq;
    const replacement = await parse(TWO_WALLS);
    const unsub = tearDownMidRun(() => useViewerStore.getState().setIfcDataStore(replacement));

    await act(async () => { await api!.run([ALL_RULE]); });
    unsub();

    const s = useViewerStore.getState();
    assert.equal(s.models.get('A')?.ifcDataStore, replacement,
      'setup sanity: the peer edit really replaced the active model data store mid-flight');
    assert.equal(s.clashResult, null,
      'the result was computed against the pre-edit store, whose express ids no longer hold');
    assert.equal(s.clashGroups, null, 'a discarded run must not publish its groups either');
    assert.equal(s.clashRunSeq, seqBefore, 'a discarded run must not signal a completed run');
  });

  /**
   * `runDuplicates` has no interleaving window today — the scan between the
   * gather and the publish is synchronous — so this drives the discard through
   * the one seam the path does have: the federation changing WHILE
   * `gatherElements` iterates. That is exactly the state `publishClashResult`
   * is defined on, and it is the only place the duplicate path's dependent
   * write (`setClashGroups`) can be pinned. Without it, deleting the early
   * return after a discarded publish leaves the whole suite green.
   */
  it('a discarded duplicate scan must not publish its duplicate sets either', async () => {
    await seed(['A', 'B']);
    const seqBefore = useViewerStore.getState().clashRunSeq;
    useViewerStore.setState((s) => {
      const models = new Map(s.models);
      const b = models.get('B')!;
      const bStore = b.ifcDataStore!;
      let fired = false;
      models.set('B', {
        ...b,
        // Read inside `gatherElements`' loop, after A has already been
        // recorded and its elements taken — the federation the scan examined
        // is gone by the time it publishes.
        get ifcDataStore() {
          if (!fired) {
            fired = true;
            useViewerStore.getState().removeModel('A');
          }
          return bStore;
        },
      } as FederatedModel);
      return { models };
    });

    await act(async () => { await api!.runDuplicates(); });

    const s = useViewerStore.getState();
    assert.ok(!s.models.has('A'), 'setup sanity: A really went away while the scan was gathering');
    assert.equal(s.clashResult, null, 'the scan examined A, which is gone');
    assert.equal(s.clashGroups, null, 'a discarded scan must not publish its duplicate SETS either');
    assert.equal(s.clashRunSeq, seqBefore, 'a discarded scan must not signal a completed run');
    assert.ok(!captured.includes('clash_duplicate_scan'),
      'a discarded scan must not report itself as a completed scan');
  });
});

// ─── GREEN companions: a guard that discards everything must fail here ──────

describe('a normal clash run still publishes its result', () => {
  it('run() with no teardown publishes the result and bumps clashRunSeq', async () => {
    await seed(['A']);
    const seqBefore = useViewerStore.getState().clashRunSeq;

    await act(async () => { await api!.run([ALL_RULE]); });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null, 'the run must not error');
    assert.ok(s.clashResult && s.clashResult.clashes.length >= 1, 'the overlap must be found and published');
    assert.equal(s.clashRunSeq, seqBefore + 1, 'the completed-run signal must be bumped with the result');
  });

  it('runDuplicates() with no teardown publishes its result', async () => {
    await seed(['A']);
    const seqBefore = useViewerStore.getState().clashRunSeq;

    await act(async () => { await api!.runDuplicates(); });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null, 'the scan must not error');
    assert.ok(s.clashResult, 'the duplicate scan must publish its result');
    assert.equal(s.clashRunSeq, seqBefore + 1, 'the completed-run signal must be bumped with the result');
  });

  it('a model ADDED mid-run does not discard the result: the examined world is still there', async () => {
    await seed(['A']);
    const extra = await parse(TWO_WALLS);
    const unsub = tearDownMidRun(() => {
      useViewerStore.getState().addModel(model('C', extra, [boxMesh(1, 0), boxMesh(2, 0.5)]));
    });

    await act(async () => { await api!.run([ALL_RULE]); });
    unsub();

    const s = useViewerStore.getState();
    assert.ok(s.models.has('C'), 'setup sanity: the model was really added mid-flight');
    assert.ok(s.clashResult && s.clashResult.clashes.length >= 1,
      'nothing the run examined went away, so its result is still about models that exist');
  });

  /**
   * The background spatial-index build (`utils/loadingUtils.ts`
   * `buildSpatialIndexGuarded`) republishes the ACTIVE model's store as a
   * shallow clone once the index is ready. Every loader starts it AFTER
   * `finalizeModel(... loadState: 'complete')` — `useIfcLoader.ts:1899`,
   * `useIfcCache.ts:450`, `useIfcServer.ts:384` — so the UI is interactive and
   * Run is clickable while it runs, for seconds on a large model.
   *
   * That publish changes the store REFERENCE while leaving every express id
   * untouched: the clone shares the entity table, so every ref the run
   * computed still resolves and still focuses. A guard keyed on the store
   * wrapper throws the run away here — a correct result, silently discarded,
   * with no `clashError` to distinguish it from "no clashes found".
   */
  it('the background spatial-index publish mid-run must not discard the result', async () => {
    await seed(['A']);
    const store = useViewerStore.getState().models.get('A')!.ifcDataStore!;
    // `buildSpatialIndexGuarded` guards on the ACTIVE store and writes through
    // `setIfcDataStore`, so mirror its precondition.
    useViewerStore.setState({ ifcDataStore: store });
    const unsub = tearDownMidRun(() => {
      // Verbatim the publish at loadingUtils.ts:41-42: the index is attached to
      // the captured store, which is then re-published as a shallow clone.
      const capturedStore = useViewerStore.getState().ifcDataStore!;
      useViewerStore.getState().setIfcDataStore({ ...capturedStore });
    });

    await act(async () => { await api!.run([ALL_RULE]); });
    unsub();

    const s = useViewerStore.getState();
    const published = s.models.get('A')!.ifcDataStore!;
    assert.notEqual(published, store, 'setup sanity: the store REFERENCE really was replaced mid-flight');
    assert.equal(published.entities, store.entities,
      'setup sanity: a shallow clone shares the entity table, so no express id moved');
    assert.equal(s.clashError, null, 'the run must not error');
    assert.ok(s.clashResult && s.clashResult.clashes.length >= 1,
      'no express id changed, so every row still resolves: this result must be published');
  });

  it('removing a model the run never examined does not discard the result', async () => {
    await seed(['A', 'B']);
    // B contributes no elements: no data store, no meshes. `gatherElements`
    // skips it, so its removal cannot invalidate anything the run looked at.
    useViewerStore.setState((s) => {
      const models = new Map(s.models);
      models.set('B', { ...models.get('B')!, ifcDataStore: null, geometryResult: null });
      return { models };
    });
    const unsub = tearDownMidRun(() => useViewerStore.getState().removeModel('B'));

    await act(async () => { await api!.run([ALL_RULE]); });
    unsub();

    const s = useViewerStore.getState();
    assert.ok(!s.models.has('B'), 'setup sanity: the unexamined model was really removed mid-flight');
    assert.ok(s.clashResult && s.clashResult.clashes.length >= 1,
      'the removed model contributed no elements, so the result stands');
  });
});
