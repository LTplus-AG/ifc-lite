/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression guard for #2574's `discardSolidPresentation`: starting a clash
 * run (or a duplicates scan) must NOT tear down isolation/ghost state that
 * ANOTHER feature established. #2574 made `run()` / `runDuplicates()` call
 * `clearIsolation()` + `clearGhost()` unconditionally, so a user who isolated
 * a filter result ("Isolate in 3D", #2532) or an element assembly (#2531) and
 * then clicked Run had their isolation destroyed before any clash result
 * existed. Clash may only release the isolation/ghost presentation it itself
 * installed (focus modes #1275, and the solid's full-model ghost) - which the
 * second half of this file pins, so the fix cannot regress into "never clear",
 * the stale-overlay bug #2574's helper was added to prevent.
 *
 * Mounts the REAL `useClash()` hook over a REAL parsed model with real meshes
 * (the panel's Run button calls exactly these hook actions), and establishes
 * the user state through the same store actions the features use
 * (`isolateEntities` for Isolate in 3D, `setGhostExceptEntities` for the
 * spaces X-ray).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Clash, ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { useClash } from './useClash.js';
import { useSpaceSceneFraming } from '@/components/viewer/tools/space-sketch/useSpaceSceneFraming.js';

// ─── Fixture: two walls, meshed as overlapping unit boxes ───────────────────

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
  // disableWorkerScan keeps the scan in-process (no Worker under node:test).
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

function model(store: IfcDataStore, meshes: MeshData[]): FederatedModel {
  return {
    id: 'A',
    name: 'A.ifc',
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

/** The clash the overlapping boxes produce, as `focusClash` receives it from
 *  the panel list. Refs are federated global ids (model 'A' registers at
 *  offset 0, so global id === express id). */
const CLASH: Clash = {
  id: 'clash-1',
  a: { key: 'A:1', ref: 1, model: 'A', tag: 'IfcWall' },
  b: { key: 'A:2', ref: 2, model: 'A', tag: 'IfcWall' },
  rule: 'all-clashes',
  status: 'hard',
  distance: -0.5,
  point: [0.75, 0.5, 0.5],
  bounds: { min: [0.5, 0, 0], max: [1, 1, 1] },
  severity: 'major',
};

// ─── Harness ────────────────────────────────────────────────────────────────

type ClashApi = ReturnType<typeof useClash>;

let api: ClashApi | null = null;

function Probe(): null {
  api = useClash();
  return null;
}

let root: Root | null = null;

async function seed(): Promise<void> {
  const store = await parse(TWO_WALLS);
  useViewerStore.setState({
    models: new Map([['A', model(store, [boxMesh(1, 0), boxMesh(2, 0.5)])]]),
    clashResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
  });
  // focusClash resolves its pair through the federation registry; a model
  // seeded via setState never registered, so register it here (offset 0 -
  // global ids equal express ids), exactly what addModel does on a real load.
  useViewerStore.getState().registerModelOffset('A', 100);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'useClash must be mounted');
}

beforeEach(() => {
  api = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

describe('clash runs release only clash-owned view state (#2574 regression)', () => {
  it('a user-established isolation SURVIVES run() (#2532 Isolate in 3D / #2531 assembly isolate)', async () => {
    await seed();
    // The user isolates through the shared channel action both features call.
    useViewerStore.getState().isolateEntities([1]);
    assert.deepEqual([...useViewerStore.getState().isolatedEntities!], [1], 'setup sanity: isolation active before Run');

    await act(async () => { await api!.run([ALL_RULE]); });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null);
    assert.ok(s.clashResult && s.clashResult.clashes.length >= 1, 'the run must actually complete and find the overlap');
    assert.ok(s.isolatedEntities, 'the user isolation must still be standing after Run');
    assert.deepEqual([...s.isolatedEntities], [1], 'the isolated set must be untouched');
  });

  it('a user-established isolation SURVIVES runDuplicates()', async () => {
    await seed();
    useViewerStore.getState().isolateEntities([2]);
    assert.deepEqual([...useViewerStore.getState().isolatedEntities!], [2], 'setup sanity: isolation active before the scan');

    await act(async () => { await api!.runDuplicates(); });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null);
    assert.ok(s.clashResult, 'the duplicate scan must actually complete');
    assert.ok(s.isolatedEntities, 'the user isolation must still be standing after the scan');
    assert.deepEqual([...s.isolatedEntities], [2], 'the isolated set must be untouched');
  });

  it('a user-established X-ray ghost SURVIVES run()', async () => {
    await seed();
    // The spaces X-ray drives this store action directly (ghostExceptEntities).
    useViewerStore.getState().setGhostExceptEntities(new Set([1]));
    assert.ok(useViewerStore.getState().ghostExceptEntities, 'setup sanity: ghost active before Run');

    await act(async () => { await api!.run([ALL_RULE]); });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null);
    assert.ok(s.clashResult && s.clashResult.clashes.length >= 1, 'the run must actually complete and find the overlap');
    assert.ok(s.ghostExceptEntities, 'the user ghost must still be standing after Run');
    assert.deepEqual([...s.ghostExceptEntities], [1], 'the ghosted set must be untouched');
  });

  it('clash-established ISOLATE focus is still discarded when a new run starts', async () => {
    await seed();
    await act(async () => { api!.focusClash(CLASH, 'isolate'); });
    assert.deepEqual([...(useViewerStore.getState().isolatedEntities ?? [])].sort(), [1, 2],
      'setup sanity: focusClash installed the pair isolation');

    await act(async () => { await api!.run([ALL_RULE]); });

    assert.equal(useViewerStore.getState().isolatedEntities, null,
      'the clash focus isolation must be released when a new run replaces the result set');
  });

  it('clash-established GHOST focus is still discarded when a new run starts', async () => {
    await seed();
    await act(async () => { api!.focusClash(CLASH, 'ghost'); });
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(), [1, 2],
      'setup sanity: focusClash installed the pair ghost');

    await act(async () => { await api!.runDuplicates(); });

    assert.equal(useViewerStore.getState().ghostExceptEntities, null,
      'the clash focus ghost must be released when a new scan replaces the result set');
  });
});

// ─── Snapshot/restore flows must not launder clash-owned state (#2662 P2) ───
//
// Space Sketch captures the prior 3D view on open and replays it on close
// (`useSpaceSceneFraming`): it CLONES `isolatedEntities`/`ghostExceptEntities`
// and restores them through the slice setters, which store a fresh `Set` per
// write. The restored state is still the old clash presentation, but its
// reference no longer matches anything clash recorded - under reference-based
// provenance the next run() replaced the clash result while leaving the old
// focused pair isolated/ghosted. Ownership must survive an equivalent restore.

/** Mounts the REAL Space Sketch scene-framing hook - the same code the tool
 *  runs on open (capture prior view) and on close/unmount (restore it). */
function FramingProbe(): null {
  useSpaceSceneFraming({ enabled: true, existingSpaceIds: [] });
  return null;
}

/** Open Space Sketch, then close it: the unmount cleanup replays the captured
 *  prior view through the cloning visibility setters. */
async function openAndCloseSpaceSketch(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const sketchRoot = createRoot(container);
  await act(async () => { sketchRoot.render(<FramingProbe />); });
  await act(async () => sketchRoot.unmount());
  container.remove();
}

describe('clash focus ownership survives Space Sketch snapshot/restore (#2662 P2)', () => {
  it('clash ISOLATE focus restored by a Space Sketch open/close is still discarded by the next run()', async () => {
    await seed();
    await act(async () => { api!.focusClash(CLASH, 'isolate'); });
    assert.deepEqual([...(useViewerStore.getState().isolatedEntities ?? [])].sort(), [1, 2],
      'setup sanity: focusClash installed the pair isolation');
    const installed = useViewerStore.getState().isolatedEntities;

    await openAndCloseSpaceSketch();
    const restored = useViewerStore.getState().isolatedEntities;
    assert.deepEqual([...(restored ?? [])].sort(), [1, 2],
      'setup sanity: closing Space Sketch restored the clash isolation');
    assert.notEqual(restored, installed,
      'setup sanity: the restore replaced the Set identity (the flow under test)');

    await act(async () => { await api!.run([ALL_RULE]); });

    assert.equal(useViewerStore.getState().isolatedEntities, null,
      'the restored presentation is still the clash focus and must be released by a new run');
  });

  it('clash GHOST focus restored by a Space Sketch open/close is still discarded by the next runDuplicates()', async () => {
    await seed();
    await act(async () => { api!.focusClash(CLASH, 'ghost'); });
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(), [1, 2],
      'setup sanity: focusClash installed the pair ghost');
    const installed = useViewerStore.getState().ghostExceptEntities;

    await openAndCloseSpaceSketch();
    const restored = useViewerStore.getState().ghostExceptEntities;
    assert.deepEqual([...(restored ?? [])].sort(), [1, 2],
      'setup sanity: closing Space Sketch restored the clash ghost');
    assert.notEqual(restored, installed,
      'setup sanity: the restore replaced the Set identity (the flow under test)');

    await act(async () => { await api!.runDuplicates(); });

    assert.equal(useViewerStore.getState().ghostExceptEntities, null,
      'the restored presentation is still the clash focus and must be released by a new scan');
  });

  it('a user isolation that REPLACED a clash focus still survives run() (ownership is content, not "clash installed something")', async () => {
    await seed();
    await act(async () => { api!.focusClash(CLASH, 'isolate'); });
    // The user takes the shared channel over with DIFFERENT content - clash
    // no longer owns the presentation, whatever its install record says.
    useViewerStore.getState().isolateEntities([1]);
    assert.deepEqual([...useViewerStore.getState().isolatedEntities!], [1],
      'setup sanity: the user isolation replaced the clash focus');

    await act(async () => { await api!.run([ALL_RULE]); });

    const s = useViewerStore.getState();
    assert.ok(s.isolatedEntities, 'the user isolation must still be standing after Run');
    assert.deepEqual([...s.isolatedEntities], [1], 'the isolated set must be untouched');
  });
});
