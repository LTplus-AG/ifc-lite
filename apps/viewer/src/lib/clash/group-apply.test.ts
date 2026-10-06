/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clashReviewKey, summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { readContentRows } from '../storage/content-database';
import { createContentBackup, importContentBackup } from '../storage/content-backup';
import { clashGroupLibrary, DEFAULT_GROUP_WORKSPACE, useClashGroupLibrary, type ClashGroupWorkspace } from './group-workspace';
import { useClashGroupApplications } from './group-applications';
import { applyClashGroupPlan, newWorkspaceBase, planClashGroupApply, readApplyBase, undoClashGroupApplication } from './group-apply';
import { manualClashMember, manualClashOccurrenceKey, resolveManualClashGroups } from './manual-groups';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

function findings(count: number, model = 'mep'): Clash[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `f-${i}`, rule: 'coordination', status: 'hard', severity: 'major', distance: -0.01,
    a: { key: `A${i}`, ref: i + 1, model: 'arch', tag: 'IfcWall' }, b: { key: `B${i}`, ref: 1000 + i, model, tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }));
}
function install(clashes: Clash[]) {
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  // A human review decision that grouping must never touch.
  const reviews = new Map([[clashReviewKey(clashes[0]), { status: 'accepted' as const, updatedAt: 1 }]]);
  useViewerStore.setState({ clashResult: result, clashRawResult: result, clashReviews: reviews });
  return clashes;
}
const occ = (clash: Clash) => manualClashOccurrenceKey(clash);
async function storedWorkspace(id: string) {
  return (await readContentRows('clashGroups')).find(row => row.id === id);
}
const proposal = (clashes: Clash[]) => [{ name: 'Routing', members: [occ(clashes[0]), occ(clashes[1])] }, { name: 'Riser', members: [occ(clashes[2])] }];

// #6906: the default target is a new workspace, so human groups cannot be overwritten silently.
test('apply into a new workspace writes the partition and a durable receipt; undo removes it', async () => {
  const clashes = install(findings(6));
  const reviews = useViewerStore.getState().clashReviews;
  const planned = planClashGroupApply(proposal(clashes), newWorkspaceBase('AI proposal 2026-10-05'), clashes);
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.moved, []);
  const applied = await applyClashGroupPlan(planned.plan, { confirmMoves: false, origin: 'assistant:test', source: 'sample', partial: false });
  assert.ok(applied.ok);
  const { receipt } = applied;
  const row = await storedWorkspace(receipt.workspaceId);
  assert.equal(row?.revision, 1);
  const stored = row!.payload as ClashGroupWorkspace;
  assert.deepEqual(stored.groups.map(group => group.name), ['Routing', 'Riser']);
  assert.deepEqual(resolveManualClashGroups(stored.groups, clashes).map(group => group.members.map(clash => clash.id)), [['f-0', 'f-1'], ['f-2']],
    'applied members resolve to the native findings through the native resolver');
  assert.equal((await readContentRows('clashGroupApplications')).find(entry => entry.id === receipt.id)?.revision, 1);
  assert.equal(useClashGroupLibrary.getState().activeId, receipt.workspaceId, 'the applied workspace becomes visible');
  assert.ok(useClashGroupApplications.getState().entries.some(entry => entry.id === receipt.id));
  assert.equal(receipt.created, true);
  assert.equal(receipt.before, null);
  assert.equal(useViewerStore.getState().clashReviews, reviews, 'grouping never changes review decisions');

  const undone = await undoClashGroupApplication(receipt);
  assert.ok(undone.ok);
  assert.equal((await storedWorkspace(receipt.workspaceId))?.deleted, true);
  assert.ok(!useClashGroupLibrary.getState().entries.some(entry => entry.id === receipt.workspaceId));
  assert.equal(useClashGroupLibrary.getState().activeId, DEFAULT_GROUP_WORKSPACE);
  assert.equal(useClashGroupApplications.getState().entries.find(entry => entry.id === receipt.id)?.status, 'undone');
  assert.deepEqual(await undoClashGroupApplication(receipt), { ok: false, reason: 'already-undone' }, 'the stored receipt decides');
  assert.equal(useViewerStore.getState().clashReviews, reviews);
});

