/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Apply reviewed AI clash groups to a native grouping workspace (P10).
 *
 * Planning is pure: it shows what the workspace partition becomes, including
 * findings that would leave groups that already exist there. Apply is one
 * atomic content transaction that writes the workspace at the planned
 * revision (CAS) together with a durable receipt; undo restores the previous
 * partition only while the workspace is still at the revision apply wrote.
 * Grouping never touches clash review decisions.
 */

import type { Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { readContentRows, writeContentBatch, type ContentFailure } from '../storage/content-database';
import { clashGroupLibrary, decodeClashGroupWorkspace, useClashGroupLibrary, type ClashGroupWorkspace } from './group-workspace';
import { manualClashMember, manualClashOccurrenceKey, resolveManualClashGroups, type ManualClashGroup, type ManualClashMember } from './manual-groups';
import { clashGroupApplicationLibrary, decodeClashGroupApplication, occurrenceHash, POPULATION_LIMIT, type ClashGroupApplication } from './group-applications';

export interface ApplyBase {
  id: string;
  name: string;
  /** Stored revision the plan was made against; 0 for a workspace that was never saved. */
  revision: number;
  workspace: ClashGroupWorkspace | null;
  created: boolean;
}

export interface ClashGroupApplyPlan {
  base: ApplyBase;
  after: ClashGroupWorkspace;
  clashes: readonly Clash[];
  added: Array<{ id: string; name: string; count: number }>;
  /** Existing groups losing findings to the proposal, with where they go. */
  moved: Array<{ from: string; to: string; count: number }>;
  movedFindings: number;
  /** Existing groups left empty by the moves; they disappear from the partition. */
  removedGroups: string[];
  keptGroups: number;
}

export type PlanRefusal = 'empty' | 'stale-findings' | 'partition-limits' | 'workspace-unavailable';
export type ApplyRefusal = 'confirmation-required' | 'stale-run' | 'storage-unavailable' | 'unsaved-edits' | 'workspace-changed' | ContentFailure;
export type UndoRefusal = 'already-undone' | 'storage-unavailable' | 'unsaved-edits' | 'workspace-changed' | 'receipt-missing' | ContentFailure;

/** Read the stored row behind a workspace id after the native library has opened. */
export async function readApplyBase(id: string, name: string): Promise<ApplyBase | null> {
  if (!(await clashGroupLibrary.initialize())) return null;
  const row = (await readContentRows('clashGroups')).find(candidate => candidate.id === id);
  if (row?.deleted) return null;
  const workspace = row ? decodeClashGroupWorkspace(row.payload) : null;
  if (row && !workspace) return null;
  return { id, name: workspace?.name ?? name, revision: row?.revision ?? 0, workspace, created: false };
}

export function newWorkspaceBase(name: string): ApplyBase {
  return { id: crypto.randomUUID(), name: name.trim(), revision: 0, workspace: null, created: true };
}

/**
 * The partition after apply: existing groups first (minus findings the
 * proposal takes), then the reviewed groups. Members carry the occurrence and
 * the durable review key, exactly like human-created groups.
 */
export function planClashGroupApply(
  groups: ReadonlyArray<{ name: string; members: readonly string[] }>,
  base: ApplyBase,
  clashes: readonly Clash[],
): { ok: true; plan: ClashGroupApplyPlan } | { ok: false; reason: PlanRefusal } {
  if (!base.name || base.name.length > 200) return { ok: false, reason: 'workspace-unavailable' };
  const proposed = groups.filter(group => group.members.length);
  if (!proposed.length) return { ok: false, reason: 'empty' };
  const native = new Map<string, Clash[]>();
  for (const clash of clashes) {
    const key = manualClashOccurrenceKey(clash);
    native.set(key, [...(native.get(key) ?? []), clash]);
  }
  const taken = new Map<Clash, string>();
  const added: ClashGroupApplyPlan['added'] = [];
  const written: ManualClashGroup[] = [];
  for (const group of proposed) {
    const members: ManualClashMember[] = [];
    for (const occurrence of group.members) {
      const matches = native.get(occurrence);
      if (matches?.length !== 1 || taken.has(matches[0])) return { ok: false, reason: 'stale-findings' };
      taken.set(matches[0], group.name);
      members.push(manualClashMember(matches[0]));
    }
    const id = `ai-${crypto.randomUUID()}`;
    written.push({ id, name: group.name, members });
    added.push({ id, name: group.name, count: members.length });
  }
  const existing = base.workspace?.groups ?? [];
  // A member the proposal claims leaves its existing group: by the live clash it
  // resolves to, by exact occurrence, or by a legacy review-key-only claim.
  const claimedOccurrences = new Map(written.flatMap(group => group.members.map(member => [member.occurrenceKey, group.name] as const)));
  const claimedReviews = new Map(written.flatMap(group => group.members.map(member => [member.reviewKey, group.name] as const)));
  const leaving = new Map<ManualClashMember, string>();
  for (const resolved of resolveManualClashGroups(existing, clashes)) {
    resolved.members.forEach((clash, index) => {
      const to = taken.get(clash);
      if (to) leaving.set(resolved.memberDefinitions[index], to);
    });
  }
  const moved = new Map<string, { from: string; to: string; count: number }>();
  const removedGroups: string[] = [];
  const kept: ManualClashGroup[] = [];
  for (const group of existing) {
    const members = group.members.filter(member => {
      const to = leaving.get(member) ?? claimedOccurrences.get(member.occurrenceKey)
        ?? (!member.occurrenceKey ? claimedReviews.get(member.reviewKey) : undefined);
      if (!to) return true;
      const key = JSON.stringify([group.id, to]);
      const entry = moved.get(key) ?? { from: group.name, to, count: 0 };
      entry.count++;
      moved.set(key, entry);
      return false;
    });
    if (members.length) kept.push({ ...group, members });
    else removedGroups.push(group.name);
  }
  const after = decodeClashGroupWorkspace({ version: 1, id: base.id, name: base.name, groups: [...kept, ...written] });
  if (!after) return { ok: false, reason: 'partition-limits' };
  const movedList = [...moved.values()];
  return { ok: true, plan: { base, after, clashes, added, moved: movedList,
    movedFindings: movedList.reduce((sum, entry) => sum + entry.count, 0), removedGroups, keptGroups: kept.length } };
}

/** Unsaved, failed or conflicting local drafts of a workspace are human work: never write over them. */
function hasLocalDraft(id: string): boolean {
  const item = useClashGroupLibrary.getState().status.items[id];
  return item !== undefined && item !== 'saved';
}

async function refreshLibraries(): Promise<void> {
  const refreshed = await Promise.all([clashGroupLibrary.refresh(), clashGroupApplicationLibrary.refresh()]);
  if (!refreshed.every(Boolean)) console.warn('[Clash groups] Applied content committed; refreshing the visible libraries failed');
}

export async function applyClashGroupPlan(plan: ClashGroupApplyPlan, options: {
  confirmMoves: boolean; origin: string; source: ClashGroupApplication['source']; partial: boolean;
}): Promise<{ ok: true; receipt: ClashGroupApplication } | { ok: false; reason: ApplyRefusal }> {
  if (plan.movedFindings > 0 && !options.confirmMoves) return { ok: false, reason: 'confirmation-required' };
  if (useViewerStore.getState().clashResult?.clashes !== plan.clashes) return { ok: false, reason: 'stale-run' };
  const ready = await Promise.all([clashGroupLibrary.initialize(), clashGroupApplicationLibrary.initialize()]);
  if (!ready.every(Boolean)) return { ok: false, reason: 'storage-unavailable' };
  if (hasLocalDraft(plan.base.id)) return { ok: false, reason: 'unsaved-edits' };
  const occurrences = plan.clashes.map(manualClashOccurrenceKey);
  const receipt: ClashGroupApplication = {
    version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), origin: options.origin, source: options.source,
    partial: options.partial, workspaceId: plan.base.id, workspaceName: plan.base.name, created: plan.base.created,
    baseRevision: plan.base.revision, appliedRevision: plan.base.revision + 1,
    before: plan.base.created ? null : plan.base.workspace ?? { version: 1, id: plan.base.id, name: plan.base.name, groups: [] },
    after: plan.after, addedGroupIds: plan.added.map(group => group.id), movedFindings: plan.movedFindings,
    population: occurrences.length <= POPULATION_LIMIT ? [...new Set(occurrences.map(occurrenceHash))] : null, status: 'applied',
  };
  const result = await writeContentBatch([
    { kind: 'clashGroups', id: plan.base.id, payload: plan.after, expected: plan.base.revision },
    { kind: 'clashGroupApplications', id: receipt.id, payload: receipt, expected: 0 },
  ]);
  if (!result.ok) return { ok: false, reason: result.reason === 'conflict' ? 'workspace-changed' : result.reason };
  await refreshLibraries();
  useClashGroupLibrary.setState({ activeId: plan.base.id });
  return { ok: true, receipt };
}

