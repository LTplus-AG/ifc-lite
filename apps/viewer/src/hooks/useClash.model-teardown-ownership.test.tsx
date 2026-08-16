/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `removeModel` must release exactly the shared visibility channel CLASH
 * installed — no more, no less.
 *
 * The previous revision of #2654 gated that release on `clashSelectedId`, a
 * SELECTION fact standing in for an OWNERSHIP fact. The two diverge in both
 * directions, and this file drives the real hook + the real store action over
 * each divergence:
 *
 *  - OVER-CLEAR: `applyFocusMode`'s `highlight` branch (the panel's default row
 *    click) clears both channels and owns neither afterwards, but leaves
 *    `clashSelectedId` set. The next owner to install a ghost had it destroyed
 *    by an unrelated model removal — and on the `syncSourceModel` path that IS
 *    the original #2654 regression, because `purgeStaleEntityState` runs one
 *    line later and reads `null`.
 *  - UNDER-CLEAR: `selectElement` (the chevron expand and the per-side button)
 *    installs a NON-EMPTY clash isolation through `applyFocusMode` and never
 *    writes `clashSelectedId`. It survived the removal, so `isEntityVisible`
 *    returned false for everything: a blank viewport.
 *
 * Ownership now lives in the store (`clashVisibilityOwned`), written by the
 * install helpers and read by the one shared release — so both directions are
 * decided by the same fact the hook itself uses.
 *
 * Same harness as `useClash.run-preserves-isolation.test.tsx`: the REAL
 * `useClash()` hook over a REAL parsed model with real meshes, and the user's
 * own state established through the same store actions the other features call.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Clash } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { useClash } from './useClash.js';

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

/** Two models: the removal must be a federated sibling leaving, not the last
 *  model going (which takes the `models.size <= 1` branch instead). */
async function seed(): Promise<void> {
  const store = await parse(TWO_WALLS);
  useViewerStore.setState({
    models: new Map([
      ['A', model('A', store, [boxMesh(1, 0), boxMesh(2, 0.5)])],
      ['B', model('B', store, [boxMesh(1, 0), boxMesh(2, 0.5)])],
    ]),
    clashResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    clashHighlightColors: null,
    clashVisibilityOwned: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
    lensAppliedColors: null,
    pendingColorUpdates: null,
  });
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

describe('removeModel releases the visibility channel clash OWNS (#2654 third review)', () => {
  it('OVER-CLEAR: a highlight-mode focus owns neither channel, so another feature\'s ghost survives', async () => {
    await seed();
    // Highlight is the panel's DEFAULT row click (ClashPanel) and the hook's
    // default mode. It clears both channels and takes ownership of neither.
    await act(async () => { api!.focusClash(CLASH, 'highlight'); });
    assert.equal(useViewerStore.getState().ghostExceptEntities, null,
      'setup sanity: highlight cleared the ghost channel');
    assert.notEqual(useViewerStore.getState().clashSelectedId, null,
      'setup sanity: a clash IS selected — the fact the old gate mistook for ownership');

    // Now ANOTHER owner takes the channel: this is the store action the spaces
    // X-ray, LayerDiffView and Space Sketch's ghost preview all drive.
    useViewerStore.getState().setGhostExceptEntities(new Set([1]));

    useViewerStore.getState().removeModel('B');

    const s = useViewerStore.getState();
    assert.ok(s.ghostExceptEntities,
      'clash disowned the channel in highlight mode — removing an unrelated model must not destroy the ghost the next owner installed. On the syncSourceModel path this is the original #2654 regression: purgeStaleEntityState runs one line later and reads null.');
    assert.deepEqual([...s.ghostExceptEntities], [1], 'and must not filter it either — that is the resync purge\'s job');
  });

  it('UNDER-CLEAR: selectElement installs a clash isolation with NO clash selected, and it is released', async () => {
    await seed();
    // The chevron expand and the per-side "focus this element" button both call
    // this. It installs a non-empty isolation and never writes clashSelectedId.
    await act(async () => { api!.selectElement(CLASH.a, 'isolate'); });
    assert.deepEqual([...(useViewerStore.getState().isolatedEntities ?? [])], [1],
      'setup sanity: selectElement installed a clash isolation');
    assert.equal(useViewerStore.getState().clashSelectedId, null,
      'setup sanity: and left clashSelectedId null — the divergence the old gate could not see');

    useViewerStore.getState().removeModel('B');

    assert.equal(useViewerStore.getState().isolatedEntities, null,
      'a clash-owned isolation left standing makes isEntityVisible false for everything: a blank viewport with nothing selected and no way to tell why');
  });

  it('the reported bug stays closed: a clash GHOST focus is released and the scene is not left faded', async () => {
    await seed();
    await act(async () => { api!.focusClash(CLASH, 'ghost'); });
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(), [1, 2],
      'setup sanity: focusClash installed the pair ghost');

    useViewerStore.getState().removeModel('B');

    const s = useViewerStore.getState();
    assert.equal(s.ghostExceptEntities, null, 'the clash ghost must go with the presentation that owns it');
    assert.equal(s.clashSelectedId, null, 'and the focused-clash presentation with it');
    assert.equal(s.clashContactLines, null, 'including the contact marker Viewport draws from these fields alone');
    assert.equal(s.clashOverlapBox, null);
    assert.ok(s.pendingColorUpdates, 'the pair tint must be released through the PAINT channel — null is a no-op there');
    assert.equal(s.pendingColorUpdates.size, 0, 'with no lens active, an EMPTY map is what reaches clearColorOverrides()');
  });

  // Drift pin: this is the exact scenario of "a user isolation that REPLACED a
  // clash focus still survives run()" in `useClash.run-preserves-isolation.
  // test.tsx`, run through the OTHER release path. Both paths call the same
  // `releaseOwnedClashVisibility` over the same `clashVisibilityOwned` record —
  // there is no second record for them to disagree about — and this pair fails
  // the moment one of them grows its own answer.
  it('a user isolation that REPLACED a clash focus survives — ownership is content, not "clash installed something"', async () => {
    await seed();
    await act(async () => { api!.focusClash(CLASH, 'isolate'); });
    // The user takes the channel over with DIFFERENT content. The ownership
    // record still names `isolate`, but it no longer content-matches.
    useViewerStore.getState().isolateEntities([1]);

    useViewerStore.getState().removeModel('B');

    const s = useViewerStore.getState();
    assert.ok(s.isolatedEntities, 'the user isolation must still be standing');
    assert.deepEqual([...s.isolatedEntities], [1], 'and untouched');
  });
});
