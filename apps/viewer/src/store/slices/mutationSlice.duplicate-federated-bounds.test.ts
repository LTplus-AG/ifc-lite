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
 * The fixture makes the two answers unmistakable: the wall is 4 m along IFC X,
 * so a bounds-correct `+X` duplicate lands 4 m away and a fallback one lands
 * 1 m away. The active model carries geometry of its own at a DIFFERENT
 * globalId, exactly as a real federation does.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';

/** The edited (non-active) model and its id offset. */
const EDITED = 'edited';
const EDITED_OFFSET = 1000;
/** The active model, whose geometry the buggy lookup reached for. */
const ACTIVE = 'active';

const WALL = 50;
const WALL_GLOBAL = WALL + EDITED_OFFSET;
/** The wall mesh spans 4 m on X and 3 m on viewer Y; the fallback step is 1 m. */
const WALL_SIZE_X = 4;
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

function meshFor(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, WALL_SIZE_X, 0, 0, WALL_SIZE_X, 3, 0, 0, 3, 0.2]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
    origin: [2, 0, -1],
  } as MeshData;
}

function geometryFor(expressId: number): GeometryResult {
  return {
    meshes: [meshFor(expressId)],
    totalTriangles: 2,
    totalVertices: 4,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 2, y: 0, z: -1 }, max: { x: 6, y: 3, z: -0.8 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
}

async function seed(): Promise<void> {
  modelRotationBaker.clear();
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {
    disableWorkerScan: true,
  });
  const activeGeometry = geometryFor(7);
  // `fixtureModels` makes its FIRST argument active, so the active model is not
  // the one being edited — the federated arrangement the bug needs.
  const active = {
    ...fixtureModel(ACTIVE),
    geometryResult: activeGeometry,
  } as unknown as FederatedModel;
  const edited = {
    ...fixtureModel(EDITED, { idOffset: EDITED_OFFSET }),
    ifcDataStore: dataStore,
    geometryResult: geometryFor(WALL_GLOBAL),
    maxExpressId: 100,
  } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(active, edited),
    // The top-level mirror is the ACTIVE model's geometry, as the loader leaves it.
    geometryResult: activeGeometry,
    modelPlacement: emptyPlacementState(),
    mutationViews: new Map([
      [EDITED, new MutablePropertyView(dataStore.properties || null, EDITED)],
    ]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    geometryContentVersion: 0,
  });
  assert.equal(useViewerStore.getState().activeModelId, ACTIVE, 'fixture must edit a non-active model');
}

describe('duplicateEntity in a non-active federated model (#4929)', () => {
  beforeEach(seed);

  it('writes the copy\'s IFC placement one source-length along +X', () => {
    const result = useViewerStore.getState().duplicateEntity(EDITED, WALL, '+X');
    assert.ok(!('error' in result), `duplicate failed: ${'error' in result ? result.error : ''}`);

    // The overlay's new IFCCARTESIANPOINT is the duplicate's placement: the
    // source sits at (2, 1, 0), so a bounds-correct +X step puts it at 2 + 4.
    const points = useViewerStore
      .getState()
      .mutationViews.get(EDITED)!
      .getNewEntities()
      .filter((e) => e.type === 'IfcCartesianPoint')
      .map((e) => e.attributes[0] as number[]);
    assert.equal(points.length, 1, `expected one new placement point, got ${points.length}`);
    assert.ok(
      Math.abs(points[0][0] - (2 + WALL_SIZE_X)) < 1e-4,
      `placement X ${points[0][0]}, expected ${2 + WALL_SIZE_X} (${2 + FALLBACK_STEP} means the bounds lookup missed)`,
    );
  });

  it('offsets the copy mesh by the source element size, not the fallback step', () => {
    const result = useViewerStore.getState().duplicateEntity(EDITED, WALL, '+X');
    assert.ok(!('error' in result), `duplicate failed: ${'error' in result ? result.error : ''}`);

    const meshes = useViewerStore.getState().models.get(EDITED)!.geometryResult!.meshes;
    const source = meshes.find((m) => m.expressId === WALL_GLOBAL);
    const copy = meshes.find((m) => m.expressId === result.globalId);
    assert.ok(source, 'source mesh missing from the edited model');
    assert.ok(copy, 'the duplicate got no mesh: its bounds were looked up in the wrong model');

    const deltaX = (copy.origin?.[0] ?? 0) - (source.origin?.[0] ?? 0);
    assert.notEqual(deltaX, FALLBACK_STEP, 'offset collapsed to DUPLICATE_FALLBACK_STEP');
    assert.ok(
      Math.abs(deltaX - WALL_SIZE_X) < 1e-4,
      `copy offset ${deltaX} m, expected the wall's own ${WALL_SIZE_X} m`,
    );
  });

  it('leaves the active model\'s geometry untouched', () => {
    const before = useViewerStore.getState().models.get(ACTIVE)!.geometryResult!.meshes.length;
    const result = useViewerStore.getState().duplicateEntity(EDITED, WALL, '+X');
    assert.ok(!('error' in result), `duplicate failed: ${'error' in result ? result.error : ''}`);
    assert.equal(
      useViewerStore.getState().models.get(ACTIVE)!.geometryResult!.meshes.length,
      before,
      'the copy landed in the active model instead of the edited one',
    );
  });
});
