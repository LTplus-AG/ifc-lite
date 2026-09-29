/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232: an added element has a mesh whatever the wasm re-mesh answers. One
 * case per way the re-mesh can decline (each refusal reason, a failed or timed
 * out worker, an empty answer), then undo / redo and the room mirror. A
 * scripted mesher stands in for the worker (`@/test/scripted-mesher`).
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { installScriptedMesher, settleRemesh } from '@/test/scripted-mesher';

const MODEL = 'ifc';
const STOREY = 40;
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;
`;
const WALL = { Start: [0, 0, 0] as [number, number, number], End: [4, 0, 0] as [number, number, number], Thickness: 0.2, Height: 3 };

let mesher: ReturnType<typeof installScriptedMesher>;
let mirrored: Array<[number, readonly MeshData[]]>;
let dataStore: IfcDataStore;

async function seed(opts: { frame?: boolean; model?: Partial<FederatedModel>; existing?: MeshData[]; fixture?: string } = {}): Promise<void> {
  const bytes = new TextEncoder().encode(opts.fixture ?? FIXTURE);
  dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = {
    meshes: opts.existing ?? [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
      ...(opts.frame === false ? {} : { wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } }),
    },
  } as unknown as GeometryResult;
  mirrored = [];
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel(MODEL), ifcDataStore: dataStore, geometryResult: geometry, ...opts.model } as unknown as FederatedModel),
    editEnabled: true,
    geometryResult: geometry,
    mutationViews: new Map([[MODEL, new MutablePropertyView(dataStore.properties || null, MODEL)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    removedNewEntities: new Map(), removedMeshes: new Map(),
    pendingMeshRemovals: null, pendingMeshEdits: null, mutationVersion: 0,
    mirrorEntityGeometry: (_modelId, entityId, meshes) => { mirrored.push([entityId, [...meshes]]); },
  });
}

const meshesOf = (id: number) => (useViewerStore.getState().models.get(MODEL)?.geometryResult?.meshes ?? []).filter((m) => m.expressId === id);

/** Add a wall and wait for its mesh; returns its id. */
async function addWall(): Promise<number> {
  const wall = useViewerStore.getState().addWall(MODEL, STOREY, WALL);
  assert.ok('expressId' in wall, 'error' in wall ? wall.error : 'no id');
  await settleRemesh();
  await settleRemesh();
  return wall.expressId;
}

/** The parameter-built wall: a 4 m box, 24 vertices, drawn where the wall is. */
function assertFallbackWall(id: number): void {
  const meshes = meshesOf(id);
  assert.equal(meshes.length, 1, 'the added wall has a mesh');
  assert.equal(meshes[0].positions.length / 3, 24, 'it is the parameter-built box');
  assert.deepEqual(mirrored.map(([entityId, sent]) => [entityId, sent[0]]), [[id, meshes[0]]], 'and the room got that same mesh');
}

describe('an added element has a mesh when the wasm re-mesh declines (#6232)', () => {
  beforeEach(() => { mesher = installScriptedMesher(); });
  afterEach(() => mesher.restore());

  it('noSource: an IFCX-sourced model is drawn from the parameters', async () => {
    await seed();
    (dataStore as { schemaVersion: string }).schemaVersion = 'IFC5';
    assertFallbackWall(await addWall());
    assert.equal(mesher.requests.length, 0, 'nothing was sent to the worker');
  });

  it('noFrame: a model loaded without the wasm frame is drawn from the parameters', async () => {
    await seed({ frame: false });
    assertFallbackWall(await addWall());
    assert.equal(mesher.requests.length, 0);
  });

  it('alignment: an aligned model whose frame cannot be matched is drawn from the parameters', async () => {
    await seed({ model: { federationAlignmentStatus: 'same-crs' } as Partial<FederatedModel> });
    assertFallbackWall(await addWall());
    assert.equal(mesher.requests.length, 1, 'the worker meshed it, the frame step declined');
  });

  it('unreadable: context the subgraph cannot write faithfully is drawn from the parameters', async () => {
    // The context's argument list does not scan (one closing paren too many),
    // and it carries a pending edit, so the subgraph cannot place that edit.
    await seed({ fixture: FIXTURE.replace("3,1.E-05,#21,$);", "3,1.E-05,#21,$));") });
    useViewerStore.getState().mutationViews.get(MODEL)!.setAttribute(20, 'ContextIdentifier', 'Body');
    const id = await addWall();
    assert.equal(mesher.requests.length, 0, 'nothing was sent to the worker');
    assertFallbackWall(id);
  });

  it('a failed or timed-out worker leaves the wall drawn from the parameters', async () => {
    await seed();
    mesher.restore();
    mesher = installScriptedMesher(() => { throw new Error('Re-mesh worker did not answer within 10000 ms'); });
    assertFallbackWall(await addWall());
  });

  it('an empty answer leaves the wall drawn from the parameters', async () => {
    await seed();
    mesher.restore();
    mesher = installScriptedMesher(() => []);
    assertFallbackWall(await addWall());
  });

  it('colourMerged: a colour-merged model re-meshes the new element through wasm, it is not refused', async () => {
    const merged = { expressId: 5, ifcType: 'IfcWall', positions: new Float32Array(9), normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1], entityIds: new Uint32Array([5, 6, 6]) } as MeshData;
    await seed({ existing: [merged] });
    const id = await addWall();
    assert.equal(mesher.requests.length, 1);
    assert.equal(meshesOf(id)[0]?.positions.length, 9, 'the wasm answer, not the box');
    assert.equal(meshesOf(5)[0], merged, 'the merged mesh is untouched');
  });

  it('the fallback survives undo and redo, and so does the room', async () => {
    await seed({ frame: false });
    const id = await addWall();
    const drawn = [...meshesOf(id)[0].positions];
    useViewerStore.getState().undo(MODEL);
    assert.equal(meshesOf(id).length, 0, 'undo removes it');
    mirrored = [];
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    assert.deepEqual([...meshesOf(id)[0].positions], drawn, 'redo brings back the same mesh');
    assert.deepEqual(mirrored.map(([entityId, sent]) => [entityId, sent.length]), [[id, 1]], 'and sends it to the room again');
  });

  it('an add undone before its mesh landed is drawn on redo', async () => {
    await seed({ frame: false });
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, WALL);
    assert.ok('expressId' in wall);
    useViewerStore.getState().undo(MODEL);
    await settleRemesh();
    assert.equal(meshesOf(wall.expressId).length, 0, 'the undone wall is not drawn late');
    mirrored = [];
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    await settleRemesh();
    assertFallbackWall(wall.expressId);
  });
});

// #6232 M2.2: the fallback is drawn from what the BUILDER writes. A column
// turned through its RefDirection falls back turned, and a beam or member,
// whose section the builder centres on Start-End, falls back centred there
// (not standing on the axis half a height too high).
describe('the parameter fallback matches the builder (#6232 M2.2)', () => {
  beforeEach(() => { mesher = installScriptedMesher(() => []); });
  afterEach(() => mesher.restore());

  /** Plan corners (IFC x, y) and the height span of a fallback mesh; renderer is Y-up with z = -ifc y. */
  const shape = (id: number) => {
    const [mesh] = meshesOf(id);
    assert.ok(mesh, 'the fallback drew it');
    const plan = new Set<string>(); const ys: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      plan.add(`${+mesh.positions[i].toFixed(4)},${+(-mesh.positions[i + 2]).toFixed(4)}`);
      ys.push(mesh.positions[i + 1]);
    }
    return { plan: [...plan].sort(), y: [+Math.min(...ys).toFixed(4), +Math.max(...ys).toFixed(4)] };
  };

  it('a column with RefDirection +y falls back with its Width along y', async () => {
    await seed();
    const c = useViewerStore.getState().addColumn(MODEL, STOREY, { Position: [0, 0, 0], Width: 0.8, Depth: 0.2, Height: 3, RefDirection: [0, 1, 0] });
    assert.ok('expressId' in c);
    await settleRemesh(); await settleRemesh();
    assert.deepEqual(shape(c.expressId).plan, ['-0.1,-0.4', '-0.1,0.4', '0.1,-0.4', '0.1,0.4']);
  });

  for (const kind of ['beam', 'member'] as const) {
    it(`a ${kind} falls back centred on its axis`, async () => {
      await seed();
      const s = useViewerStore.getState();
      const params = { Start: [0, 0, 2] as [number, number, number], End: [4, 0, 2] as [number, number, number], Width: 0.3, Height: 0.5 };
      const made = kind === 'beam' ? s.addBeam(MODEL, STOREY, params) : s.addMember(MODEL, STOREY, params);
      assert.ok('expressId' in made);
      await settleRemesh(); await settleRemesh();
      assert.deepEqual(shape(made.expressId).y, [1.75, 2.25]);
    });

    // `addBeam`/`addMember` are typed for the rectangle, but the builders
    // take a `Profile` (#6232 A5), and untyped callers (scripts) pass one.
    it(`a profiled ${kind} falls back as its section's bounding box`, async () => {
      await seed();
      const s = useViewerStore.getState();
      const params = {
        Start: [0, 0, 2] as [number, number, number], End: [4, 0, 2] as [number, number, number],
        Profile: { Type: 'I' as const, OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 },
      } as unknown as Parameters<typeof s.addBeam>[2];
      const made = kind === 'beam' ? s.addBeam(MODEL, STOREY, params) : s.addMember(MODEL, STOREY, params);
      assert.ok('expressId' in made, 'error' in made ? made.error : 'no id');
      await settleRemesh(); await settleRemesh();
      const { plan, y } = shape(made.expressId);
      assert.deepEqual(y, [1.8, 2.2], 'OverallDepth 0.4, centred on the axis');
      assert.deepEqual(plan, ['0,-0.1', '0,0.1', '4,-0.1', '4,0.1'], 'OverallWidth 0.2 across the axis');
    });
  }

  it('a profiled column falls back as its section\'s bounding box', async () => {
    await seed();
    const s = useViewerStore.getState();
    const c = s.addColumn(MODEL, STOREY, {
      Position: [0, 0, 0], Height: 3, Profile: { Type: 'CircleHollow', Radius: 0.15, WallThickness: 0.01 },
    } as unknown as Parameters<typeof s.addColumn>[2]);
    assert.ok('expressId' in c, 'error' in c ? c.error : 'no id');
    await settleRemesh(); await settleRemesh();
    assert.deepEqual(shape(c.expressId).plan, ['-0.15,-0.15', '-0.15,0.15', '0.15,-0.15', '0.15,0.15']);
  });
});
