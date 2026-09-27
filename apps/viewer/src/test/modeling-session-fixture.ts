/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only seed for the modeling command tests: one parsed IFC4 model with a
 * single storey (#40, elevation 0) and an empty geometry result, loaded into
 * the singleton store with edit mode on — enough for `addWall` and friends.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

export const MODEL_ID = 'ifc';
export const STOREY = 40;

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

export async function seedModelingSession(): Promise<MutablePropertyView> {
  const bytes = new TextEncoder().encode(FIXTURE);
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