/**
 * Restore the partition a receipt replaced. Refuses unless the workspace is
 * still exactly at the revision the apply wrote: a later human edit, another
 * tab or an import is never overwritten.
 */
export async function undoClashGroupApplication(receipt: ClashGroupApplication):
  Promise<{ ok: true; receipt: ClashGroupApplication } | { ok: false; reason: UndoRefusal }> {
  if (receipt.status === 'undone') return { ok: false, reason: 'already-undone' };
  const ready = await Promise.all([clashGroupLibrary.initialize(), clashGroupApplicationLibrary.initialize()]);
  if (!ready.every(Boolean)) return { ok: false, reason: 'storage-unavailable' };
  if (hasLocalDraft(receipt.workspaceId)) return { ok: false, reason: 'unsaved-edits' };
  const [workspaces, receipts] = await Promise.all([readContentRows('clashGroups'), readContentRows('clashGroupApplications')]);
  const workspace = workspaces.find(row => row.id === receipt.workspaceId);
  const stored = receipts.find(row => row.id === receipt.id);
  if (!stored || stored.deleted) return { ok: false, reason: 'receipt-missing' };
  if (decodeClashGroupApplication(stored.payload)?.status === 'undone') return { ok: false, reason: 'already-undone' };
  if (!workspace || workspace.deleted || workspace.revision !== receipt.appliedRevision) return { ok: false, reason: 'workspace-changed' };
  const undone: ClashGroupApplication = { ...receipt, status: 'undone', undoneAt: new Date().toISOString() };
  const result = await writeContentBatch([
    // A created workspace is removed; an existing one gets its whole previous partition back.
    { kind: 'clashGroups', id: receipt.workspaceId, payload: receipt.created ? null : receipt.before, expected: receipt.appliedRevision },
    { kind: 'clashGroupApplications', id: receipt.id, payload: undone, expected: stored.revision },
  ]);
  if (!result.ok) return { ok: false, reason: result.reason === 'conflict' ? 'workspace-changed' : result.reason };
  await refreshLibraries();
  return { ok: true, receipt: undone };
}
