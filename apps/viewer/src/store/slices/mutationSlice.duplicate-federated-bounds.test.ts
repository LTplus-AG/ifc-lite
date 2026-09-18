/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `duplicateEntity` must size the offset from the SOURCE element's own bounds,
 * even when the edited model is not the active one (#4929).
 *
 * The action resolved the source's globalId against its own model — correctly —
 * and then looked that globalId up in the top-level `geometryResult`, which
 * mirrors the ACTIVE model. Picking in 3D does not call `setActiveModel`, so
 * editing a non-active federated model is the ordinary case, and there the
 * lookup searched a different model's meshes: bounds came back null, the offset
 * silently collapsed to `DUPLICATE_FALLBACK_STEP` (1 m on every axis), and the
 * mesh mirror that makes the copy visible found nothing to clone.
 *
 * WHY THE FIXTURE COLLIDES ON A GLOBALID. Every case here puts a mesh under the
 * wall's OWN globalId in the top-level mirror too, at a deliberately different
 * size (9 m vs the wall's 4 m). Without that collision a naive "prefer the
 * model's own meshes, otherwise take the mirror" would pass every assertion,
 * because the mirror would simply hold nothing under that id — the suite would
 * pin the bug but not the fix. With it, three answers are distinguishable:
 * 4 m (the element's own bounds), 9 m (a different model's element read under
 * the same id), and 1 m (`DUPLICATE_FALLBACK_STEP`, i.e. no bounds at all).
 * That is what separates `meshesForOwningModel`'s `activeModelId` gate from an
 * unconditional fallback, and it is the behaviour the yaw-edit and collab-mirror
 * call sites share.
 *
 * These go through `duplicateEntity` rather than importing
 * `store/owningModelMeshes.ts` directly ON PURPOSE: the revert oracle reverts
 * this PR's production files, which DELETES that new module, and one changed
 * test file that cannot load is `REVERT_BROKE_BUILD` for the whole run
 * (`scripts/lib/revert-oracle-ledger.mjs:104`). Entering through an export that
 * survives the revert keeps the witness an assertion, and pins the call sites
 * rather than just the helper.
 */

// FIRST import, before `@/store`: `useViewerStore` is constructed at module
// load, and `createChartSlice` / `createDocumentSlice` read `localStorage`
// while doing so. Without browser globals that read throws
// `ReferenceError: localStorage is not defined` into the runner output, which
// the revert oracle's `LOAD_ERROR_PATTERNS` (correctly, in general) reads as
// "the module never loaded, so no assertion ran" — masking this suite's real
// assertion failures under revert as a build failure. Same reason
// `environmentSlice.test.ts` and eleven other store suites import it here.
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';

/** The model the edit is made in. */
const EDITED = 'edited';
const EDITED_OFFSET = 1000;
/** A second loaded model, used as the active one. */
const OTHER = 'other';

const WALL = 50;
const WALL_GLOBAL = WALL + EDITED_OFFSET;
/** The wall's own mesh: 4 m along X. Its IFC placement is (2, 1, 0). */
const WALL_SIZE_X = 4;
const WALL_ORIGIN_X = 2;
/** The mirror's decoy mesh under the SAME globalId: a different size. */
const MIRROR_SIZE_X = 9;
/** `DUPLICATE_FALLBACK_STEP` — what a bounds-less duplicate steps by. */
const FALLBACK_STEP = 1;

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
#50=IFCWALL('3cUkl32yn9qRSPvBJVyWYp',$,'W',$,$,#51,$,$,.STANDARD.);
#51=IFCLOCALPLACEMENT(#41,#52);
#52=IFCAXIS2PLACEMENT3D(#53,$,$);
#53=IFCCARTESIANPOINT((2.,1.,0.));
#60=IFCRELCONTAINEDINSPATIALSTRUCTURE('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,(#50),#40);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;
`;

/** One quad, `sizeX` m along X and 3 m along viewer Y, at origin x = 2. */
function meshFor(expressId: number, sizeX: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, sizeX, 0, 0, sizeX, 3, 0, 0, 3, 0.2]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
    origin: [WALL_ORIGIN_X, 0, -1],
  } as MeshData;
}

function geometryOf(meshes: MeshData[]): GeometryResult {
  return {
    meshes,
    totalTriangles: 2 * meshes.length,
    totalVertices: 4 * meshes.length,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 2, y: 0, z: -1 }, max: { x: 12, y: 3, z: -0.8 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
}

interface Arrangement {
  /** Which loaded model is the active one — i.e. which one the mirror mirrors. */
  active: 'edited' | 'other';
  /** Does the edited model carry its own geometry, with the wall's real mesh? */
  ownGeometry: boolean;
  /** Load only the edited model (legacy single-model shape). */
  singleModel?: boolean;
}

/**
 * Seed the store for one arrangement. The top-level `geometryResult` is always
 * the ACTIVE model's geometry, as every writer in `dataSlice` / `modelSlice`
 * leaves it, and it always contains the `MIRROR_SIZE_X` decoy under
 * `WALL_GLOBAL`.
 */
async function seed(arrangement: Arrangement): Promise<void> {
  modelRotationBaker.clear();
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {
    disableWorkerScan: true,
  });

  const decoy = geometryOf([meshFor(WALL_GLOBAL, MIRROR_SIZE_X)]);
  const edited = {
    ...fixtureModel(EDITED, { idOffset: EDITED_OFFSET }),
    ifcDataStore: dataStore,
    geometryResult: arrangement.ownGeometry
      ? geometryOf([meshFor(WALL_GLOBAL, WALL_SIZE_X)])
      : null,
    maxExpressId: 100,
  } as unknown as FederatedModel;
  const other = {
    ...fixtureModel(OTHER),
    geometryResult: decoy,
  } as unknown as FederatedModel;

  // `fixtureModels` makes its FIRST argument active.
  const federation = arrangement.singleModel
    ? fixtureModels(edited)
    : arrangement.active === 'edited'
      ? fixtureModels(edited, other)
      : fixtureModels(other, edited);

  useViewerStore.setState({
    ...federation,
    // The mirror is the active model's geometry. When the edited model is
    // active and has none of its own, that is the decoy — which is exactly the
    // legacy shape the mirror fallback exists for.
    geometryResult: arrangement.active === 'edited' || arrangement.singleModel
      ? (edited.geometryResult ?? decoy)
      : decoy,
    modelPlacement: emptyPlacementState(),
    mutationViews: new Map([
      [EDITED, new MutablePropertyView(dataStore.properties || null, EDITED)],
    ]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    geometryContentVersion: 0,
  });

  const expectedActive = arrangement.singleModel || arrangement.active === 'edited' ? EDITED : OTHER;
  assert.equal(useViewerStore.getState().activeModelId, expectedActive, 'fixture arrangement');
}

/**
 * Duplicate the wall along +X and return the X of the copy's IFC placement.
 * The source sits at x = 2, so the step is `result - 2`.
 */
function duplicateAlongX(): { placementX: number; globalId: number } {
  const result = useViewerStore.getState().duplicateEntity(EDITED, WALL, '+X');
  assert.ok(!('error' in result), `duplicate failed: ${'error' in result ? result.error : ''}`);
  const points = useViewerStore
    .getState()
    .mutationViews.get(EDITED)!
    .getNewEntities()
    .filter((e) => e.type === 'IfcCartesianPoint')
    .map((e) => e.attributes[0] as number[]);
  assert.equal(points.length, 1, `expected one new placement point, got ${points.length}`);
  return { placementX: points[0][0], globalId: result.globalId };
}

function assertStep(placementX: number, expectedStep: number, what: string): void {
  assert.ok(
    Math.abs(placementX - (WALL_ORIGIN_X + expectedStep)) < 1e-4,
    `${what}: stepped ${placementX - WALL_ORIGIN_X} m, expected ${expectedStep} m`,
  );
}

describe('duplicateEntity reads bounds from the element\'s own model (#4929)', () => {
  it('uses the element\'s own bounds when its model is loaded but not active', async () => {
    await seed({ active: 'other', ownGeometry: true });
    const { placementX } = duplicateAlongX();
    assertStep(placementX, WALL_SIZE_X, 'non-active model with its own geometry');
    assert.notEqual(placementX, WALL_ORIGIN_X + MIRROR_SIZE_X, 'read the active mirror instead');
    assert.notEqual(placementX, WALL_ORIGIN_X + FALLBACK_STEP, 'collapsed to the fallback step');
  });

  // The case an unconditional `own ?? mirror` gets wrong: no own geometry and a
  // colliding globalId in the mirror means the mirror would answer with a
  // DIFFERENT element's bounds. No bounds is the only honest answer, and the
  // fallback step is what the caller does with it.
  it('refuses the active model\'s mirror for a non-active model with no geometry of its own', async () => {
    await seed({ active: 'other', ownGeometry: false });
    const { placementX } = duplicateAlongX();
    assert.notEqual(
      placementX,
      WALL_ORIGIN_X + MIRROR_SIZE_X,
      'took bounds from the active model\'s element under the same globalId',
    );
    assertStep(placementX, FALLBACK_STEP, 'non-active model with no geometry');
  });

  // The other half of the gate: for the model the mirror ACTUALLY mirrors, the
  // mirror is the right answer. Legacy and geometry-first stores populate only
  // the top-level slot, and this is the path that keeps them working.
  it('falls back to the mirror for the active model when it has no geometry of its own', async () => {
    await seed({ active: 'edited', ownGeometry: false });
    const { placementX } = duplicateAlongX();
    assertStep(placementX, MIRROR_SIZE_X, 'active model via the mirror');
  });

  it('is unchanged in single-model mode, where the only model is the active one', async () => {
    await seed({ active: 'edited', ownGeometry: false, singleModel: true });
    assert.equal(useViewerStore.getState().models.size, 1, 'single-model fixture');
    const { placementX } = duplicateAlongX();
    assertStep(placementX, MIRROR_SIZE_X, 'single model via the mirror');
  });
});

describe('the duplicate\'s mesh lands in the edited model (#4929)', () => {
  it('offsets the copy mesh by the source element size, not the fallback step', async () => {
    await seed({ active: 'other', ownGeometry: true });
    const { globalId } = duplicateAlongX();

    const meshes = useViewerStore.getState().models.get(EDITED)!.geometryResult!.meshes;
    const source = meshes.find((m) => m.expressId === WALL_GLOBAL);
    const copy = meshes.find((m) => m.expressId === globalId);
    assert.ok(source, 'source mesh missing from the edited model');
    assert.ok(copy, 'the duplicate got no mesh: its bounds were looked up in the wrong model');

    const deltaX = (copy.origin?.[0] ?? 0) - (source.origin?.[0] ?? 0);
    assert.notEqual(deltaX, FALLBACK_STEP, 'offset collapsed to DUPLICATE_FALLBACK_STEP');
    assert.ok(
      Math.abs(deltaX - WALL_SIZE_X) < 1e-4,
      `copy offset ${deltaX} m, expected the wall's own ${WALL_SIZE_X} m`,
    );
  });

  it('leaves the active model\'s geometry untouched', async () => {
    await seed({ active: 'other', ownGeometry: true });
    const before = useViewerStore.getState().models.get(OTHER)!.geometryResult!.meshes.length;
    duplicateAlongX();
    assert.equal(
      useViewerStore.getState().models.get(OTHER)!.geometryResult!.meshes.length,
      before,
      'the copy landed in the active model instead of the edited one',
    );
  });
});
