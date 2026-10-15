/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7605: a LandXML of the 844 terrain, federated onto
 * `issues/844_terrain_and_alignment.ifc`, was refused with only "LandXML
 * federation preflight rejected every render component". Neither file
 * declares a vertical datum, so the spatial resolver (fail-closed by design)
 * does not align the TIN, which then sits at its EPSG:31467 map coordinates,
 * 5,516 km from the IFC's engineering origin. The refusal is correct; these
 * tests pin that it now names the missing declarations, and that declaring
 * them is enough for the same TIN to land on the IFC terrain.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ModelSpatialReference } from '@ifc-lite/geometry';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { FederationRegistry } from '@ifc-lite/renderer';
import type { FederatedModel } from '../../store/index.js';
import { useViewerStore } from '../../store/index.js';
import { fixtureModel } from '../../test/store-fixture.js';
import { FederatedLandXmlStreamingPlan } from './federatedLandXmlStreaming.js';
import { reframeLandXmlGeometry } from './landXmlLoad.js';
import { parseLandXmlViewerModelFromBlobAsync } from './landXmlViewerModel.js';

const FIXTURE_844 = fileURLToPath(new URL('../../../../../tests/models/issues/844_terrain_and_alignment.ifc', import.meta.url));

/** The georeference records of the 844 fixture, verbatim apart from `verticalDatum`. */
function ifc844Georeference(verticalDatum: string | null, georeferenced = true): string {
  const georeference = georeferenced ? `#17=IFCPROJECTEDCRS('EPSG:31467','EPSG:31467 - DHDN / 3-Degree Gauss-Krueger Zone 3','EPSG:31467',${verticalDatum === null ? '$' : `'${verticalDatum}'`},'Gauss-Krueger','3',#18);
#18=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#21=IFCMAPCONVERSION(#22,#17,3513037.9591000000946,5516199.0738000003621,0.00000000000000000000,$,$,$);
` : '';
  return `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#7=IFCPROJECT('3C4yI51mbCwBupmPsfWDC8',$,'IfcAlignment Project',$,$,$,$,(#22),#8);
#8=IFCUNITASSIGNMENT((#9));
#9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#13=IFCCARTESIANPOINT((0.,0.,0.));
#14=IFCAXIS2PLACEMENT3D(#13,$,$);
${georeference}#22=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,$,#14,$);
ENDSEC;
END-ISO-10303-21;
`;
}

/**
 * Two triangles of the 844 TIN as an independent IfcOpenShell-based producer
 * wrote them: northing, easting, elevation in EPSG:31467. Point 1 is the
 * fixture's first `#24` vertex (-199.346, -111.675, 126.135) through `#21`.
 */
function landXml844(coordinateSystem: string, eastingShift = 0): string {
  const easting = (value: number): string => (value + eastingShift).toFixed(4);
  return `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" elevationUnit="meter"/></Units>
  ${coordinateSystem}
  <Surfaces><Surface name="Terrain"><Definition surfType="TIN"><Pnts>
    <P id="1">5516087.3988 ${easting(3512838.6131)} 126.135</P><P id="2">5516088.4348 ${easting(3512838.3931)} 126.112</P>
    <P id="3">5516088.2588 ${easting(3512839.5811)} 126.283</P><P id="4">5516080.6108 ${easting(3512842.3481)} 126.345</P>
    <P id="5">5516080.0308 ${easting(3512842.5581)} 126.326</P><P id="6">5516080.5868 ${easting(3512842.2611)} 126.344</P>
  </Pnts><Faces><F>1 3 2</F><F>4 6 5</F></Faces></Definition></Surface></Surfaces>
</LandXML>`;
}

/** What each producer writes for this IFC: the reference producer, ifc-lite's #7600 writer, and a completed declaration. */
const NAME_ONLY = '<CoordinateSystem name="EPSG:31467"/>';
const EPSG_CODE_ONLY = '<CoordinateSystem name="EPSG:31467" epsgCode="31467" horizontalDatum="EPSG:31467"/>';
const WITH_VERTICAL = '<CoordinateSystem name="EPSG:31467" epsgCode="31467" verticalDatum="EPSG:5783"/>';

async function parseIfc(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** Install the IFC as the loaded, georeferenced anchor exactly as `findReferenceSpatialModel` reads one. */
function installAnchor(dataStore: IfcDataStore, verticalDatumEdit?: string): void {
  const anchor = fixtureModel('ifc-844') as FederatedModel;
  anchor.loadedAt = 0;
  anchor.ifcDataStore = dataStore;
  anchor.geometryResult = {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: -200, y: 117, z: -100 }, max: { x: 100, y: 128, z: 112 } },
      shiftedBounds: { min: { x: -200, y: 117, z: -100 }, max: { x: 100, y: 128, z: 112 } },
      hasLargeCoordinates: false,
    },
  };
  useViewerStore.setState({
    models: new Map([[anchor.id, anchor]]),
    ...(verticalDatumEdit ? { georefMutations: new Map([[anchor.id, { projectedCRS: { verticalDatum: verticalDatumEdit } }]]) } : {}),
  });
}

