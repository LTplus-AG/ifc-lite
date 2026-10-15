/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two user-chosen relaxations of the fail-closed CRS rules (#5048) for a
 * LandXML federated onto a georeferenced model, after #7605 named what blocks
 * the 844 terrain: `epsgFromName` (an exact `EPSG:<n>` CoordinateSystem@name
 * as the horizontal CRS) and `sharedVerticalDatum` (an unknown vertical datum
 * on either side treated as the same height system).
 *
 * Off by default, the refusal is exactly as before and now carries the
 * `offer` the prompt shows. On, the same files align. This file imports only
 * modules that exist on main and passes assumptions as plain objects, so a
 * revert of the feature fails these tests rather than failing to load them.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CoordinateInfo, ModelSpatialReference } from '@ifc-lite/geometry';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { FederationRegistry } from '@ifc-lite/renderer';
import type { FederatedModel } from '../../store/index.js';
import { useViewerStore } from '../../store/index.js';
import { fixtureModel } from '../../test/store-fixture.js';
import { FederatedLandXmlStreamingPlan } from './federatedLandXmlStreaming.js';
import { finalizeFederatedSpatialPlacement } from './federatedSpatialFinalize.js';
import { reframeLandXmlGeometry } from './landXmlLoad.js';
import { parseLandXmlViewerModelFromBlobAsync } from './landXmlViewerModel.js';
import { spatialMetadataFromLandXml } from './sourceSpatialReference.js';

const FIXTURE_844 = fileURLToPath(new URL('../../../../../tests/models/issues/844_terrain_and_alignment.ifc', import.meta.url));

interface Assumptions { sharedVerticalDatum: boolean; epsgFromName: boolean }
const NONE: Assumptions = { sharedVerticalDatum: false, epsgFromName: false };
const BOTH: Assumptions = { sharedVerticalDatum: true, epsgFromName: true };
const VERTICAL_ONLY: Assumptions = { sharedVerticalDatum: true, epsgFromName: false };
const NAME_ONLY_ASSUMED: Assumptions = { sharedVerticalDatum: false, epsgFromName: true };

/** The refusal as the loader's catch sees it, without importing the error class. */
interface Refusal extends Error { offer?: readonly string[] }

/** The 844 georeference records, verbatim apart from `verticalDatum` (as in landXmlFederationRefusal.test.ts). */
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

/** Two triangles of the 844 TIN as an IfcOpenShell-based producer (bonsai-topo) wrote them: N E Z in EPSG:31467. */
function landXml844(coordinateSystem: string): string {
  return `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" elevationUnit="meter"/></Units>
  ${coordinateSystem}
  <Surfaces><Surface name="Terrain"><Definition surfType="TIN"><Pnts>
    <P id="1">5516087.3988 3512838.6131 126.135</P><P id="2">5516088.4348 3512838.3931 126.112</P>
    <P id="3">5516088.2588 3512839.5811 126.283</P><P id="4">5516080.6108 3512842.3481 126.345</P>
    <P id="5">5516080.0308 3512842.5581 126.326</P><P id="6">5516080.5868 3512842.2611 126.344</P>
  </Pnts><Faces><F>1 3 2</F><F>4 6 5</F></Faces></Definition></Surface></Surfaces>
</LandXML>`;
}

/** What the reference producer writes for this IFC, and what ifc-lite's #7600 writer writes. */
const NAME_ONLY = '<CoordinateSystem name="EPSG:31467"/>';
const EPSG_CODE_ONLY = '<CoordinateSystem name="EPSG:31467" epsgCode="31467" horizontalDatum="EPSG:31467"/>';
const WITH_VERTICAL = '<CoordinateSystem name="EPSG:31467" epsgCode="31467" verticalDatum="EPSG:5783"/>';

async function parseIfc(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}

