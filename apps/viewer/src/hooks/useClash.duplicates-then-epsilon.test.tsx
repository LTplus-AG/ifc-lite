/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for the "two writers, one grouping" defect found in review of
 * #2535 (`87e4f94ab`, PR comment 5305847983).
 *
 * `runDuplicates` calls `state.setClashResult(res)` before
 * `state.setClashGroups(sets)`, so after a duplicate scan `clashRawResult`
 * holds the duplicate scan's OWN pairwise result — not `null`. Both
 * `setClashClusterEpsilon` and any exclusion edit re-derive `clashGroups`
 * from `clashRawResult` via `deriveFromExclusions`, which silently replaces
 * the coincident-SET grouping (`groupDuplicateSets`) with a spatial-cluster
 * grouping over the SAME duplicate pairs — no new scan, and the panel's
 * "stale grouping -> degrade to pairwise list" guard in
 * `duplicate-set-sections.ts` never fires because the wrongly-derived groups
 * still cover every clash id. It mislabels instead of degrading.
 *
 * The fix must survive BOTH triggers: a cluster-epsilon change and an
 * unrelated exclusion edit, neither of which runs a new scan.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { typePairExclusion } from '@/lib/clash/exclusions';
import { useClash } from './useClash.js';

// ─── Fixture: two coincident walls, meshed as unit boxes ───

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

// ─── Harness ────────────────────────────────────────────────────────────

let runDuplicates: (() => Promise<void>) | null = null;

function Probe(): null {
  runDuplicates = useClash().runDuplicates;
  return null;
}

let root: Root | null = null;

async function seed(): Promise<void> {
  const store = await parse(TWO_WALLS);
  useViewerStore.setState({
    models: new Map([['A', model(store, [boxMesh(1, 0), boxMesh(2, 0)])]]), // exactly coincident
    clashResult: null,
    clashRawResult: null,
    clashGroups: null,
    clashExclusions: [],
    clashClusterEpsilon: 1.5,
    clashError: null,
    clashRunning: false,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

async function run(): Promise<void> {
  assert.ok(runDuplicates, 'runDuplicates must be mounted');
  await act(async () => {
    await runDuplicates!();
  });
}

beforeEach(() => {
  runDuplicates = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

describe('useClash.runDuplicates then a no-new-run derivation (review of #2535)', () => {
  it('keeps the coincident-set title after setClashClusterEpsilon (no new scan)', async () => {
    await seed();
    await run();
    const before = useViewerStore.getState();
    assert.equal(before.clashGroups?.[0]?.title, '2 coincident IfcWall objects');

    before.setClashClusterEpsilon(2);

    const after = useViewerStore.getState();
    assert.equal(
      after.clashGroups?.[0]?.title,
      '2 coincident IfcWall objects',
      'a cluster-epsilon change must not silently re-derive spatial clusters over a duplicate-set grouping',
    );
  });

  it('keeps the coincident-set title after an unrelated exclusion edit (no new scan)', async () => {
    await seed();
    await run();
    const before = useViewerStore.getState();
    assert.equal(before.clashGroups?.[0]?.title, '2 coincident IfcWall objects');

    before.addClashExclusion(typePairExclusion('IfcDoor', 'IfcWindow'));

    const after = useViewerStore.getState();
    assert.equal(
      after.clashGroups?.[0]?.title,
      '2 coincident IfcWall objects',
      'an unrelated exclusion edit must not silently re-derive spatial clusters over a duplicate-set grouping',
    );
  });
});
