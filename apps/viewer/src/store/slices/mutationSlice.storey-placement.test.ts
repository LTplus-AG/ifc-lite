/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

const MODEL = 'storey-placement';
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
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,$,$,$,.ELEMENT.,0.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;
`;

async function seed(): Promise<MutablePropertyView> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(dataStore.properties || null, MODEL);
  const geometry = {
    meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
  const model = { ...fixtureModel(MODEL), ifcDataStore: dataStore, geometryResult: geometry } as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model), geometryResult: geometry,
    mutationViews: new Map([[MODEL, view]]), storeEditors: new Map(),
    undoStacks: new Map(), redoStacks: new Map(),
    geometryContentVersion: 0, mutationVersion: 0,
  });
  return view;
}

it('reuses a storey placement created by the first addWall (#5249)', async () => {
  const view = await seed();
  const first = useViewerStore.getState().addWall(MODEL, STOREY, {
    Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3,
  });
  assert.ok('expressId' in first, `first wall failed: ${'error' in first ? first.error : ''}`);
  const firstPlacement = view.getPositionalMutationsForEntity(STOREY)?.get(5);
  assert.match(String(firstPlacement), /^#\d+$/);

  const second = useViewerStore.getState().addWall(MODEL, STOREY, {
    Start: [0, 5, 0], End: [4, 5, 0], Thickness: 0.2, Height: 3,
  });
  assert.ok('expressId' in second, `second wall failed: ${'error' in second ? second.error : ''}`);
  assert.equal(view.getPositionalMutationsForEntity(STOREY)?.get(5), firstPlacement,
    'a second add must retain the existing live storey placement');
});