const IFC_FRAME: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -250, y: 117, z: 0 }, max: { x: 100, y: 128, z: 175 } },
  shiftedBounds: { min: { x: -250, y: 117, z: 0 }, max: { x: 100, y: 128, z: 175 } },
  hasLargeCoordinates: false,
};

/** Install the IFC as the loaded, georeferenced anchor exactly as `findReferenceSpatialModel` reads one. */
function installAnchor(dataStore: IfcDataStore): void {
  const anchor = fixtureModel('ifc-844') as FederatedModel;
  anchor.loadedAt = 0;
  anchor.ifcDataStore = dataStore;
  anchor.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: structuredClone(IFC_FRAME) };
  useViewerStore.setState({ models: new Map([[anchor.id, anchor]]) });
}

/** Run every LandXML parse here worker-less, in this realm. */
async function withoutWorker<T>(run: () => Promise<T>): Promise<T> {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
}

/** The streamed federated cursor (preflight, measure, freeze, admit, freezeAdmission, publish) under `assumptions`. */
function federate(xml: string, assumptions: Assumptions): Promise<FederatedLandXmlStreamingPlan> {
  return withoutWorker(async () => {
    const plan = { value: null as FederatedLandXmlStreamingPlan | null };
    const model = await parseLandXmlViewerModelFromBlobAsync(
      new Blob([xml]), () => true, undefined, undefined,
      async (mesh) => { await plan.value?.publish(mesh); },
      (preflight, sourceCoordinateInfo, spatialReference, declaredCrs) => {
        plan.value = new FederatedLandXmlStreamingPlan({
          modelId: 'terrain-844', componentCount: preflight.componentCount, sourceCoordinateInfo, spatialReference, declaredCrs,
          assumptions, registry: new FederationRegistry(), resources: { publish: () => {}, remove: () => {} }, isCurrent: () => true,
        });
        return true;
      },
      (component) => plan.value?.measure(component.mesh),
      () => plan.value?.freeze(),
      (component) => plan.value?.admit(component),
      () => plan.value?.freezeAdmission(),
      undefined, undefined, assumptions,
    );
    plan.value!.complete(model.geometryResult);
    return plan.value!;
  });
}

/** Assert a refusal carries `offer` (and is the structured error the loader recognises). */
function refusedWith(offer: readonly string[]): (error: Refusal) => boolean {
  return (error) => {
    assert.equal(error.name, 'LandXmlFederationRefusedError', error.message);
    assert.match(error.message, /^LandXML federation preflight rejected every render component: /);
    assert.deepEqual(error.offer, offer, error.message);
    return true;
  };
}

function assertBounds(bounds: CoordinateInfo['shiftedBounds'], min: readonly number[], max: readonly number[], tolerance: number): void {
  const actual = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
  const expected = [...min, ...max];
  for (let index = 0; index < 6; index++) {
    assert.ok(Math.abs(actual[index]! - expected[index]!) <= tolerance, `${JSON.stringify(bounds)} vs ${JSON.stringify(expected)}`);
  }
}

/** Renderer (east, up, south) of the two triangles: IFC #24 vertices 1-6 (`x`, `z`, `-y`). */
const TRIANGLES_MIN = [-199.566, 126.112, 110.639] as const;
const TRIANGLES_MAX = [-195.401, 126.345, 119.043] as const;

afterEach(() => useViewerStore.setState({ models: new Map(), georefMutations: new Map() }));

