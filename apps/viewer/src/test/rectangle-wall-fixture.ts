/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One editable rectangle-profile wall, written in either file length unit
 * (#6233): placed at (2, 1, 0) m, 4 m long along +X, 0.2 m thick, 3 m high,
 * parsed for real and seeded as model `ifc` with Edit mode on and the
 * loader's tessellated mesh (x-extent 2..6 m) in its geometry.
 */

import '@/lib/placement-edit.boot'; // the app's source-attribute reader for placement chains
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';

export const WALL = 50;
export const WALL_MODEL = 'ifc';

export const WALL_UNITS = [
  { name: 'metre', unit: 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', scale: 1 },
  { name: 'millimetre', unit: 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)', scale: 1000 },
] as const;

function stepFile(unit: string, s: number): string {
  return `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=${unit};
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#50=IFCWALL('3cUkl32yn9qRSPvBJVyWYp',$,'W',$,$,#51,#80,$,.STANDARD.);
#51=IFCLOCALPLACEMENT(#41,#52);
#52=IFCAXIS2PLACEMENT3D(#53,#54,#55);
#53=IFCCARTESIANPOINT((${2 * s}.,${1 * s}.,0.));
#54=IFCDIRECTION((0.,0.,1.));
#55=IFCDIRECTION((1.,0.,0.));
#60=IFCRELCONTAINEDINSPATIALSTRUCTURE('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,(#50),#40);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#80=IFCPRODUCTDEFINITIONSHAPE($,$,(#81));
#81=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#82));
#82=IFCEXTRUDEDAREASOLID(#83,#86,#88,${3 * s}.);
#83=IFCRECTANGLEPROFILEDEF(.AREA.,$,#84,${4 * s}.,${0.2 * s});
#84=IFCAXIS2PLACEMENT2D(#85,$);
#85=IFCCARTESIANPOINT((${2 * s}.,0.));
#86=IFCAXIS2PLACEMENT3D(#22,$,$);
#88=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
`;
}

function geometryResult(): GeometryResult {
  return {
    meshes: [{ expressId: WALL, positions: new Float32Array([2, 0, 0, 6, 0, 0, 6, 3, 0, 2, 3, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [1, 1, 1, 1] } as MeshData],
    totalTriangles: 2,
    totalVertices: 4,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 2, y: 0, z: 0 }, max: { x: 6, y: 3, z: 0 } },
      hasLargeCoordinates: false,
      // Meshed by the wasm path on load, so edits re-mesh in this frame (#6232).
      wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } },
  } as unknown as GeometryResult;
}

/** Seed the store with the wall written in `unit` (`scale` native units per metre). */
export async function seedRectangleWall(unit: string, scale: number): Promise<void> {
  const bytes = new TextEncoder().encode(stepFile(unit, scale));
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = geometryResult();
  const model = { ...fixtureModel(WALL_MODEL), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model),
    editEnabled: true,
    geometryResult: geometry,
    modelPlacement: emptyPlacementState(),
    mutationViews: new Map([[WALL_MODEL, new MutablePropertyView(dataStore.properties || null, WALL_MODEL)]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    pendingMeshRemovals: null,
    pendingMeshEdits: null,
  });
}
