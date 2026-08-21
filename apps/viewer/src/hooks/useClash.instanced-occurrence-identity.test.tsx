/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for the CodeRabbit review thread on PR #2878
 * (apps/viewer/src/hooks/useClash.ts, "Cache gathered geometry by occurrence
 * identity"): `gatherElements` restores GPU-instanced occurrences via
 * `withInstancedMeshes` (#2865), and `elementsFromStep` gives each physical
 * occurrence of one expressId its own `key` (folding in `mesh.occurrenceKey`)
 * but the SAME `ref` (`ref` is the bare expressId / federated globalId,
 * shared across every occurrence — see `packages/clash/src/adapters/step.ts`).
 *
 * `focusClash` used to cache gathered geometry in `elementsByRef`, keyed by
 * that shared `ref`. With two instanced occurrences of one entity, the second
 * insertion silently overwrote the first in the map, so `focusClash` on the
 * clash belonging to the FIRST occurrence built its contact interface from
 * the SECOND occurrence's geometry instead — wrong contact lines / wrong
 * intersection-solid input for a real, producible scene (any instanced entity
 * with 8+ repeats that clashes more than once).
 *
 * This test seeds two separate walls, each physically overlapping a
 * DIFFERENT occurrence of one GPU-instanced door (same expressId, distinct
 * `occurrenceKey` and world position), runs detection, and focuses the clash
 * belonging to the FIRST occurrence. It asserts the synchronous contact-line
 * overlay `focusClash` paints is anchored at the FIRST occurrence's actual
 * overlap location, not the second's — the two are far enough apart (10
 * units) that using the wrong occurrence's geometry produces no real contact
 * (the two meshes do not intersect at all) and the overlay silently degrades
 * to null instead of real contact geometry.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Clash, ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { useClash } from './useClash.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WALL_A_GUID = '0wAllA00X4xv5uCqZZG05x';
const WALL_B_GUID = '0wAllB00X4xv5uCqZZG05x';
const DOOR_GUID = '0d00R000X4xv5uCqZZG05x';

const IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  `#1=IFCWALL('${WALL_A_GUID}',$,'Wall A',$,$,$,$,$,.STANDARD.);`,
  `#2=IFCWALL('${WALL_B_GUID}',$,'Wall B',$,$,$,$,$,.STANDARD.);`,
  `#3=IFCDOOR('${DOOR_GUID}',$,'Repeated Door',$,$,$,$,$,$,$,$,$,$);`,
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

async function parseStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A unit box (12 triangles) spanning `[dx, dx + 1]` on x, `[0, 1]` on y and z. */
function boxMesh(expressId: number, dx: number, ifcType: string, occurrenceKey?: string): MeshData {
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
    ifcType,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
    ...(occurrenceKey ? { occurrenceKey } : {}),
  };
}

function geometry(meshes: MeshData[]): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 12, y: 1, z: 1 } };
  const coordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: false,
  };
  return { meshes, totalTriangles: 12 * meshes.length, totalVertices: 8 * meshes.length, coordinateInfo };
}

const ALL_RULE: ClashRule = { id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' };

/** Two occurrences of ONE expressId (same `ref`), at far-apart world
 *  positions, each overlapping a different wall — exactly what a real GPU-
 *  instanced entity with 8+ repeats produces when more than one repeat
 *  happens to clash. */
function setInstancedRenderer(doorId: number): void {
  const scene = {
    getAllInstancedMeshData: () => [
      boxMesh(doorId, 0.5, 'IfcDoor', `${doorId}:inst:0:0`), // overlaps Wall A (dx=0)
      boxMesh(doorId, 10.5, 'IfcDoor', `${doorId}:inst:0:1`), // overlaps Wall B (dx=10)
    ],
  };
  const fake = { getScene: () => scene } as unknown as Renderer;
  setGlobalRendererRef({ current: fake } as RefObject<Renderer | null>);
}

type ClashApi = ReturnType<typeof useClash>;
let api: ClashApi | null = null;
function Probe(): null {
  api = useClash();
  return null;
}
let root: Root | null = null;

async function seed(doorId: number): Promise<void> {
  useViewerStore.getState().clearAllModels();
  const store = await parseStore();
  const offset = useViewerStore.getState().registerModelOffset('A', 999_999);
  assert.equal(offset, 0, 'setup sanity: the sole/primary model registers at offset 0');

  const wallA = boxMesh(1, 0, 'IfcWall');
  const wallB = boxMesh(2, 10, 'IfcWall');
  const models = new Map<string, FederatedModel>([
    [
      'A',
      {
        id: 'A',
        name: 'A.ifc',
        ifcDataStore: store,
        geometryResult: geometry([wallA, wallB]),
        visible: true,
        collapsed: false,
        schemaVersion: 'IFC4',
        loadedAt: 0,
        fileSize: 0,
        idOffset: offset,
        maxExpressId: 999_999,
      },
    ],
  ]);

  useViewerStore.setState({
    models,
    activeModelId: 'A',
    clashResult: null,
    clashRawResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
    clashContactLines: null,
    clashOverlapBox: null,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'useClash must be mounted');
  void doorId;
}

beforeEach(() => {
  api = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.getState().clearAllModels();
  setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
});

describe('useClash caches gathered geometry by occurrence identity, not by shared ref (PR #2878 review)', () => {
  it('focusClash on the FIRST occurrence\'s clash builds contact geometry from its own occurrence, not the second one\'s', async () => {
    const doorId = 3;
    setInstancedRenderer(doorId);
    await seed(doorId);

    await act(async () => {
      await api!.run([ALL_RULE]);
    });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null, 'the run must not error');
    assert.ok(s.clashResult, 'the run must publish a result');

    const clashes = s.clashResult!.clashes;
    assert.equal(clashes.length, 2, `expected one clash per wall/door-occurrence pair, got ${clashes.length}`);

    // The clash whose pair includes Wall A's key — this is the FIRST occurrence
    // (`:inst:0:0`, overlapping Wall A at dx=0.5) in insertion order.
    const clashA = clashes.find((c) => c.a.key === WALL_A_GUID || c.b.key === WALL_A_GUID);
    assert.ok(clashA, 'a clash between Wall A and its overlapping door occurrence must exist');
    const doorRefInClashA = (clashA!.a.key === WALL_A_GUID ? clashA!.b : clashA!.a);
    assert.equal(
      doorRefInClashA.key,
      `${DOOR_GUID}:${doorId}:inst:0:0`,
      'sanity: Wall A must clash with the FIRST door occurrence\'s key',
    );

    await act(async () => {
      api!.focusClash(clashA as Clash, 'highlight');
    });

    const after = useViewerStore.getState();
    // Wall A (dx=0..1) and the FIRST door occurrence (dx=0.5..1.5) genuinely
    // overlap, so the real contact geometry must be resolvable. If the cache
    // instead handed back the SECOND occurrence (dx=10.5..11.5, ~9.5 units
    // away with no overlap at all), `contactClusters` finds nothing and the
    // overlay silently degrades to `null` instead of real contact lines —
    // exactly the symptom the shared-`ref` cache collision produces.
    assert.ok(
      after.clashContactLines && after.clashContactLines.vertices.length >= 6,
      'focusClash must resolve real contact geometry from the FIRST occurrence\'s own mesh, ' +
        `got clashContactLines=${JSON.stringify(after.clashContactLines)}`,
    );
  });
});
