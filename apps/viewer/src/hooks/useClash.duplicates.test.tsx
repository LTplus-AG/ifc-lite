/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useClash.runDuplicates` wiring (#2530 review: the viewer side of the
 * duplicate stack shipped untested).
 *
 * Two things must hold end-to-end, over a real parsed model and real meshes:
 * - the run publishes the coincident-SET grouping into `clashGroups` — the
 *   state the panel's duplicate sections render from — alongside the pairwise
 *   `clashResult`;
 * - the duplicate scan obeys the store's `clashDuplicateTolerance`, the knob
 *   Clash settings expose; before #2530 the scan always ran at the library
 *   default and no viewer control could loosen it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { useClash } from './useClash.js';

// ─── Fixture: two walls, meshed as unit boxes a configurable offset apart ───

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

// ─── Harness ────────────────────────────────────────────────────────────

let runDuplicates: (() => Promise<void>) | null = null;

function Probe(): null {
  runDuplicates = useClash().runDuplicates;
  return null;
}

let root: Root | null = null;

async function seed(offsetMetres: number): Promise<void> {
  const store = await parse(TWO_WALLS);
  useViewerStore.setState({
    models: new Map([['A', model(store, [boxMesh(1, 0), boxMesh(2, offsetMetres)])]]),
    clashResult: null,
    clashGroups: null,
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

describe('useClash.runDuplicates (#2530)', () => {
  it('publishes the coincident-set grouping the panel sections render from', async () => {
    await seed(0); // exactly coincident
    await run();
    const s = useViewerStore.getState();
    assert.equal(s.clashError, null);
    assert.ok(s.clashResult, 'pairwise result published');
    assert.equal(s.clashResult.clashes.length, 1);
    assert.ok(s.clashGroups, 'coincident-set grouping published');
    assert.equal(s.clashGroups.length, 1);
    assert.equal(s.clashGroups[0].title, '2 coincident IfcWall objects');
    assert.equal(s.clashGroups[0].members.length, 1);
  });

  it('obeys the clashDuplicateTolerance setting', async () => {
    await seed(0.015); // 15 mm apart: outside the 10 mm default
    await run();
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 0);

    useViewerStore.getState().setClashDuplicateTolerance(0.03);
    await run();
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 1);

    // Back to the default: the pair drops out again, so the assertion above
    // really was the knob and not a stale result.
    useViewerStore.getState().setClashDuplicateTolerance(0.01);
    await run();
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 0);
  });
});
