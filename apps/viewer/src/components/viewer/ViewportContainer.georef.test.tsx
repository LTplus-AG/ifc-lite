/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { advance, cleanup, mouseDown, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { usePlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { PlacementPanel } from './placement/PlacementPanel.js';
import { ViewportContainer } from './ViewportContainer.js';

// #6569 / #6572: metadata is available independently of map/solar visibility.
// Small IFC input reproduces the reporter's Allplan map conversion. To rerun
// the same UI oracle against the full attachment, set PLACEMENT_GEOREF_IFC to
// the downloaded https://github.com/user-attachments/files/32858853/ifc.txt.
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('georef.ifc','2026-09-30T00:00:00',(),(),'test','test','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000000',$,'Georef test',$,$,$,$,(#59),#2);
#2=IFCUNITASSIGNMENT((#62));
#59=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#63,$);
#63=IFCAXIS2PLACEMENT3D(#64,$,$);
#64=IFCCARTESIANPOINT((0.,0.,0.));
#60=IFCMAPCONVERSION(#59,#61,2619073.0368,1263523.6017,0.,$,$,$);
#61=IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95','CH1903+','EPSG:5728',$,$,#62);
#62=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;`;

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
const geometry: GeometryResult = {
  meshes: [{ expressId: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.5, 0.5, 1],
  }], totalTriangles: 1, totalVertices: 3,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds,
    shiftedBounds: bounds, hasLargeCoordinates: false,
  },
};

function ContextReadout() {
  const context = usePlacementGeorefContext();
  return <output data-testid="georef-context">{context ? JSON.stringify({
    modelId: context.modelId, crs: context.projectedCRS?.name,
    eastings: context.mapConversion.eastings,
    baseEastings: context.baseMapConversion.eastings,
  }) : 'absent'}</output>;
}

afterEach(cleanup);

for (const count of [0, 1, 2]) {
  it(`#6569 preserves placement context with Map off (${count || 'legacy'} models)`, async () => {
    const bytes = process.env.PLACEMENT_GEOREF_IFC
      ? new Uint8Array(readFileSync(process.env.PLACEMENT_GEOREF_IFC))
      : new TextEncoder().encode(source);
    const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {});
    const anchor = { ...fixtureModel('anchor'), ifcDataStore: dataStore, geometryResult: geometry };
    const models = count === 2 ? [{ ...fixtureModel('other'), ifcDataStore: undefined }, anchor] : count === 1 ? [anchor] : [];
    useViewerStore.setState({
      ...fixtureModels(...models), ifcDataStore: count === 0 ? dataStore : null,
      geometryResult: geometry, cesiumEnabled: false, solarEnabled: false,
      cesiumPlacementEditMode: false, cesiumPlacementDraft: null,
      cesiumPlacementDraftModelId: null, georefMutations: new Map(),
      anchorModelIdOverride: null, repositionOpen: false,
    });
    const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
    Object.defineProperty(navigator, 'gpu', { configurable: true,
      value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) },
    });
    try {
      const viewport = render(<ViewportContainer />);
      const readout = render(<ContextReadout />);
      const panel = render(<PlacementPanel />);
      await advance(10);
      const tab = panel.querySelector('[role="tab"][data-state="inactive"]');
      assert.ok(tab, 'Georeference tab is available');
      mouseDown(tab, { button: 0 });
      assert.match(panel.textContent ?? '', /Drag the plane and height handle/, 'georeference controls shown with Map off');
      assert.doesNotMatch(panel.textContent ?? '', /No georeferenced model/i);
      assert.equal(readout.textContent, JSON.stringify({
        modelId: count === 0 ? '__legacy__' : 'anchor', crs: 'EPSG:2056',
        eastings: 2619073.0368, baseEastings: 2619073.0368,
      }));
      assert.equal(viewport.querySelector('[aria-label="Drag Eastings and Northings"]'), null,
        'no visual gizmo while editing is disabled');
      // A map-off rerender must retain the published panel context.
      act(() => useViewerStore.setState({ solarEnabled: true }));
      act(() => useViewerStore.setState({ solarEnabled: false }));
      assert.match(panel.textContent ?? '', /Drag the plane and height handle/);
      // Removing the last georeferenced model clears the external context.
      act(() => useViewerStore.setState({ models: new Map(), ifcDataStore: null, geometryResult: null }));
      assert.equal(readout.textContent, 'absent');
      assert.match(panel.textContent ?? '', /No georeferenced model/i);
    } finally {
      cleanup();
      if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
      else Reflect.deleteProperty(navigator, 'gpu');
    }
  });
}
