/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MergedExporter, type MergeModelInput } from '@ifc-lite/export';
import { parseStep } from '@/test/agent-tools-fixture';
import { sectionMergeInputs } from './section-export';

const GEOREF: MergeModelInput['georefMutations'] = {
  projectedCRS: { name: 'EPSG:2056', geodeticDatum: 'CH1903+', mapUnit: 'METRE' },
  mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
};
const none = { hidden: new Map<string, Set<number>>(), isolated: new Map<string, Set<number> | null>() };
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0ProjectM000000000000m',$,'M',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCUNITASSIGNMENT((#2));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
ENDSEC;
END-ISO-10303-21;
`;
const store = () => parseStep(new TextEncoder().encode(MODEL));
const mapConversions = (input: MergeModelInput) => input.dataStore.entityIndex.byType.get('IFCMAPCONVERSION')?.length ?? 0;

test('a cropped merge input carries its georeference edits into the cropped bytes, once (#10669)', async () => {
  const input: MergeModelInput = { id: 'm', name: 'Model M', dataStore: await store(), georefMutations: GEOREF };
  const prepared = await sectionMergeInputs([input], none, 'IFC4', () => ({ planes: [] }));
  assert.deepEqual(prepared.warnings, []);
  assert.equal(prepared.inputs[0].georefMutations, undefined, 'the merge must not apply them again');
  assert.equal(mapConversions(prepared.inputs[0]), 1);
  // The cropped bytes carry the edited values, and merging them writes exactly one conversion.
  const merged = new TextDecoder().decode((await new MergedExporter(prepared.inputs).exportAsync({ schema: 'IFC4' })).content);
  assert.match(merged, /IFCPROJECTEDCRS\('EPSG:2056'/);
  assert.equal(merged.match(/=IFCMAPCONVERSION\(#\d+,#\d+,2600000\.,1200000\.,500\.,1\.,0\.,1\.\);/g)?.length, 1);
});

test('a cropped merge input whose georeference edits the target cannot hold is cropped without them (#10669)', async () => {
  const input: MergeModelInput = { id: 'm', name: 'Model M', dataStore: await store(), georefMutations: GEOREF };
  const prepared = await sectionMergeInputs([input], none, 'IFC2X3', () => ({ planes: [] }));
  assert.ok(prepared.warnings.some(warning => /^Model M: Georeferencing edits were not written\. Georeferencing .*IFC4/.test(warning)), prepared.warnings.join('\n'));
  assert.equal(mapConversions(prepared.inputs[0]), 0);
});
