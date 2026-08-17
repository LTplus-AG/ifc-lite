/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `gatherElements` must hand `elementsFromStep` the offset the LOADER already
 * applied to `mesh.expressId`.
 *
 * `useIfcLoader` shifts every `mesh.expressId` into the federated global id
 * space in place (`mesh.expressId = mesh.expressId + idOffset`) while the
 * model's `ifcDataStore` keeps LOCAL express ids. For every federated model
 * past the first — the only ones with a non-zero `idOffset` — addressing the
 * store with `mesh.expressId` misses on every lookup.
 *
 * ## Why this file exists
 *
 * The adapter half of that fix (`meshIdOffset` on `elementsFromStep`) is pinned
 * in `packages/clash/src/adapters/step.test.ts`, but those tests pass a literal
 * `meshIdOffset` themselves, so they cannot see whether the VIEWER passes one.
 * Deleting `meshIdOffset: model.idOffset ?? 0` from `useClash.gatherElements` —
 * reverting the entire viewer half and restoring the exact defect — left the
 * clash package green, all 20 viewer clash test files green (119/119), and
 * `tsc` clean, because `meshIdOffset?: number` defaults to `0`. The one viewer
 * test that reached `gatherElements` seeded `idOffset: 0`, the single value that
 * hides the bug.
 *
 * So this file seeds a federation whose SECOND model has a real non-zero offset
 * and pre-shifted mesh ids, exactly as the loader leaves it, and drives the real
 * `useClash().run()`.
 *
 * ## What actually dies without the wiring, and what does not
 *
 * `tag` is NOT a reliable discriminator here, contrary to what a store-only
 * reading suggests: `elementsFromStep` computes `node.type || mesh.ifcType ||
 * 'IfcProduct'`, and the viewer's `MeshData` carries a correct `ifcType`, so a
 * missed store lookup still reads `IfcWall` off the mesh. The signals that do
 * die are asserted below:
 *
 *  - `key` degrades from the durable IfcGUID to the synthetic `expressid:N` —
 *    the key every review state and user exclusion rule is stored against;
 *  - `name` comes back empty;
 *  - `ref` gets the offset applied TWICE (`toGlobalId` adds it again to an id
 *    that was never reduced), so it addresses nothing the renderer knows;
 *  - `buildStepExclusions` walks the same relationship graph with the same
 *    unusable ids and finds NOTHING, so the void/host exclusions silently stop
 *    excluding — a door in the opening it fills is reported as a hard clash.
 *
 * That last one is the user-visible harm and it is what the clash-count
 * assertion pins.
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
import { useClash } from './useClash.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const HOST_WALL_GUID = '0h0sTW4LLX4xv5uCqZZG05';
const FED_WALL_GUID = '0fEdW4LLX4xv5uCqZZG05x';
const FED_DOOR_GUID = '0fEdD00RX4xv5uCqZZG05x';

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

/** The FIRST model of the federation: one plain wall, nothing related to it. */
const HOST_BODY = `#1=IFCWALL('${HOST_WALL_GUID}',$,'Host Wall',$,$,$,$,$,.STANDARD.);`;

/**
 * The SECOND model: a wall hosting an opening that a door fills, both contained
 * in a storey. The wall/door pair is precisely the void/host exclusion the
 * engine must honour — and precisely what stops being honoured when the
 * relationship walk is handed global ids.
 */
const FEDERATED_BODY = [
  "#1=IFCBUILDINGSTOREY('0fEdSt0YX4xv5uCqZZG05x',$,'Level 3',$,$,$,$,$,.ELEMENT.,9.);",
  `#2=IFCWALL('${FED_WALL_GUID}',$,'Federated Wall',$,$,$,$,$,.STANDARD.);`,
  "#3=IFCOPENINGELEMENT('0fEd0pENX4xv5uCqZZG05x',$,'Door Opening',$,$,$,$,$,$);",
  `#4=IFCDOOR('${FED_DOOR_GUID}',$,'Federated Door',$,$,$,$,$,$,$,$,$,$);`,
  "#5=IFCRELVOIDSELEMENT('1v01d00AX4xv5uCqZZG05x',$,$,$,#2,#3);",
  "#6=IFCRELFILLSELEMENT('1f1LLs0AX4xv5uCqZZG05x',$,$,$,#3,#4);",
  "#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('1c0nt40AX4xv5uCqZZG05x',$,$,$,(#2,#4),#1);",
].join('\n');

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A unit box (12 triangles) spanning `[dx, dx + 1]` on x, `[0, 1]` on y and z. */
function boxMesh(expressId: number, dx: number, ifcType: string): MeshData {
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
  return {
    meshes,
    totalTriangles: 12 * meshes.length,
    totalVertices: 8 * meshes.length,
    coordinateInfo,
  };
}

function model(
  id: string,
  store: IfcDataStore,
  meshes: MeshData[],
  idOffset: number,
  maxExpressId: number,
): FederatedModel {
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
    idOffset,
    maxExpressId,
  };
}