describe('epsgFromName reads only an exact EPSG:<n> CoordinateSystem@name nothing else contradicts', () => {
  it('is never read without the assumption', () => {
    assert.equal(spatialMetadataFromLandXml({ coordinateSystem: { name: 'EPSG:31467' } }).horizontalId, undefined);
  });

  it('reads the reference producer\'s name-only CoordinateSystem as the horizontal CRS, and says so', () => {
    const metadata = spatialMetadataFromLandXml({ coordinateSystem: { name: ' EPSG:31467 ' } }, { epsgFromName: true });
    assert.equal(metadata.horizontalId, 'EPSG:31467');
    assert.equal(metadata.horizontalFromName, true);
    assert.equal(metadata.verticalId, undefined);
  });

  it('never lets a name override or break a tie with epsgCode or an EPSG horizontalDatum', () => {
    for (const [coordinateSystem, expected] of [
      [{ name: 'EPSG:31467', epsgCode: '3006' }, 'EPSG:3006'],
      [{ name: 'EPSG:31467', horizontalDatum: 'EPSG:2056' }, 'EPSG:2056'],
      // An unreadable or self-contradicting declaration still declares: the name does not step in.
      [{ name: 'EPSG:31467', epsgCode: 'GK21' }, undefined],
      [{ name: 'EPSG:31467', epsgCode: '2056', horizontalDatum: 'EPSG:21781' }, undefined],
    ] as const) {
      const metadata = spatialMetadataFromLandXml({ coordinateSystem }, { epsgFromName: true });
      assert.equal(metadata.horizontalId, expected, JSON.stringify(coordinateSystem));
      assert.equal(metadata.horizontalFromName, undefined, JSON.stringify(coordinateSystem));
    }
  });

  it('never infers from a free-text or inexact name', () => {
    for (const name of ['DHDN / 3-degree Gauss-Kruger zone 3', 'GK21', 'epsg:31467', 'EPSG: 31467', 'EPSG:31467+5783', 'urn:ogc:def:crs:EPSG::31467']) {
      assert.equal(spatialMetadataFromLandXml({ coordinateSystem: { name } }, { epsgFromName: true }).horizontalId, undefined, name);
    }
  });

  it('accepts a name beside a datum NAME, which declares no CRS', () => {
    assert.equal(spatialMetadataFromLandXml({ coordinateSystem: { name: 'EPSG:2269', horizontalDatum: 'NAD83' } }, { epsgFromName: true }).horizontalId, 'EPSG:2269');
  });
});

describe('a refused LandXML federation offers exactly the assumptions that would align it', () => {
  for (const [label, coordinateSystem, offer] of [
    ['a name-only CoordinateSystem (reference producer)', NAME_ONLY, ['epsgFromName', 'sharedVerticalDatum']],
    ['epsgCode without verticalDatum (the #7600 writer)', EPSG_CODE_ONLY, ['sharedVerticalDatum']],
    ['a complete LandXML whose anchor has no VerticalDatum', WITH_VERTICAL, ['sharedVerticalDatum']],
  ] as const) {
    it(`assumptions off: ${label} is refused as before and offered ${offer.join(' + ')}`, async () => {
      installAnchor(await parseIfc(ifc844Georeference(null)));
      await assert.rejects(federate(landXml844(coordinateSystem), NONE), refusedWith(offer));
    });
  }

  it('offers nothing for differing vertical datums, even with sharedVerticalDatum on', async () => {
    installAnchor(await parseIfc(ifc844Georeference('EPSG:7837')));
    await assert.rejects(federate(landXml844(WITH_VERTICAL), NONE), refusedWith([]));
    await assert.rejects(federate(landXml844(WITH_VERTICAL), BOTH), (error: Refusal) => {
      refusedWith([])(error);
      assert.ok(error.message.includes('the vertical datums differ (EPSG:5783 here, EPSG:7837 on the anchor)'), error.message);
      return true;
    });
  });

  it('offers nothing when no loaded model is georeferenced', async () => {
    installAnchor(await parseIfc(ifc844Georeference(null, false)));
    await assert.rejects(federate(landXml844(NAME_ONLY), NONE), refusedWith([]));
  });

  it('offers the complete set when only one of the two needed assumptions was applied', async () => {
    installAnchor(await parseIfc(ifc844Georeference(null)));
    await assert.rejects(federate(landXml844(NAME_ONLY), NAME_ONLY_ASSUMED), (error: Refusal) => {
      refusedWith(['epsgFromName', 'sharedVerticalDatum'])(error);
      // The applied assumption is no longer named as a blocker; the missing vertical datums still are.
      assert.ok(!error.message.includes('declares no horizontal CRS'), error.message);
      assert.ok(error.message.includes('this LandXML declares no vertical datum'), error.message);
      return true;
    });
    await assert.rejects(federate(landXml844(NAME_ONLY), VERTICAL_ONLY), (error: Refusal) => {
      refusedWith(['epsgFromName', 'sharedVerticalDatum'])(error);
      assert.ok(error.message.includes('this LandXML declares no horizontal CRS'), error.message);
      assert.ok(!error.message.includes('vertical datum'), error.message);
      return true;
    });
  });
});

