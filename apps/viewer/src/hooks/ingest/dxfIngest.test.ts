/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF ingest race + tri-state seeding (PR #1965 review, item 1).
 *
 * Reproduces the reporter's ACTUAL workflow: `ViewportContainer.handleDrop`
 * splits DXFs off first and fires `ingestDxfFiles` concurrently with model
 * loading (see `dxfIngest.ts`'s module doc) -- so a combined `model.ifc` +
 * `survey.dxf` drop used to ingest the DXF, resolve no georeference yet,
 * and seed the "aligned" toggle permanently OFF. This test drives
 * `ingestDxfFile` with NO model loaded (the race's exact state), then
 * simulates the model finishing loading afterwards, and checks that the
 * underlay's EFFECTIVE alignment -- resolved the same way
 * `useDxfMapToWorldTransform` + `dxfUnderlayToDrawing` resolve it at
 * render time -- follows the model without any user action. A second
 * entry seeded the pre-#1929 way (explicit `false`, simulating an entry
 * that predates this feature) must NOT move under the identical sequence.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resolveDxfExportGeoreference } from '@/hooks/dxfExportGeoref';
import { resolveEffectiveGeoreferenced } from '@/hooks/dxfUnderlayMath';
import { ingestDxfFile } from './dxfIngest.js';

// Same minimal georeferenced fixture shape as dxfExportGeoref.test.ts's
// GEOREF_FIXTURE (EPSG:2056, no rotation).
const GEOREF_FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,(#10),#20);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCUNITASSIGNMENT((#21));
#21=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#30=IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95','CH1903+','LN02',$,$,#21);
#31=IFCMAPCONVERSION(#10,#30,2600000.,1200000.,400.,1.,0.,1.);
ENDSEC;
END-ISO-10303-21;
`;

async function parseGeorefStore() {
  const bytes = new TextEncoder().encode(GEOREF_FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** Small (<5000-unit extent) DXF so the "assumed millimetres" heuristic never fires. */
function makeDxfFile(name = 'survey.dxf'): File {
  const text = [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LINE',
    '8', 'walls',
    '10', '0',
    '20', '0',
    '11', '4',
    '21', '6',
    '0', 'ENDSEC',
    '0', 'EOF',
    '',
  ].join('\n');
  return new File([text], name, { type: 'application/dxf' });
}

/** Large (>5000-unit extent), unitless DXF -- triggers `importDxf`'s "assumed
 *  millimetres" heuristic (`@ifc-lite/drawing-2d`'s `UNITLESS_MM_EXTENT_THRESHOLD`). */
function makeUnitlessLargeDxfFile(name = 'unitless-survey.dxf'): File {
  const text = [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LINE',
    '8', 'walls',
    '10', '0',
    '20', '0',
    '11', '6000',
    '21', '6000',
    '0', 'ENDSEC',
    '0', 'EOF',
    '',
  ].join('\n');
  return new File([text], name, { type: 'application/dxf' });
}

/** Resolve an entry's effective alignment exactly the way the render path does
 *  (`useDxfMapToWorldTransform` + `resolveEffectiveGeoreferenced`), without needing React. */
function effectivelyAligned(georeferencedField: boolean | undefined): boolean {
  const state = useViewerStore.getState();
  const georeference = resolveDxfExportGeoreference({
    models: state.models,
    legacyDataStore: state.ifcDataStore,
    anchorModelIdOverride: state.anchorModelIdOverride,
    georefMutations: state.georefMutations,
  });
  return resolveEffectiveGeoreferenced({ georeferenced: georeferencedField }, georeference !== null);
}

describe('ingestDxfFile tri-state race (PR #1965 review, item 1)', () => {
  beforeEach(() => {
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearDxfUnderlays();
  });

  it('a DXF ingested with no model loaded seeds "auto", then aligns once a georeferenced model loads -- no user action', async () => {
    // Reproduces the race: DXF ingest runs while `store.ifcDataStore` is
    // still null (the model hasn't finished loading).
    assert.strictEqual(useViewerStore.getState().ifcDataStore, null);
    await ingestDxfFile(makeDxfFile());

    const entries = useViewerStore.getState().dxfUnderlays;
    assert.strictEqual(entries.length, 1);
    const autoEntry = entries[0];
    assert.strictEqual(autoEntry.georeferenced, undefined, 'seeded to auto, not baked-in false');

    // Not aligned yet -- no georeference is available.
    assert.strictEqual(effectivelyAligned(autoEntry.georeferenced), false);

    // The model finishes loading (the other half of the race).
    useViewerStore.setState({ ifcDataStore: await parseGeorefStore() });

    // The SAME entry, un-touched by the user, now resolves aligned.
    assert.strictEqual(effectivelyAligned(autoEntry.georeferenced), true);
  });

  it('an entry that predates this feature (explicit georeferenced: false) does NOT move under the identical sequence', async () => {
    // First produce a real parsed DxfUnderlay via the actual import path...
    await ingestDxfFile(makeDxfFile('legacy.dxf'));
    const parsedUnderlay = useViewerStore.getState().dxfUnderlays[0]!.underlay;
    useViewerStore.getState().clearDxfUnderlays();

    // ...then register it the way any call site that does NOT explicitly
    // request 'auto' would -- this is what a pre-#1929 entry (or a future
    // load/migration path for one) looks like: explicit `false`, never
    // reachable to auto-follow the anchor.
    const preExistingId = useViewerStore.getState().addDxfUnderlay(parsedUnderlay, { georeferenced: false });
    const preExisting = useViewerStore.getState().dxfUnderlays.find((u) => u.id === preExistingId)!;
    assert.strictEqual(preExisting.georeferenced, false);

    assert.strictEqual(effectivelyAligned(preExisting.georeferenced), false);

    useViewerStore.setState({ ifcDataStore: await parseGeorefStore() });

    // Still off -- a pre-existing entry must never start following the
    // anchor on its own, even once one becomes available.
    assert.strictEqual(effectivelyAligned(preExisting.georeferenced), false);
  });

  // PR #1965 review, item 6: a unitless DXF whose extent forced the
  // "assumed millimetres" heuristic cannot also be safely auto-georeferenced
  // -- the divide-by-1000 and the inverse map-conversion subtraction (which
  // subtracts FULL eastings/northings) compound into a placement millions
  // of metres off. Seeding must suppress 'auto' in that case even when a
  // georeferenced model is already loaded.
  it('suppresses auto-georeference seeding when the "assumed millimetres" heuristic fired, even with a georeferenced model already loaded', async () => {
    useViewerStore.setState({ ifcDataStore: await parseGeorefStore() });
    assert.notStrictEqual(resolveDxfExportGeoreference({
      models: useViewerStore.getState().models,
      legacyDataStore: useViewerStore.getState().ifcDataStore,
      anchorModelIdOverride: useViewerStore.getState().anchorModelIdOverride,
      georefMutations: useViewerStore.getState().georefMutations,
    }), null, 'sanity: a georeference IS available for this test');

    await ingestDxfFile(makeUnitlessLargeDxfFile());

    const entry = useViewerStore.getState().dxfUnderlays[0]!;
    assert.ok(
      entry.underlay.warnings.some((w) => w.includes('assumed millimetres')),
      'sanity: the mm-assumption heuristic actually fired',
    );
    // Explicit false, NOT 'auto' -- even though a georeference is available.
    assert.strictEqual(entry.georeferenced, false);
    assert.strictEqual(effectivelyAligned(entry.georeferenced), false);
  });
});