const ALL_RULE: ClashRule = { id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' };

/** Room for a realistic offset: model B lands at 1_000_000. */
const MODEL_RANGE = 999_999;

// ─── Harness ────────────────────────────────────────────────────────────────

type ClashApi = ReturnType<typeof useClash>;

let api: ClashApi | null = null;

function Probe(): null {
  api = useClash();
  return null;
}

let root: Root | null = null;

/**
 * Seed the two-model federation the loader would produce, and mount the REAL
 * hook. Returns model B's registered offset and its LOCAL wall/door ids.
 *
 * Layout on x, chosen so exactly one cross-model overlap exists and the
 * intra-B wall/door overlap is the only other candidate:
 *
 *   host wall  [0.0, 1.0]
 *   fed wall   [0.5, 1.5]   overlaps the host wall  → one legitimate clash
 *   fed door   [1.2, 2.2]   overlaps the fed wall   → excluded (voids/fills)
 *                           clear of the host wall by 0.2m → no hard clash
 */
async function seedFederation(): Promise<{ offset: number; wallId: number; doorId: number }> {
  // `registerModelOffset` resolves through the `federationRegistry` SINGLETON,
  // which outlives a test. Clearing the models clears the registry with it, so
  // model A really registers at 0 and model B really lands past it.
  useViewerStore.getState().clearAllModels();

  const hostStore = await parse(HOST_BODY);
  const fedStore = await parse(FEDERATED_BODY);

  const wallId = (fedStore.entityIndex.byType.get('IFCWALL') ?? [])[0];
  const doorId = (fedStore.entityIndex.byType.get('IFCDOOR') ?? [])[0];
  assert.ok(wallId > 0 && doorId > 0, 'fixture sanity: the federated wall and door must parse');

  const hostOffset = useViewerStore.getState().registerModelOffset('A', MODEL_RANGE);
  const offset = useViewerStore.getState().registerModelOffset('B', MODEL_RANGE);
  assert.equal(hostOffset, 0, 'setup sanity: the FIRST model always registers at offset 0');
  assert.ok(offset > 0, 'setup sanity: the SECOND model must get a non-zero offset — the whole point');

  const models = new Map<string, FederatedModel>([
    ['A', model('A', hostStore, [boxMesh(1, 0, 'IfcWall')], hostOffset, MODEL_RANGE)],
    [
      'B',
      model(
        'B',
        fedStore,
        // As `useIfcLoader` leaves them: SHIFTED into the global id space, while
        // `fedStore` above stays local. This is the state under test.
        [boxMesh(wallId + offset, 0.5, 'IfcWall'), boxMesh(doorId + offset, 1.2, 'IfcDoor')],
        offset,
        MODEL_RANGE,
      ),
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
  return { offset, wallId, doorId };
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

// ─── The tests ──────────────────────────────────────────────────────────────

describe('useClash gathers a federated model past the first with the offset the loader applied', () => {
  it('resolves the DURABLE key, name and ref for a model whose meshes are already shifted', async () => {
    const { offset, wallId } = await seedFederation();

    await act(async () => {
      await api!.run([ALL_RULE]);
    });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null, 'the run must not error');
    assert.ok(s.clashResult, 'the run must publish a result');

    const fedRefs = s.clashResult!.clashes
      .flatMap((c) => [c.a, c.b])
      .filter((r) => r.model === 'B');
    assert.ok(fedRefs.length > 0, 'setup sanity: the second model must take part in a clash at all');

    for (const ref of fedRefs) {
      assert.ok(
        !ref.key.startsWith('expressid:'),
        `the federated element fell back to the synthetic key "${ref.key}": ` +
          'gatherElements addressed the LOCAL store with a GLOBAL mesh id',
      );
    }

    const wall = fedRefs.find((r) => r.key === FED_WALL_GUID);
    assert.ok(wall, `the federated wall must carry its real IfcGUID ${FED_WALL_GUID}`);
    assert.equal(wall!.name, 'Federated Wall', 'the stored Name must resolve, not come back empty');
    // Applied exactly ONCE: the ref IS the mesh id the renderer and the
    // selection channel already address this element by. Double-offsetting puts
    // it past every registered range, where `fromGlobalId` returns null and the
    // panel row is inert.
    assert.equal(wall!.ref, wallId + offset, 'the federation offset must be applied exactly once');
    assert.notEqual(wall!.ref, wallId + 2 * offset, 'the double-offset defect');
  });

  it('honours the federated model\'s void/host exclusions: a door in its opening is not a clash', async () => {
    await seedFederation();

    await act(async () => {
      await api!.run([ALL_RULE]);
    });

    const s = useViewerStore.getState();
    assert.equal(s.clashError, null, 'the run must not error');
    const clashes = s.clashResult!.clashes;

    const intraB = clashes.filter((c) => c.a.model === 'B' && c.b.model === 'B');
    assert.deepEqual(
      intraB.map((c) => `${c.a.key} x ${c.b.key}`),
      [],
      'the door fills an opening in that wall, so IfcRelVoids/IfcRelFills must exclude the pair — ' +
        'an empty exclusion set means buildStepExclusions was handed unusable ids',
    );

    // The GREEN half: the exclusion must not have swallowed the real clash too.
    const crossModel = clashes.filter((c) => c.a.model !== c.b.model);
    assert.equal(crossModel.length, 1, 'the host wall and the federated wall really do overlap');
    const keys = [crossModel[0].a.key, crossModel[0].b.key].sort();
    assert.deepEqual(keys, [HOST_WALL_GUID, FED_WALL_GUID].sort(), 'both sides keep their durable key');
  });
});
