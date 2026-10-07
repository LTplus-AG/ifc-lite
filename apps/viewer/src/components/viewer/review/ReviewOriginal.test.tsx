/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { comparisonModels, comparisonResult } from '@/test/saved-comparison-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { snapshotComparison } from '@/lib/compare/savedComparisons';
import { openOriginal } from '@/lib/review/open';
import { finding } from '@/lib/review/test-support';
import { useSemanticSession } from '@/lib/semantic/session';
import { pilotDocument } from '@/lib/semantic/demo';
import { useSavedComparisonFocus, useSemanticRecordFocus } from '@/lib/panels/evidence-focus';
import { SavedComparisonLibrary } from '../compare/SavedComparisonLibrary';
import { SemanticPanel } from '../SemanticPanel';

const initial = useViewerStore.getState();
const semantic = useSemanticSession.getState();
afterEach(() => {
  cleanup(); useViewerStore.setState(initial, true); useSemanticSession.setState(semantic, true);
  useSavedComparisonFocus.setState({ record: null }); useSemanticRecordFocus.setState({ record: null });
});

test('#7015 current comparison original selects the actual native detail row', () => {
  const result = comparisonResult('A', 'B');
  useViewerStore.setState({ models: comparisonModels(), compareResult: result });
  const key = result.diff.entries.find(row => row.state !== 'unchanged')!.key;
  const original = finding(key, 'comparison', [], { evidence: { kind: 'comparison', key } });
  assert.equal(openOriginal(original, panel => useViewerStore.getState().openPanelInHome(panel)), true);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'compare');
  assert.equal(useViewerStore.getState().compareSelectedKey, key);
  assert.equal(openOriginal({ ...original, evidence: { kind: 'comparison', key: 'removed-row' } }, () => assert.fail('unavailable rows cannot open')), false);
});

test('#7015 saved comparison original opens the requested report and uncapped row', async () => {
  await useViewerStore.getState().initializeSavedComparisons();
  const models = comparisonModels();
  const first = snapshotComparison(comparisonResult('A', 'B'), models, 'First comparison');
  const second = snapshotComparison(comparisonResult('B', 'C'), models, 'Requested comparison');
  // A history report may contain more rows than its initial display cap.
  const source = second.report.rows[0];
  second.report.rows = Array.from({ length: 105 }, (_, index) => ({ ...source, key: `row-${index}`, globalId: `guid-${index}`, name: `Evidence row ${index}` }));
  useViewerStore.setState({ models, savedComparisons: [first, second] });
  const ui = render(<SavedComparisonLibrary result={null} running={false} />);
  const original = finding('row-104', 'comparison', [], { evidence: { kind: 'saved-comparison', comparisonId: second.id, key: 'row-104' } });
  act(() => { assert.equal(openOriginal(original, () => {}), true); });
  await waitFor(() => ui.querySelector('[data-original-comparison="row-104"]') !== null, 'exact historical row');
  assert.equal(ui.querySelector('select')?.value, second.id);
  assert.match(ui.querySelector('[data-original-comparison="row-104"]')?.textContent ?? '', /Evidence row 104/);
  assert.equal(openOriginal({ ...original, evidence: { kind: 'saved-comparison', comparisonId: 'deleted', key: 'row-104' } }, () => assert.fail('missing history cannot open')), false);
});

test('#7015 linked original selects the requested native resource, not the previous row', async () => {
  const document = pilotDocument();
  const resource = document.resources.find(row => row.label === 'Individual door')!;
  useSemanticSession.setState({ document, revisions: new Map() });
  const ui = render(<SemanticPanel />);
  const original = finding(resource.id, 'linked', [], { evidence: { kind: 'linked', resourceId: resource.id } });
  act(() => { assert.equal(openOriginal(original, () => {}), true); });
  await waitFor(() => [...ui.querySelectorAll('details[open] summary')].some(summary => summary.textContent?.includes('Individual door')), 'requested native resource detail');
  assert.equal(openOriginal({ ...original, evidence: { kind: 'linked', resourceId: 'removed-resource' } }, () => assert.fail('missing resources cannot open')), false);
});

test('#7015 validation original refuses a removed model without replacing selection', () => {
  useViewerStore.setState({ models: new Map([['current', fixtureModel('current')]]), selectedEntityId: 99 });
  const original = finding('old', 'validation', [], { evidence: { kind: 'validation', specificationId: 'S1', modelId: 'removed', expressId: 1 } });
  assert.equal(openOriginal(original, () => assert.fail('removed validation inputs cannot open')), false);
  assert.equal(useViewerStore.getState().selectedEntityId, 99);
});


test('#7015 validation original refuses an express id reused by a replacement model', () => {
  const replacement = fixtureModel('m', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Replacement', globalId: 'NEW_GUID' }] });
  useViewerStore.setState({ models: new Map([['m', replacement]]), selectedEntityId: 99 });
  const original = finding('old', 'validation', [{ globalId: 'OLD_GUID', modelId: 'm', modelName: 'm.ifc' }],
    { evidence: { kind: 'validation', specificationId: 'S1', modelId: 'm', expressId: 1 } });
  assert.equal(openOriginal(original, () => assert.fail('replacement is not the original element')), false);
  assert.equal(useViewerStore.getState().selectedEntityId, 99);
});