test('applying into a human workspace needs confirmation to move findings out of its groups; undo restores it exactly', async () => {
  const clashes = install(findings(6));
  const human: ClashGroupWorkspace = { version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Coordination',
    groups: [{ id: 'human', name: 'Level 1', members: [manualClashMember(clashes[0]), manualClashMember(clashes[3])] },
      { id: 'solo', name: 'Shaft', members: [manualClashMember(clashes[2])] }] };
  assert.equal(await clashGroupLibrary.put(DEFAULT_GROUP_WORKSPACE, human), true);
  const base = await readApplyBase(DEFAULT_GROUP_WORKSPACE, 'Manual clash groups');
  assert.equal(base?.revision, 1);
  const planned = planClashGroupApply(proposal(clashes), base!, clashes);
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.moved, [{ from: 'Level 1', to: 'Routing', count: 1 }, { from: 'Shaft', to: 'Riser', count: 1 }]);
  assert.deepEqual(planned.plan.removedGroups, ['Shaft']);
  assert.equal(planned.plan.keptGroups, 1);

  const options = { origin: 'assistant:test', source: 'sample' as const, partial: false };
  assert.deepEqual(await applyClashGroupPlan(planned.plan, { ...options, confirmMoves: false }), { ok: false, reason: 'confirmation-required' });
  assert.equal((await storedWorkspace(DEFAULT_GROUP_WORKSPACE))?.revision, 1, 'a refused apply writes nothing');
  assert.equal((await readContentRows('clashGroupApplications')).length, 0);

  const applied = await applyClashGroupPlan(planned.plan, { ...options, confirmMoves: true });
  assert.ok(applied.ok);
  const after = (await storedWorkspace(DEFAULT_GROUP_WORKSPACE))!.payload as ClashGroupWorkspace;
  assert.deepEqual(after.groups.map(group => [group.name, group.members.length]), [['Level 1', 1], ['Routing', 2], ['Riser', 1]]);
  assert.equal(applied.receipt.movedFindings, 2);
  assert.deepEqual(applied.receipt.before, human);

  const undone = await undoClashGroupApplication(applied.receipt);
  assert.ok(undone.ok);
  const restored = await storedWorkspace(DEFAULT_GROUP_WORKSPACE);
  assert.deepEqual(restored?.payload, human, 'undo restores the whole previous partition');
  assert.equal(restored?.revision, 3);
  assert.deepEqual(useClashGroupLibrary.getState().entries.find(entry => entry.id === DEFAULT_GROUP_WORKSPACE), human);
});

test('CAS: a workspace changed after planning refuses apply; changed after apply refuses undo', async () => {
  const clashes = install(findings(6));
  const base = await readApplyBase(DEFAULT_GROUP_WORKSPACE, 'Manual clash groups');
  assert.equal(base?.revision, 0, 'a never-saved workspace plans against revision 0');
  const planned = planClashGroupApply(proposal(clashes), base!, clashes);
  assert.ok(planned.ok);
  const options = { confirmMoves: true, origin: 'assistant:test', source: 'sample' as const, partial: false };
  // A human creates a group in the same workspace after the preview was shown.
  const human: ClashGroupWorkspace = { version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Manual clash groups',
    groups: [{ id: 'human', name: 'Late edit', members: [manualClashMember(clashes[5])] }] };
  assert.equal(await clashGroupLibrary.put(DEFAULT_GROUP_WORKSPACE, human), true);
  assert.deepEqual(await applyClashGroupPlan(planned.plan, options), { ok: false, reason: 'workspace-changed' });
  assert.deepEqual((await storedWorkspace(DEFAULT_GROUP_WORKSPACE))?.payload, human, 'human work survives');
  assert.equal((await readContentRows('clashGroupApplications')).length, 0, 'no receipt for a refused apply');

  const replanned = planClashGroupApply(proposal(clashes), (await readApplyBase(DEFAULT_GROUP_WORKSPACE, 'x'))!, clashes);
  assert.ok(replanned.ok);
  const applied = await applyClashGroupPlan(replanned.plan, options);
  assert.ok(applied.ok);
  // Another edit after apply: undo must not overwrite it.
  const later = { ...(await storedWorkspace(DEFAULT_GROUP_WORKSPACE))!.payload as ClashGroupWorkspace };
  later.groups = later.groups.map(group => group.name === 'Riser' ? { ...group, name: 'Riser (renamed)' } : group);
  assert.equal(await clashGroupLibrary.put(DEFAULT_GROUP_WORKSPACE, later), true);
  assert.deepEqual(await undoClashGroupApplication(applied.receipt), { ok: false, reason: 'workspace-changed' });
  assert.deepEqual((await storedWorkspace(DEFAULT_GROUP_WORKSPACE))?.payload, later);
  assert.equal((await readContentRows('clashGroupApplications')).find(row => row.id === applied.receipt.id)?.revision, 1, 'the receipt stays applied');
});

test('a changed run, unsaved drafts and stale findings refuse before anything is written', async () => {
  const clashes = install(findings(6));
  const planned = planClashGroupApply(proposal(clashes), newWorkspaceBase('AI'), clashes);
  assert.ok(planned.ok);
  const options = { confirmMoves: false, origin: 'assistant:test', source: 'sample' as const, partial: false };
  install(findings(6));
  assert.deepEqual(await applyClashGroupPlan(planned.plan, options), { ok: false, reason: 'stale-run' });
  const current = useViewerStore.getState().clashResult!.clashes;
  assert.deepEqual(planClashGroupApply([{ name: 'Ghost', members: ['["coordination","x"]'] }], newWorkspaceBase('AI'), current),
    { ok: false, reason: 'stale-findings' });
  assert.deepEqual(planClashGroupApply([{ name: 'Empty', members: [] }], newWorkspaceBase('AI'), current), { ok: false, reason: 'empty' });
  // A staged (unsaved) human draft of the target workspace is never written over.
  await clashGroupLibrary.initialize();
  clashGroupLibrary.stage(DEFAULT_GROUP_WORKSPACE, { version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Draft',
    groups: [{ id: 'draft', name: 'Unsaved', members: [manualClashMember(current[4])] }] });
  const base = await readApplyBase(DEFAULT_GROUP_WORKSPACE, 'Manual clash groups');
  const onDraft = planClashGroupApply(proposal(current), base!, current);
  assert.ok(onDraft.ok);
  assert.deepEqual(await applyClashGroupPlan(onDraft.plan, options), { ok: false, reason: 'unsaved-edits' });
  assert.equal(await storedWorkspace(DEFAULT_GROUP_WORKSPACE), undefined);
});

