/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A real parsed model for Split-tool tests (#6233): one storey to author
 * into, plus one imported wall whose body is a triangulated mesh — the shape
 * of the demo project's walls, which the Split tool cannot cut.
 *
 * `storeyOffset` (metres) moves the storey's placement off the model origin,
 * like the demo project's storey at (3, 3) m.
 *
 * `unit` picks the file's length unit. The demo project is millimetres, and
 * that is where authored elements failed to split: the in-store builders
 * write native units while the Split tool works in metres.
 */

import '@/lib/placement-edit.boot';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from './store-fixture';

export const SPLIT_MODEL_ID = 'ifc';
export const SPLIT_STOREY = 40;
/** The imported wall with a mesh (IfcTriangulatedFaceSet) body. */
export const MESH_WALL = 50;

function splitFixtureStep(unit: 'metre' | 'millimetre', storeyOffset: [number, number]): string {
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
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,(#50),#40);
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

/** Parse the fixture and install it as the only, editable model. */
export async function seedSplitFixture(unit: 'metre' | 'millimetre', storeyOffset: [number, number] = [0, 0]): Promise<void> {
  const bytes = new TextEncoder().encode(splitFixtureStep(unit, storeyOffset));
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = emptyGeometry();
  const model = { ...fixtureModel(SPLIT_MODEL_ID), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model),
    editEnabled: true,
    geometryResult: geometry,
    mutationViews: new Map([[SPLIT_MODEL_ID, new MutablePropertyView(dataStore.properties || null, SPLIT_MODEL_ID)]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    removedNewEntities: new Map(),
    removedMeshes: new Map(),
    pendingMeshRemovals: null,
    geometryContentVersion: 0,
    mutationVersion: 0,
  });
}
