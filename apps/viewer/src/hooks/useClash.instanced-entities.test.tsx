/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2865: `useClash` builds its clash elements from `model.geometryResult.meshes`
 * alone. That array excludes every entity whose geometry went fully
 * GPU-instanced — anything repeated `INSTANCE_MIN_OCCURRENCES` (8) or more
 * times in the wasm mesher (`rust/wasm-bindings/src/api/gpu_meshes/batch.rs`).
 * Doors, windows, columns, sprinklers, light fittings: exactly the repeated
 * components a clash run exists to catch, silently absent — no error, no
 * count discrepancy, the report just comes back short.
 *
 * This file drives the REAL `useClash().run()` against a model whose
 * `geometryResult.meshes` holds only a wall — the door that physically
 * penetrates it is reachable only through the renderer scene's GPU instance
 * buffers, exactly as an instanced-only entity is in production. It pins two
 * things:
 *
 *  1. The door PARTICIPATES at all (`gatherElements` must not silently drop
 *     it because it isn't in `meshes`).
 *  2. The wall/door penetration is actually REPORTED as a clash — the
 *     symptom in #2865 is not an error, it is a report that looks clean.
 *
 * The fix (`useClash.ts` `gatherElements`) reuses `withInstancedMeshes` —
 * the SAME helper the glTF/IFC5 export path (#2558/#2576) already uses to
 * restore instanced occurrences before a one-shot full-geometry read. It
 * materializes real triangles from `Scene.getAllInstancedMeshData()`, not an
 * AABB approximation, so a clash reported off an instanced entity carries the
 * same geometric exactness as one reported off a flat mesh.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createSyntheticDataStore, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { useClash } from './useClash.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WALL_GUID = '0wAll000X4xv5uCqZZG05x';
const DOOR_GUID = '0d00R000X4xv5uCqZZG05x';

const IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  `#1=IFCWALL('${WALL_GUID}',$,'Test Wall',$,$,$,$,$,.STANDARD.);`,
  // The door has NO void/fill relationship to the wall on purpose: this
  // fixture is about a straight body-vs-body penetration, not the
  // exclusion machinery `step.test.ts` and the federated-offset file
  // already cover.
  `#2=IFCDOOR('${DOOR_GUID}',$,'Repeated Door',$,$,$,$,$,$,$,$,$,$);`,
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
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 1, z: 1 } };
  const coordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: false,
  };
  return { meshes, totalTriangles: 12 * meshes.length, totalVertices: 8 * meshes.length, coordinateInfo };
}

const ALL_RULE: ClashRule = { id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' };

/** Install a fake global renderer whose scene reports `doorId` as fully
 *  GPU-instanced, materializing one occurrence overlapping the wall — exactly
 *  what a real renderer does for an entity that crossed the instancing
 *  threshold and so never made it into `geometryResult.meshes`. */
function setInstancedRenderer(doorId: number): void {
  const scene = {
    getAllInstancedMeshData: () => [boxMesh(doorId, 0.5, 'IfcDoor', `${doorId}:inst:0:0`)],
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

  // The wall is a normal flat mesh; the door is DELIBERATELY absent from
  // `meshes` — that omission is the bug's entire mechanism. It physically
  // overlaps the door occurrence the fake renderer reports.
  const wallMesh = boxMesh(1, 0, 'IfcWall');
  const models = new Map<string, FederatedModel>([
    [
      'A',
      {
        id: 'A',
        name: 'A.ifc',
        ifcDataStore: store,
        geometryResult: geometry([wallMesh]),
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

describe('useClash restores GPU-instanced entities absent from geometryResult.meshes (#2865)', () => {
  it('reports the wall/door penetration even though the door never appears in `meshes`', async () => {
    const doorId = 2;
    setInstancedRenderer(doorId);
    await seed(doorId);

    await act(async () => {
      await api!.run([ALL_RULE]);
    });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null, 'the run must not error');
    assert.ok(s.clashResult, 'the run must publish a result');

    const keys = s.clashResult!.clashes
      .flatMap((c) => [c.a.key, c.b.key])
      .sort();
    // The door's key carries the `occurrenceKey` suffix (`elementsFromStep`,
    // #2865/#1405): a GPU-instanced occurrence's durable identity must not
    // collapse onto its expressId's GlobalId alone, or a review/exclusion set
    // on one physical occurrence would silently cover every other one.
    assert.deepEqual(
      keys,
      [`${DOOR_GUID}:2:inst:0:0`, WALL_GUID].sort(),
      `the instanced door must take part in the clash it physically has with the wall; ` +
        `got clashes [${s.clashResult!.clashes.map((c) => `${c.a.key} x ${c.b.key}`).join(', ')}]`,
    );
  });

  it('is a no-op when nothing is instanced: an ordinary flat-mesh model is unaffected', async () => {
    // No fake renderer installed at all — `getGlobalRenderer()` returns null,
    // `withInstancedMeshes` must fall back to the flat meshes untouched.
    await seed(2);

    await act(async () => {
      await api!.run([ALL_RULE]);
    });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null, 'the run must not error');
    // The door was never in `meshes` and no renderer supplied it: only the
    // wall exists, so there is nothing for it to clash with.
    assert.deepEqual(s.clashResult!.clashes, []);
  });
});