// #6906: an imported receipt can point at a workspace that sits at the same revision number with other
// content (imports reset revisions to 1; the default workspace id is shared by every install). Undo must not replace it.
test('undo refuses when the workspace is at the applied revision but no longer holds what the apply wrote', async () => {
  const clashes = install(findings(6));
  const human: ClashGroupWorkspace = { version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Coordination',
    groups: [{ id: 'human', name: 'Level 1', members: [manualClashMember(clashes[4])] }] };
  assert.equal(await clashGroupLibrary.put(DEFAULT_GROUP_WORKSPACE, human), true);
  assert.equal((await storedWorkspace(DEFAULT_GROUP_WORKSPACE))?.revision, 1);
  const planned = planClashGroupApply(proposal(clashes), newWorkspaceBase('AI'), clashes);
  assert.ok(planned.ok);
  const applied = await applyClashGroupPlan(planned.plan, { confirmMoves: false, origin: 'assistant:test', source: 'sample', partial: false });
  assert.ok(applied.ok);
  assert.equal(applied.receipt.appliedRevision, 1);
  const rebound = { ...applied.receipt, workspaceId: DEFAULT_GROUP_WORKSPACE, created: false,
    before: { version: 1 as const, id: DEFAULT_GROUP_WORKSPACE, name: 'Coordination', groups: [] } };
  assert.deepEqual(await undoClashGroupApplication(rebound), { ok: false, reason: 'workspace-changed' });
  assert.deepEqual((await storedWorkspace(DEFAULT_GROUP_WORKSPACE))?.payload, human, 'human work survives');
});

test('a clash run replaced while storage initializes refuses apply before anything is written', async () => {
  const clashes = install(findings(6));
  const planned = planClashGroupApply(proposal(clashes), newWorkspaceBase('AI'), clashes);
  assert.ok(planned.ok);
  const initialize = clashGroupLibrary.initialize;
  clashGroupLibrary.initialize = async () => { const ready = await initialize(); install(findings(6)); return ready; };
  try {
    assert.deepEqual(await applyClashGroupPlan(planned.plan, { confirmMoves: false, origin: 'assistant:test', source: 'sample', partial: false }),
      { ok: false, reason: 'stale-run' });
  } finally { clashGroupLibrary.initialize = initialize; }
  assert.equal((await readContentRows('clashGroupApplications')).length, 0, 'no receipt for a refused apply');
});

// #6906: a backup applied into the shared default workspace, imported where that id already holds other groups,
// lands as a copy under a new id; its receipt must follow the copy so it is listed with it and can undo it.
test('an imported receipt follows its workspace when the import gives the workspace a new id', async () => {
  const clashes = install(findings(6));
  const planned = planClashGroupApply(proposal(clashes), (await readApplyBase(DEFAULT_GROUP_WORKSPACE, 'Coordination'))!, clashes);
  assert.ok(planned.ok);
  const applied = await applyClashGroupPlan(planned.plan, { confirmMoves: true, origin: 'assistant:test', source: 'sample', partial: false });
  assert.ok(applied.ok);
  const workspace = (await storedWorkspace(DEFAULT_GROUP_WORKSPACE))!.payload as ClashGroupWorkspace;
  // As written by another install: the same receipt shape under its own id.
  const foreign = { ...applied.receipt, id: 'receipt-from-another-install' };
  const backup = createContentBackup({ validation: [], comparison: [], document: [], clashGroups: [workspace], clashGroupApplications: [foreign] });
  // This install's default workspace now holds different human groups.
  const local: ClashGroupWorkspace = { version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Local', groups: [{ id: 'mine', name: 'Mine', members: [manualClashMember(clashes[5])] }] };
  assert.equal(await clashGroupLibrary.put(DEFAULT_GROUP_WORKSPACE, local), true);
  await importContentBackup(backup);
  const copies = (await readContentRows('clashGroups')).filter(row => row.id !== DEFAULT_GROUP_WORKSPACE && !row.deleted);
  assert.equal(copies.length, 1, 'the imported workspace is an independent copy');
  const receipts = (await readContentRows('clashGroupApplications')).filter(row => row.id === foreign.id);
  assert.equal(receipts.length, 1);
  const imported = receipts[0].payload as typeof applied.receipt;
  assert.equal(imported.workspaceId, copies[0].id, 'the receipt names the copy, not the local workspace');
  assert.equal(imported.after.id, copies[0].id);
  assert.deepEqual((await storedWorkspace(DEFAULT_GROUP_WORKSPACE))?.payload, local, 'the local workspace is untouched');
});
