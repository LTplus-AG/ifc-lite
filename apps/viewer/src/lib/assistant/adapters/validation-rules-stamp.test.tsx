/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { useInformationValidation } from '@/hooks/validation/useInformationValidation';
import { captureEvidence, evidenceIsCurrent } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); localStorage.clear(); useViewerStore.setState(initial, true); });

let owner: ReturnType<typeof useInformationValidation>;
function Owner() { owner = useInformationValidation(); return null; }

// #6833: information-rule reports were never stamped, so a rules result computed
// before an edit stayed "current" forever. The run must carry its model versions.
test('an information-rules report computed before an edit is not current evidence after it', async () => {
  const bytes = readFileSync(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
  useViewerStore.setState(fixtureModels({ ...fixtureModel('arch'), name: 'building-architecture.ifc', ifcDataStore: store }));
  const parsed = parseRuleSetFile({ version: 1, name: 'Wall names', rules: [{
    id: 'wall-name', name: 'Wall name',
    applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'attribute', name: 'Name', op: 'isSet', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
  }] });
  assert.ok(parsed.ok);
  render(<Owner />);
  act(() => owner.setFile(parsed.file));
  await act(async () => { await owner.run(); });
  const report = useViewerStore.getState().idsValidationReport;
  assert.ok(report, 'the native rules engine published a report for the real model');
  assert.equal(report.source.kind, 'rules');
  assert.ok(report.specificationResults[0].applicableCount > 0, 'the rule applied to real walls');
  const stamp = analysisStampOf(report);
  assert.equal(stamp?.mutationVersion, initial.mutationVersion, 'the run stamped the versions it read');

  const before = captureEvidence('validation');
  assert.equal(evidenceIsCurrent(before), true);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(before), false, 'an edit invalidates the attached evidence');
  const after = captureEvidence('validation');
  assert.equal(evidenceIsCurrent(after), false, 'a report that predates the edit cannot be re-attached as current');
  assert.deepEqual(JSON.parse(after.payload).reportProvenance, { mutationVersion: stamp.mutationVersion, geometryContentVersion: stamp.geometryContentVersion });
});