describe('the assumptions, once chosen, align the same files', () => {
  it('lands the name-only 844 TIN on its IFC anchor under both assumptions, and records them as applied', async () => {
    installAnchor(await parseIfc(ifc844Georeference(null)));
    const plan = await federate(landXml844(NAME_ONLY), BOTH);
    assert.equal(plan.federationAlignmentStatus, 'same-crs');
    assert.equal(plan.droppedComponentCount, 0);
    assertBounds(plan.coordinateInfo.shiftedBounds, TRIANGLES_MIN, TRIANGLES_MAX, 1e-3);
    assert.deepEqual(plan.landXmlAssumptionsApplied, ['epsgFromName', 'sharedVerticalDatum']);
  });

  it('needs only sharedVerticalDatum for the #7600 writer\'s epsgCode, and records only that', async () => {
    installAnchor(await parseIfc(ifc844Georeference(null)));
    const plan = await federate(landXml844(EPSG_CODE_ONLY), BOTH);
    assert.equal(plan.federationAlignmentStatus, 'same-crs');
    assertBounds(plan.coordinateInfo.shiftedBounds, TRIANGLES_MIN, TRIANGLES_MAX, 1e-3);
    assert.deepEqual(plan.landXmlAssumptionsApplied, ['sharedVerticalDatum']);
  });

  it('records nothing when the declarations alone align it, assumptions enabled or not', async () => {
    installAnchor(await parseIfc(ifc844Georeference('EPSG:5783')));
    const plan = await federate(landXml844(WITH_VERTICAL), BOTH);
    assert.equal(plan.federationAlignmentStatus, 'same-crs');
    assert.deepEqual(plan.landXmlAssumptionsApplied, []);
  });

  it('whole-document path: the reframe refusal carries the offer, and the finalizer aligns under it', async () => {
    installAnchor(await parseIfc(ifc844Georeference(null)));
    const anchor: ModelSpatialReference = {
      source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
      horizontal: { id: 'EPSG:31467' },
      localToProjected: {
        kind: 'local-projected-affine', eastings: 3513037.9591, northings: 5516199.0738, orthogonalHeight: 0,
        xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
      },
      confidence: 'declared',
      sourceMetadata: { format: 'ifc' },
    };
    const unaligned = await withoutWorker(() => parseLandXmlViewerModelFromBlobAsync(new Blob([landXml844(NAME_ONLY)])));
    assert.throws(
      () => reframeLandXmlGeometry(unaligned.geometryResult, unaligned.semanticDocument, structuredClone(IFC_FRAME), { anchor, aligned: false }),
      refusedWith(['epsgFromName', 'sharedVerticalDatum']),
    );

    const model = await withoutWorker(() => parseLandXmlViewerModelFromBlobAsync(
      new Blob([landXml844(NAME_ONLY)]), () => true, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, BOTH,
    ));
    assert.equal(model.spatialReference?.horizontal?.id, 'EPSG:31467');
    assert.equal(model.spatialReference?.vertical, undefined);
    assert.equal(model.spatialReference?.confidence, 'assumed');
    const finalized = await finalizeFederatedSpatialPlacement({
      dataStore: model.dataStore, geometry: model.geometryResult, modelId: 'terrain-844', fileName: 'terrain.xml',
      spatialReference: model.spatialReference, landXmlDocument: model.semanticDocument, postAlignmentReframe: true,
      landXmlAssumptions: BOTH, isCurrent: () => true, setProgress: () => {},
    });
    assert.equal(finalized?.federationAlignmentStatus, 'same-crs');
    assertBounds(model.geometryResult.coordinateInfo.shiftedBounds, TRIANGLES_MIN, TRIANGLES_MAX, 1e-3);
    assert.deepEqual(finalized?.landXmlAssumptionsApplied, ['epsgFromName', 'sharedVerticalDatum']);
  });
});

