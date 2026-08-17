/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A clash row must be clickable in a COLLABORATIVE session.
 *
 * The collab recipient's model is put into `state.models` by
 * `collabSlice.ts` through `upsertModel` (`room:<id>`, `idOffset: 0` — the
 * hydrated meshes are already in the reconstructed store's id space). That
 * path never calls `registerModelOffset`, so the model exists for the store
 * but not for the `federationRegistry` singleton.
 *
 * `useClash`'s `refOf` resolved a clash ref through the SINGLETON
 * (`fromGlobalId`), which answers `null` for a model it does not know — so
 * `focusClash` bailed at `refs.length === 0` and every row in the panel was
 * inert. Selection from the 3D view, by contrast, resolves through
 * `resolveGlobalIdFromModels` (the store-state resolver `resolveEntityRef`
 * documents as the single source of truth) and works fine on the same model:
 * two resolvers, one id space, different answers.
 *
 * Mounts the REAL `useClash()` hook over a REAL parsed model with real meshes,
 * registered exactly the way the collab room registers it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
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

/** The rule `runAll` builds: every element vs every other, hard clash. */
const ALL_RULE: ClashRule = { id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' };

const ROOM_MODEL_ID = 'room:demo-room';

// ─── Harness ────────────────────────────────────────────────────────────────

type ClashApi = ReturnType<typeof useClash>;

let api: ClashApi | null = null;

function Probe(): null {
  api = useClash();
  return null;
}

let root: Root | null = null;

/**
 * Seed the store the way a collab RECIPIENT is seeded: `upsertModel` with a
 * `room:*` id and `idOffset: 0`, and no `registerModelOffset` — verbatim the
 * shape of `collabSlice.ts`'s reconstruct (`get().upsertModel({ id:
 * roomModelId, ..., idOffset: 0, maxExpressId })`).
 */
async function seedRoom(): Promise<void> {
  const store = await parse(TWO_WALLS);
  // clearAllModels() also clears the federationRegistry singleton, so this test
  // starts from the "joined a room, loaded no local file" state.
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({
    clashResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
  });
  useViewerStore.getState().upsertModel({
    id: ROOM_MODEL_ID,
    name: 'Shared model',
    ifcDataStore: store,
    geometryResult: geometry([boxMesh(1, 0), boxMesh(2, 0.5)]),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: Date.now(),
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 2,
    loadState: 'complete',
  });
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
  useViewerStore.getState().clearAllModels();
});

describe('clash results are usable in a collaborative room', () => {
  it('setup sanity: the room model is in the store but NOT in the federation registry', async () => {
    await seedRoom();
    const s = useViewerStore.getState();
    assert.ok(s.models.has(ROOM_MODEL_ID), 'the room model must be a real store model');
    assert.equal(s.getModelOffset(ROOM_MODEL_ID), null,
      'the collab path never registers the room model with the federation registry');
    // The 3D-click path resolves the very same id space without trouble.
    assert.deepEqual(s.resolveGlobalIdFromModels(1), { modelId: ROOM_MODEL_ID, expressId: 1 },
      'the store-state resolver (3D selection) resolves room ids fine');
  });

  it('clicking a clash row FOCUSES the pair (it must not be inert)', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });

    const afterRun = useViewerStore.getState();
    assert.equal(afterRun.clashError, null, 'the run must complete in a room');
    const clash = afterRun.clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');

    await act(async () => { api!.focusClash(clash!, 'highlight'); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, clash!.id,
      'the clicked row must become the focused clash — focusClash bailed at refs.length === 0');
    assert.ok(s.clashHighlightColors && s.clashHighlightColors.size === 2,
      'both members of the pair must be painted the clash A/B colours');
  });

  it('isolating a clash row hides the rest of the room model', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });
    const clash = useViewerStore.getState().clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');

    await act(async () => { api!.focusClash(clash!, 'isolate'); });

    const isolated = useViewerStore.getState().isolatedEntities;
    assert.ok(isolated, 'the isolate focus mode must install an isolation set');
    assert.deepEqual([...isolated].sort(), [clash!.a.ref, clash!.b.ref].sort(),
      'exactly the clashing pair must be isolated');
  });

  /**
   * The room model's ids are RAW express ids (`idOffset: 0`), and a normally
   * loaded model registers at offset 0 too — so the two id ranges overlap.
   * Resolving a clash ref by searching offset ranges then answers with
   * whichever model the search reaches first; resolving it by the model the
   * ref was gathered FROM (`ClashElementRef.model`) cannot be wrong.
   *
   * This pins the resolver, not a reachability claim: it drives `highlightAll`
   * over a result whose refs name the room model while a registered model
   * covers the same numbers.
   */
  it('a ref resolves to the model it was gathered from, not another model with the same id range', async () => {
    await seedRoom();
    // A normally loaded model: registered (offset 0) AND in the store, its
    // range [0, 100] covering the room model's raw ids.
    const other = await parse(TWO_WALLS);
    useViewerStore.getState().registerModelOffset('A', 100);
    useViewerStore.getState().upsertModel({
      id: 'A',
      name: 'A.ifc',
      ifcDataStore: other,
      geometryResult: geometry([]),
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset: 0,
      maxExpressId: 100,
      loadState: 'complete',
    });
    assert.deepEqual(useViewerStore.getState().fromGlobalId(1), { modelId: 'A', expressId: 1 },
      'setup sanity: the registry claims the room model\'s ids for the registered model');

    await act(async () => { await api!.run([ALL_RULE]); });
    const clash = useViewerStore.getState().clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');
    assert.equal(clash!.a.model, ROOM_MODEL_ID, 'setup sanity: the pair was gathered from the room model');

    await act(async () => { api!.highlightAll(); });

    assert.equal(useViewerStore.getState().selectedEntity?.modelId, ROOM_MODEL_ID,
      'the highlighted element must belong to the room model that produced the clash');
  });

  it('Highlight all selects every clashing element in the room', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });
    await act(async () => { api!.highlightAll(); });

    const s = useViewerStore.getState();
    assert.ok(s.selectedEntityIds.size > 0,
      'every clashing element must be highlighted — highlightAll returned early on unresolved refs');
    assert.equal(s.selectedEntity?.modelId, ROOM_MODEL_ID,
      'the highlighted refs must resolve to the room model');
  });
});
