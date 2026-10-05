/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { useClashGroupLibrary } from './group-workspace';
import { applyClashGroupPlan, newWorkspaceBase, planClashGroupApply } from './group-apply';
import { applicationContinuity } from './group-continuity';
import { manualClashOccurrenceKey, resolveManualClashGroups } from './manual-groups';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

function finding(i: number, model = 'mep'): Clash {
  return { id: `f-${i}-${model}`, rule: 'coordination', status: 'hard', severity: 'major', distance: -0.01,
    a: { key: `A${i}`, ref: i + 1, model: 'arch', tag: 'IfcWall', name: `Wall ${i}` }, b: { key: `B${i}`, ref: 1000 + i, model, tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
}
function install(clashes: Clash[]) {
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
}

// #6906: a new detection run reconciles an applied AI workspace through the native resolver and says what happened.
test('after a rerun, applied members are listed as unchanged, matched by identity or gone, and new findings are named', async () => {
  const first = [0, 1, 2, 3].map(i => finding(i));
  install(first);
  const planned = planClashGroupApply([
    { name: 'Routing', members: [manualClashOccurrenceKey(first[0]), manualClashOccurrenceKey(first[1])] },
    { name: 'Riser', members: [manualClashOccurrenceKey(first[2])] }], newWorkspaceBase('AI proposal'), first);
  assert.ok(planned.ok);
  const applied = await applyClashGroupPlan(planned.plan, { confirmMoves: false, origin: 'test', source: 'full-run', partial: false });
  assert.ok(applied.ok);
  const workspace = useClashGroupLibrary.getState().entries.find(entry => entry.id === applied.receipt.workspaceId)!;
  assert.equal(applicationContinuity(applied.receipt, workspace.groups, first).unchanged, true, 'the run at apply is unchanged');

  // Rerun: f-0 unchanged, f-1 gone, f-2 now reported against a revised MEP model (same GUID pair), f-3 kept, f-9 new.
  const second = [finding(0), finding(2, 'mep-rev-b'), finding(3), finding(9)];
  install(second);
  const report = applicationContinuity(applied.receipt, workspace.groups, second);
  assert.equal(report.unchanged, false);
  const [routing, riser] = report.groups;
  assert.deepEqual(routing.unchanged.map(clash => clash.id), ['f-0-mep']);
  assert.deepEqual(routing.gone.map(member => member.occurrenceKey), [manualClashOccurrenceKey(first[1])], 'gone members are listed, not dropped');
  assert.deepEqual(riser.reidentified.map(clash => clash.id), ['f-2-mep-rev-b'], 'a review-key fallback is shown, not silently reassigned');
  assert.deepEqual(report.newFindings?.map(clash => clash.id), ['f-9-mep'], 'f-3 was ungrouped at apply, so it is not new');
  // The report describes the native resolver's own outcome.
  assert.deepEqual(resolveManualClashGroups(workspace.groups, second).map(group => group.members.map(clash => clash.id)),
    [['f-0-mep'], ['f-2-mep-rev-b']]);
  assert.equal(workspace.groups[0].members.length, 2, 'membership of the gone finding is retained in the workspace');
});