/**
 * The full 844 terrain (`IfcGeographicElement` #30, its #23/#24 face set) as
 * the reference producer wrote it: `N E Z` = IFC `y + 5516199.0738`,
 * `x + 3513037.9591`, `z`, shortest decimal of the 4-place rounding, and a
 * name-only `<CoordinateSystem name="EPSG:31467"/>`. Built here from the
 * fixture because the producer's file is not a committed fixture; its 4,845
 * points are byte-identical to bonsai-topo's export of this IFC.
 */
function referenceLandXmlOf844(ifc: string): string {
  const points = /#24=IFCCARTESIANPOINTLIST3D\(\((.*?)\)\);/s.exec(ifc)![1]!;
  const faces = /#23=IFCTRIANGULATEDFACESET\(#24,\$,\.F\.,\((.*?)\),\$\);/s.exec(ifc)![1]!;
  const pnts = [...points.matchAll(/\(([^()]*)\)/g)].map((match, index) => {
    const [x, y, z] = match[1]!.split(',').map(Number) as [number, number, number];
    return `<P id="${index + 1}">${Number((y + 5516199.0738).toFixed(4))} ${Number((x + 3513037.9591).toFixed(4))} ${z}</P>`;
  });
  const tris = [...faces.matchAll(/\(([^()]*)\)/g)].map((match) => `<F>${match[1]!.split(',').join(' ')}</F>`);
  return `<?xml version='1.0' encoding='utf-8'?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" elevationUnit="meter" /></Units><CoordinateSystem name="EPSG:31467" /><Surfaces><Surface name="Terrain" desc="EPSG:31467"><Definition surfType="TIN"><Pnts>${pnts.join('')}</Pnts><Faces>${tris.join('')}</Faces></Definition></Surface></Surfaces></LandXML>`;
}

describe('the reference LandXML of the real 844 fixture (#7605)', () => {
  const skip = existsSync(FIXTURE_844) ? false : 'fixture issues/844_terrain_and_alignment.ifc absent; run `pnpm fixtures`';

  it('is refused by default, offering both assumptions', { skip }, async () => {
    const ifc = readFileSync(FIXTURE_844, 'utf8');
    installAnchor(await parseIfc(ifc));
    await assert.rejects(federate(referenceLandXmlOf844(ifc), NONE), refusedWith(['epsgFromName', 'sharedVerticalDatum']));
  });

  it('federates under both assumptions onto exactly IFC #30\'s extent', { skip }, async () => {
    const ifc = readFileSync(FIXTURE_844, 'utf8');
    installAnchor(await parseIfc(ifc));
    const plan = await federate(referenceLandXmlOf844(ifc), BOTH);
    assert.equal(plan.federationAlignmentStatus, 'same-crs');
    assert.equal(plan.droppedComponentCount, 0);
    // #30's #24 points in renderer (east, up, south) = (x, z, -y).
    assertBounds(plan.coordinateInfo.shiftedBounds, [-247.257, 117.66, 1.5201], [-111.718, 127.509, 173.187], 1e-6);
    assert.deepEqual(plan.landXmlAssumptionsApplied, ['epsgFromName', 'sharedVerticalDatum']);
  });
});
