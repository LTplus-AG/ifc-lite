/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectUnits } from '@ifc-lite/parser';
import { extractStructuralOnDemand } from '../../../../../../packages/parser/src/structural-extractor.js';
import { structuralEvidenceFixture } from '@/test/structural-evidence-fixture';
import { parseStep } from '@/test/properties-panel-harness';
import { useViewerStore } from '@/store';
import { structuralEvidence } from './selection-structural';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

type Row = Record<string, unknown> & { AppliedLoad?: { expressId: number; componentCount: number; components: Record<string, number> } | null };
const recordOf = (evidence: ReturnType<typeof structuralEvidence>): Row => {
  const record = evidence && 'record' in evidence ? evidence.record : undefined;
  assert.ok(record, 'a non-member record gets evidence');
  return record as Row;
};

// #9951: the properties card shows every structural record, so the assistant's selection
// evidence must too, not only the selected member's. The adapter stays out of the card model,
// which the viewer keeps lazy.
test('#9951 a selected structural action reports itself and its applied load', async () => {
  const { saved, actionId, loadId } = await structuralEvidenceFixture();
  const data = extractStructuralOnDemand(saved);
  const record = recordOf(structuralEvidence(data, actionId, undefined, 10, 20, ProjectUnits.empty(), saved.schemaVersion, true));
  assert.deepEqual([record.expressId, record.type, record.Name], [actionId, 'IfcStructuralSurfaceAction', 'Authored structural action']);
  assert.equal(record.AppliedLoad?.expressId, loadId);
  assert.equal(record.AppliedLoad?.components.ForceX, 1234);
});

test('#9951 the applied load of a record is bounded by the value limit', async () => {
  const { saved, actionId } = await structuralEvidenceFixture();
  const data = extractStructuralOnDemand(saved);
  const record = recordOf(structuralEvidence(data, actionId, undefined, 10, 2, ProjectUnits.empty(), saved.schemaVersion, true));
  assert.equal(Object.keys(record.AppliedLoad?.components ?? {}).length, 2);
  assert.ok((record.AppliedLoad?.componentCount ?? 0) > 2);
});

test('#9951 a selected load case reports its own fields', async () => {
  const store = await parseStep(`ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#30=IFCSTRUCTURALLOADCASE('lc0000000000000000000a',$,'Dead load',$,$,.LOAD_CASE.,.PERMANENT_G.,.DEAD_LOAD_G.,1.35,'Self weight',(0.,0.,-1.));
ENDSEC;END-ISO-10303-21;`);
  const data = extractStructuralOnDemand(store);
  const record = recordOf(structuralEvidence(data, 30, undefined, 10, 20, ProjectUnits.empty(), store.schemaVersion, true));
  assert.deepEqual([record.expressId, record.type, record.name], [30, 'IfcStructuralLoadCase', 'Dead load']);
  assert.deepEqual([record.predefinedType, record.actionType, record.coefficient], ['LOAD_CASE', 'PERMANENT_G', 1.35]);
  assert.deepEqual(record.selfWeightCoefficients, { count: 3, values: [0, 0, -1] });
});

test('#9951 a selected analysis model names its type', async () => {
  const store = await parseStep(`ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#40=IFCSTRUCTURALANALYSISMODEL('am0000000000000000000a',$,'Model',$,$,.LOADING_3D.,$,$,$,$);
ENDSEC;END-ISO-10303-21;`);
  const data = extractStructuralOnDemand(store);
  const record = recordOf(structuralEvidence(data, 40, undefined, 10, 20, ProjectUnits.empty(), store.schemaVersion, true));
  assert.deepEqual([record.expressId, record.type, record.Name], [40, 'IfcStructuralAnalysisModel', 'Model']);
});

test('#9951 without the source file the assignment totals of a record are unknown, not zero', async () => {
  const store = await parseStep(`ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#30=IFCSTRUCTURALLOADCASE('lc0000000000000000000a',$,'Dead load',$,$,.LOAD_CASE.,.PERMANENT_G.,.DEAD_LOAD_G.,1.35,'Self weight',(0.,0.,-1.));
ENDSEC;END-ISO-10303-21;`);
  const data = extractStructuralOnDemand(store);
  const withSource = recordOf(structuralEvidence(data, 30, undefined, 10, 20, ProjectUnits.empty(), store.schemaVersion, true));
  const without = recordOf(structuralEvidence(data, 30, undefined, 10, 20, ProjectUnits.empty(), store.schemaVersion, false));
  assert.deepEqual(withSource.activityGlobalIds, { count: 0, values: [] });
  assert.deepEqual(without.activityGlobalIds, { count: null, values: [] });
  assert.deepEqual(without.selfWeightCoefficients, { count: 3, values: [0, 0, -1] }, 'a known aggregate keeps its length');
});

test('#9951 a selection that is no structural record still has no structural evidence', async () => {
  const { saved } = await structuralEvidenceFixture();
  const data = extractStructuralOnDemand(saved);
  assert.equal(structuralEvidence(data, 89, undefined, 10, 20, ProjectUnits.empty(), saved.schemaVersion, true), null);
});
