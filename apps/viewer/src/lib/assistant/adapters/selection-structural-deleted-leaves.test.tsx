/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuralOnDemand, getAttributeNames } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/data';
import { structuralEvidenceFixture as fixture } from '@/test/structural-evidence-fixture';
import { exportAndReparse, seedModel } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createStructuralAdapter } from '@/sdk/adapters/structural-adapter';
import { render, cleanup } from '@/test/render';
import { StructuralCard } from '@/components/viewer/properties/StructuralCard';
import { useViewerStore } from '@/store';
import { captureEvidence } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

for (const mode of ['editor', 'view'] as const) for (const kind of ['load', 'condition'] as const) test(`#7195 deleted native source ${kind} leaves via ${mode} cannot resurrect original fields`, async () => {
  const { file, memberId, loadId } = await fixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setExpressIdWatermark(200_000);
  const author = (type: string, fields: Record<string, IfcAttributeValue>) => view.createEntity(type,
    getAttributeNames(type).map(name => fields[name] ?? null));
  const condition = author('IfcBoundaryNodeCondition', { Name: 'Native support', TranslationalStiffnessX: 7654 });
  const connection = author('IfcStructuralPointConnection', { GlobalId: '0000000000000000000029', Name: 'Native connection', AppliedCondition: `#${condition.expressId}` });
  author('IfcRelConnectsStructuralMember', { GlobalId: '0000000000000000000030', RelatingStructuralMember: `#${memberId}`, RelatedStructuralConnection: `#${connection.expressId}` });
  const source = await exportAndReparse('native', file);
  const original = extractStructuralOnDemand(source);
  assert.equal(original.activities[0].appliedLoad?.components.ForceX, 1234);
  assert.equal(original.connections[0].appliedCondition?.components.TranslationalStiffnessX, 7654);
  assert.deepEqual(original.members[0].connectionGlobalIds, ['0000000000000000000029']);
  useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() }); seedModel('native', 0, source, memberId);
  const sourceView = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(sourceView);
  const sdk = createStructuralAdapter(useViewerStore);
  assert.equal(sdk.data('native').activities[0].appliedLoad?.components.ForceX, 1234, 'populate the actual current reader before deletion');
  const leaf = kind === 'load' ? loadId : condition.expressId;
  if (mode === 'editor') assert.equal(useViewerStore.getState().removeEntity('native', leaf, { mirror: false }), true);
  else sourceView.deleteEntity(leaf);
  assert.equal(sourceView.isDeleted(leaf), true);
  const saved = await exportAndReparse('native', source);
  assert.equal(saved.getEntity(leaf), null, 'independent native STEP export excludes the deleted source leaf');
  const reparsed = extractStructuralOnDemand(saved);
  const current = sdk.data('native');
  if (kind === 'load') {
    assert.equal(reparsed.activities[0].appliedLoad, undefined);
    assert.equal(current.activities[0].appliedLoad, undefined, 'current native reader cannot fall back to deleted source force');
  } else {
    assert.equal(reparsed.connections[0].appliedCondition, undefined);
    assert.equal(current.connections[0].appliedCondition, undefined, 'current native reader cannot fall back to deleted source stiffness');
  }
  const evidence: { evidence: { rows: Array<{ data: { structural: { activities: Array<{ AppliedLoad: unknown }>; connections: Array<{ AppliedCondition: unknown }> } } }> } } = JSON.parse(captureEvidence('selection').payload);
  const selected = evidence.evidence.rows[0].data.structural;
  assert.equal(kind === 'load' ? selected.activities[0].AppliedLoad : selected.connections[0].AppliedCondition, null);
  const ui = render(<StructuralCard structuralData={current} selectedExpressId={memberId} />);
  assert.doesNotMatch(ui.textContent ?? '', kind === 'load' ? /1[,.’'\u202f\s]?234/ : /7[,.’'\u202f\s]?654/);
});
