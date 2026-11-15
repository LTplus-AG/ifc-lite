/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectUnits } from '@ifc-lite/parser';
import { extractStructuralOnDemand } from '../../../../../../packages/parser/src/structural-extractor.js';
import { structuralEvidenceFixture } from '@/test/structural-evidence-fixture';
import { useViewerStore } from '@/store';
import { structuralEvidence } from './selection-structural';

const recordOf = (evidence: ReturnType<typeof structuralEvidence>) => {
  const record = evidence && 'record' in evidence ? evidence.record : undefined;
  assert.ok(record, 'a non-member record gets evidence');
  return record;
};

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

// #9951: the properties card shows every structural record, so the assistant's selection
// evidence must too, not only the selected member's.
test('#9951 a selected structural action reports its own and its load\'s card rows', async () => {
  const { saved, actionId, loadId } = await structuralEvidenceFixture();
  const data = extractStructuralOnDemand(saved);
  const evidence = structuralEvidence(data, actionId, undefined, 10, 20, ProjectUnits.empty(), saved.schemaVersion, true);
  const record = recordOf(evidence);
  assert.equal(record.sectionCount, 2);
  assert.deepEqual(record.sections.map((s) => [s.expressId, s.type, s.depth]),
    [[actionId, 'IfcStructuralSurfaceAction', 0], [loadId, 'IfcStructuralLoadSingleForce', 1]]);
  const load = record.sections[1];
  assert.equal(load.via, 'AppliedLoad');
  assert.equal(load.rows.find((row) => row.attribute === 'ForceX')?.value, 1234);
  assert.equal(record.sections[0].rows.find((row) => row.attribute === 'Name')?.value, 'Authored structural action');
});

test('#9951 the record evidence is bounded by the section and row limits', async () => {
  const { saved, actionId } = await structuralEvidenceFixture();
  const data = extractStructuralOnDemand(saved);
  const evidence = structuralEvidence(data, actionId, undefined, 1, 2, ProjectUnits.empty(), saved.schemaVersion, true);
  const record = recordOf(evidence);
  assert.equal(record.sections.length, 1);
  assert.equal(record.omittedSections, 1);
  assert.equal(record.sections[0].rows.length, 2);
  assert.ok(record.sections[0].omittedRows > 0);
});

test('#9951 a selection that is no structural record still has no structural evidence', async () => {
  const { saved } = await structuralEvidenceFixture();
  const data = extractStructuralOnDemand(saved);
  assert.equal(structuralEvidence(data, 89, undefined, 10, 20, ProjectUnits.empty(), saved.schemaVersion, true), null);
});
