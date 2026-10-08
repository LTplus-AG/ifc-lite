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
import { selectedStructuralMember } from '@/components/viewer/properties/selectedStructuralMember';
import { StructuralCard } from '@/components/viewer/properties/StructuralCard';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureEvidence } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

test('#7195 duplicate native member GlobalIds do not override the selected local EXPRESS identity', async () => {
  const { file, memberId } = await fixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setExpressIdWatermark(200_000);
  const author = (type: string, fields: Record<string, IfcAttributeValue>) => view.createEntity(type,
    getAttributeNames(type).map(name => fields[name] ?? null));
  const duplicate = author('IfcStructuralSurfaceMember', { GlobalId: '0000000000000000000006', Name: 'Second native member', Thickness: 0.5, PredefinedType: '.SHELL.' });
  const load = author('IfcStructuralLoadSingleForce', { ForceX: 9876 });
  const action = author('IfcStructuralSurfaceAction', { GlobalId: '0000000000000000000017', Name: 'Second native action', AppliedLoad: `#${load.expressId}` });
  author('IfcRelConnectsStructuralActivity', { GlobalId: '0000000000000000000018', RelatingElement: `#${duplicate.expressId}`, RelatedStructuralActivity: `#${action.expressId}` });
  const saved = await exportAndReparse('native', file);
  const native = extractStructuralOnDemand(saved);
  assert.equal(native.members.length, 2);
  assert.equal(native.members.find(row => row.expressId === memberId)?.thickness, 0.25);
  assert.equal(native.members.find(row => row.expressId === duplicate.expressId)?.name, 'Second native member');
  assert.equal(native.activities.find(row => row.expressId === action.expressId)?.appliedLoad?.components.ForceX, 9876);
  assert.equal(selectedStructuralMember(native, duplicate.expressId, '0000000000000000000006')?.expressId, duplicate.expressId);
  assert.equal(selectedStructuralMember(native, null, '0000000000000000000006'), null, 'ambiguous GUID-only fallback must not choose a member');
  useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, saved, duplicate.expressId);
  const evidence: { evidence: { rows: Array<{ data: { structural: { member: { expressId: number }; activities: Array<{ AppliedLoad: { components: { ForceX: number } } }> } } }> } } = JSON.parse(captureEvidence('selection').payload);
  assert.equal(evidence.evidence.rows[0].data.structural.member.expressId, duplicate.expressId);
  assert.equal(evidence.evidence.rows[0].data.structural.activities[0].AppliedLoad.components.ForceX, 9876);
  const ui = render(<StructuralCard structuralData={native} selectedExpressId={duplicate.expressId} selectedGlobalId="0000000000000000000006" />);
  assert.match(ui.textContent ?? '', /9[,.’'\u202f\s]?876/);
  assert.doesNotMatch(ui.textContent ?? '', /1[,.’'\u202f\s]?234/);
});

test('#7195 duplicate native activity GUID targets stay unresolved in the card and evidence', async () => {
  const { file, memberId, actionId } = await fixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setExpressIdWatermark(200_000);
  const author = (type: string, fields: Record<string, IfcAttributeValue>) => view.createEntity(type,
    getAttributeNames(type).map(name => fields[name] ?? null));
  const load = author('IfcStructuralLoadSingleForce', { ForceX: 9876 });
  const duplicate = author('IfcStructuralSurfaceAction', { GlobalId: '0000000000000000000007', Name: 'Ambiguous native action', AppliedLoad: `#${load.expressId}` });
  const saved = await exportAndReparse('native', file);
  const native = extractStructuralOnDemand(saved);
  assert.deepEqual(native.members[0].activityGlobalIds, ['0000000000000000000007']);
  assert.equal(native.activities.find(row => row.expressId === actionId)?.appliedLoad?.components.ForceX, 1234);
  assert.equal(native.activities.find(row => row.expressId === duplicate.expressId)?.appliedLoad?.components.ForceX, 9876);
  useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, saved, memberId);
  const evidence: { evidence: { rows: Array<{ data: { structural: { nativeResolvedActivityCount: number | null; relationshipTargetsUnavailable: boolean; activities: unknown[] } } }> } } = JSON.parse(captureEvidence('selection').payload);
  const selected = evidence.evidence.rows[0].data.structural;
  assert.equal(selected.nativeResolvedActivityCount, null, 'GUID links cannot prove which native activity was assigned');
  assert.equal(selected.relationshipTargetsUnavailable, true);
  assert.deepEqual(selected.activities, []);
  const ui = render(<StructuralCard structuralData={native} selectedExpressId={memberId} />);
  assert.match(ui.textContent ?? '', /cannot be resolved uniquely/);
  assert.doesNotMatch(ui.textContent ?? '', /ForceX/);
});
