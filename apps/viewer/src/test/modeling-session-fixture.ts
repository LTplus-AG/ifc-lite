/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only seed for the modeling command tests: one parsed IFC4 model with a
 * single storey (#40, elevation 0) and an empty geometry result, loaded into
 * the singleton store with edit mode on — enough for `addWall` and friends.
 *
 * It also carries one imported wall (#50) whose body is a triangulated mesh —
 * the shape of the demo project's walls, which Split cannot cut — and one
 * imported beam (#80) extruded along a rotated solid position (#6233).
 *
 * Options (#6233): `unit` picks the file's length unit — the demo project is
 * millimetres, which is where authored elements failed to split (the in-store
 * builders write native units while Split works in metres); `storeyOffset`
 * (metres) moves the storey's placement off the model origin, like the demo
 * project's storey at (3, 3) m.
 */

import '@/lib/placement-edit.boot';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

export const MODEL_ID = 'ifc';
export const STOREY = 40;
/** The imported wall with a mesh (IfcTriangulatedFaceSet) body. */
export const MESH_WALL = 50;
/**
 * An imported beam laid out like AC20's `Unterzug-1`: a rectangle extrusion
 * whose solid position turns the extrusion onto local +Y, off a non-centred
 * profile. Its length does not run along the placement axis.
 */
export const ROTATED_BEAM = 80;

export interface ModelingSessionOptions {
  unit?: 'metre' | 'millimetre';
  storeyOffset?: [number, number];
}

function fixtureStep({ unit = 'metre', storeyOffset = [0, 0] }: ModelingSessionOptions): string {
  const prefix = unit === 'metre' ? '$' : '.MILLI.';
  const k = unit === 'metre' ? 1 : 1000;
  const [ox, oy] = storeyOffset.map((v) => v * k);
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
#31=IFCSIUNIT(*,.LENGTHUNIT.,${prefix},.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,$,$);
#43=IFCCARTESIANPOINT((${ox.toFixed(1)},${oy.toFixed(1)},0.));
#50=IFCWALL('3wdauVJT5Fx9drrREiDqA$',$,'mesh wall',$,$,#51,#60,$,$);
#51=IFCLOCALPLACEMENT(#41,#52);
#52=IFCAXIS2PLACEMENT3D(#53,#54,#55);
#53=IFCCARTESIANPOINT((0.,${5 * k}.,0.));
#54=IFCDIRECTION((0.,0.,1.));
#55=IFCDIRECTION((1.,0.,0.));
#56=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(${k}.,0.,0.),(0.,${k}.,0.)));
#57=IFCTRIANGULATEDFACESET(#56,$,$,((1,2,3)),$);
#58=IFCSHAPEREPRESENTATION(#20,'Body','Tessellation',(#57));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#58));
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,(#50,#80),#40);
#80=IFCBEAM('3tCgZT92j6fw8fXgwCL3Jm',$,'rotated beam',$,$,#81,#90,$,$);
#81=IFCLOCALPLACEMENT(#41,#82);
#82=IFCAXIS2PLACEMENT3D(#83,$,$);
#83=IFCCARTESIANPOINT((0.,0.,${2.5 * k}));
#84=IFCCARTESIANPOINT((${-0.12 * k},0.));
#85=IFCAXIS2PLACEMENT2D(#84,$);
#86=IFCRECTANGLEPROFILEDEF(.AREA.,$,#85,${0.24 * k},${0.2 * k});
#87=IFCAXIS2PLACEMENT3D(#22,#88,#89);
#88=IFCDIRECTION((0.,1.,0.));
#89=IFCDIRECTION((0.,0.,1.));
#91=IFCDIRECTION((0.,0.,1.));
#92=IFCEXTRUDEDAREASOLID(#86,#87,#91,${4 * k}.);
#93=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#92));
#90=IFCPRODUCTDEFINITIONSHAPE($,$,(#93));
ENDSEC;
END-ISO-10303-21;
`;
}

function emptyGeometry(): GeometryResult {
  return {
    meshes: [],
    totalTriangles: 0,
    totalVertices: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
}

export async function seedModelingSession(options: ModelingSessionOptions = {}): Promise<MutablePropertyView> {
  const bytes = new TextEncoder().encode(fixtureStep(options));
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = emptyGeometry();
  const model = { ...fixtureModel(MODEL_ID), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel;
  const view = new MutablePropertyView(dataStore.properties || null, MODEL_ID);
  useViewerStore.setState({
    ...fixtureModels(model),
    activeTool: 'select',
    editEnabled: true,
    workspaceMode: 'view',
    session: null,
    geometryResult: geometry,
    mutationViews: new Map([[MODEL_ID, view]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    removedNewEntities: new Map(),
    removedMeshes: new Map(),
    pendingMeshRemovals: null,
    geometryContentVersion: 0,
    mutationVersion: 0,
  });
  return view;
}