/** Run the worker-less federated cursor (preflight, measure, freeze, admit, freezeAdmission, publish). */
async function federate(xml: string): Promise<FederatedLandXmlStreamingPlan> {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  const plan = { value: null as FederatedLandXmlStreamingPlan | null };
  try {
    const model = await parseLandXmlViewerModelFromBlobAsync(
      new Blob([xml]), () => true, undefined, undefined,
      async (mesh) => { await plan.value?.publish(mesh); },
      (preflight, sourceCoordinateInfo, spatialReference, declaredCrs) => {
        plan.value = new FederatedLandXmlStreamingPlan({
          modelId: 'terrain-844', componentCount: preflight.componentCount, sourceCoordinateInfo, spatialReference, declaredCrs,
          registry: new FederationRegistry(), resources: { publish: () => {}, remove: () => {} }, isCurrent: () => true,
        });
        return true;
      },
      (component) => plan.value?.measure(component.mesh),
      () => plan.value?.freeze(),
      (component) => plan.value?.admit(component),
      () => plan.value?.freezeAdmission(),
    );
    plan.value!.complete(model.geometryResult);
    return plan.value!;
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
}

afterEach(() => useViewerStore.setState({ models: new Map(), georefMutations: new Map() }));

/** The 844 anchor as the IFC adapter records it (`spatialReferenceFromIfc`): no VerticalDatum. */
function ifcAnchorReference(): ModelSpatialReference {
  return {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: 'EPSG:31467' },
    localToProjected: {
      kind: 'local-projected-affine', eastings: 3513037.9591, northings: 5516199.0738, orthogonalHeight: 0,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    confidence: 'declared',
    sourceMetadata: { format: 'ifc' },
  };
}

describe('LandXML federation frame refusal (#7605)', () => {
  for (const [producer, coordinateSystem, landXmlBlocker] of [
    ['an IfcOpenShell-based producer (CoordinateSystem name only)', NAME_ONLY,
      'this LandXML declares no horizontal CRS (CoordinateSystem epsgCode, or an EPSG:<n> horizontalDatum) and no vertical datum'],
    ['the #7600 writer (epsgCode, no verticalDatum)', EPSG_CODE_ONLY,
      'this LandXML declares no vertical datum (CoordinateSystem verticalDatum, as EPSG:<n>)'],
  ] as const) {
    it(`names the missing datums when the 844 TIN from ${producer} meets its IFC4X1 anchor`, async () => {
      installAnchor(await parseIfc(ifc844Georeference(null)));
      await assert.rejects(federate(landXml844(coordinateSystem)), (error: Error) => {
        assert.match(error.message, /^LandXML federation preflight rejected every render component: /);
        assert.match(error.message, /lie up to 5,516 km from the shared render origin, outside the 1,000 km shared render-frame envelope/);
        assert.ok(error.message.includes(`It was not aligned to the anchor's EPSG:31467 because ${landXmlBlocker}`), error.message);
        assert.ok(error.message.includes('the anchor declares no vertical datum (IfcProjectedCRS.VerticalDatum)'), error.message);
        return true;
      });
    });
  }

  it('names only the anchor when the LandXML is complete but the IFC has no VerticalDatum', async () => {
    installAnchor(await parseIfc(ifc844Georeference(null)));
    await assert.rejects(federate(landXml844(WITH_VERTICAL)), (error: Error) => {
      assert.ok(error.message.endsWith("It was not aligned to the anchor's EPSG:31467 because the anchor declares no vertical datum "
        + '(IfcProjectedCRS.VerticalDatum); its coordinates were kept as authored.'), error.message);
      return true;
    });
  });

  it('names a vertical datum mismatch instead of a missing declaration', async () => {
    installAnchor(await parseIfc(ifc844Georeference('EPSG:7837')));
    await assert.rejects(federate(landXml844(WITH_VERTICAL)), (error: Error) => {
      assert.ok(error.message.endsWith("It was not aligned to the anchor's EPSG:31467 because the vertical datums differ "
        + '(EPSG:5783 here, EPSG:7837 on the anchor); its coordinates were kept as authored.'), error.message);
      return true;
    });
  });

  it('says so when no loaded model is georeferenced', async () => {
    installAnchor(await parseIfc(ifc844Georeference(null, false)));
    await assert.rejects(federate(landXml844(WITH_VERTICAL)), (error: Error) => {
      assert.match(error.message, /lie up to 5,516 km from the shared render origin/);
      assert.ok(error.message.endsWith('It was not aligned because none of the loaded models is georeferenced, '
        + 'so there is no map frame to place it in; its coordinates were kept as authored.'), error.message);
      return true;
    });
  });

  it('does not blame a declaration when an aligned surface is genuinely that far away', async () => {
    installAnchor(await parseIfc(ifc844Georeference('EPSG:5783')));
    await assert.rejects(federate(landXml844(WITH_VERTICAL, 2_000_000)), (error: Error) => {
      assert.match(error.message, /lie up to 2,000 km from the shared render origin, outside the 1,000 km shared render-frame envelope\./);
      assert.ok(error.message.endsWith("It was aligned to the anchor's EPSG:31467, so the surfaces are that far from the anchor model."), error.message);
      return true;
    });
  });

  it('raises the same refusal on the whole-document reframe path', async () => {
    const originalWorker = globalThis.Worker;
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
    try {
      const model = await parseLandXmlViewerModelFromBlobAsync(new Blob([landXml844(EPSG_CODE_ONLY)]));
      const ifcFrame = {
        originShift: { x: 0, y: 0, z: 0 },
        originalBounds: { min: { x: -200, y: 117, z: -100 }, max: { x: 100, y: 128, z: 112 } },
        shiftedBounds: { min: { x: -200, y: 117, z: -100 }, max: { x: 100, y: 128, z: 112 } },
        hasLargeCoordinates: false,
      };
      assert.throws(
        () => reframeLandXmlGeometry(model.geometryResult, model.semanticDocument, ifcFrame, { anchor: ifcAnchorReference(), aligned: false }),
        (error: Error) => {
          assert.match(error.message, /^LandXML federation preflight rejected every render component: its surfaces lie up to 5,516 km /);
          assert.ok(error.message.includes("It was not aligned to the anchor's EPSG:31467 because this LandXML declares no vertical datum "
            + '(CoordinateSystem verticalDatum, as EPSG:<n>), and the anchor declares no vertical datum (IfcProjectedCRS.VerticalDatum)'), error.message);
          return true;
        },
      );
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
    }
  });

  it('lands the same TIN on the IFC terrain once both sides declare the vertical datum', async () => {
    installAnchor(await parseIfc(ifc844Georeference('EPSG:5783')));
    const plan = await federate(landXml844(WITH_VERTICAL));
    assert.equal(plan.federationAlignmentStatus, 'same-crs');
    assert.equal(plan.droppedComponentCount, 0);
    // Fixture #24 vertices 1-6 in renderer (east, up, south) metres: east -199.566..-195.401,
    // up 126.112..126.345, south 110.639..119.043 (vertex 1 is IFC (-199.346, -111.675, 126.135)).
    const { min, max } = plan.coordinateInfo.shiftedBounds;
    assert.ok(Math.abs(min.x - (-199.566)) < 1e-3 && Math.abs(max.z - 119.043) < 1e-3, JSON.stringify(plan.coordinateInfo.shiftedBounds));
    assert.ok(Math.abs(min.y - 126.112) < 1e-3 && Math.abs(max.y - 126.345) < 1e-3, JSON.stringify(plan.coordinateInfo.shiftedBounds));
  });
});

describe('LandXML federation onto the real 844 fixture (#7605)', () => {
  const skip = existsSync(FIXTURE_844) ? false : 'fixture issues/844_terrain_and_alignment.ifc absent; run `pnpm fixtures`';

  it('reads the IFC4X1 anchor and names its missing VerticalDatum', { skip }, async () => {
    installAnchor(await parseIfc(readFileSync(FIXTURE_844, 'utf8')));
    await assert.rejects(federate(landXml844(EPSG_CODE_ONLY)), (error: Error) => {
      assert.match(error.message, /lie up to 5,516 km .* It was not aligned to the anchor's EPSG:31467 because this LandXML declares no vertical datum .*, and the anchor declares no vertical datum \(IfcProjectedCRS\.VerticalDatum\)/);
      return true;
    });
  });

  it('federates once the VerticalDatum is set in the Georeferencing panel and the LandXML declares it', { skip }, async () => {
    installAnchor(await parseIfc(readFileSync(FIXTURE_844, 'utf8')), 'EPSG:5783');
    const plan = await federate(landXml844(WITH_VERTICAL));
    assert.equal(plan.federationAlignmentStatus, 'same-crs');
    const { min, max } = plan.coordinateInfo.shiftedBounds;
    assert.ok(Math.abs(min.x - (-199.566)) < 1e-3 && Math.abs(max.z - 119.043) < 1e-3, JSON.stringify(plan.coordinateInfo.shiftedBounds));
  });
});
