/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reviewed taxonomy edits on an AI clash grouping proposal (P10). A draft is
 * local to the review: renames, moves, splits and merges change only this
 * value until it is applied to a native grouping workspace. Every edit keeps
 * the partition invariant (one finding in at most one group) and the
 * accounting recomputes from the draft, never from the original answer.
 */

import type { Clash } from '@ifc-lite/clash';
import type { clashDisciplineCandidates } from './clash-taxonomy';
import type { ClashGroupPreview } from './clash-group-proposal';

export interface DraftFinding {
  /** Captured citation: `E12` for the discussion sample, `C2/E12` for a full-run chunk. */
  citation: string;
  occurrence: string;
  nativeType: Clash['status'];
  nativeSeverity: Clash['severity'];
  disciplineCandidates: ReturnType<typeof clashDisciplineCandidates>;
}

export interface DraftGroup {
  /** Review-local identity; never persisted. */
  key: string;
  name: string;
  /** AI rationale; empty for groups created during review. */
  explanation: string;
  members: string[];
}

/** Findings the run could not classify stay visible as their own counts. */
export type DraftOrigin =
  | { kind: 'sample'; evidenceId: string; omittedFromEvidence: number }
  | { kind: 'full-run'; partial: boolean; failed: number; notRun: number; unaddressable: number; chunks: number; mergedGroups: number };

export interface ClashGroupDraft {
  groups: DraftGroup[];
  /** Every finding the proposal placed; those in no group were unclassified during review. */
  findings: ReadonlyMap<string, DraftFinding>;
  totalFindings: number;
  origin: DraftOrigin;
  nextKey: number;
}

export interface DraftAccounting {
  groups: number;
  grouped: number;
  /** Native findings in no group: never proposed, sent back during review, or not addressable. */
  unclassified: number;
  /** Proposed findings the reviewer moved out of every group. */
  unclassifiedByReview: number;
  failed: number;
  notRun: number;
}

export type DraftEdit = { ok: true; draft: ClashGroupDraft } | { ok: false; reason: 'name-invalid' | 'name-taken' | 'no-findings' | 'unknown-group' };

const DRAFT_NAME_LIMIT = 100;

export function draftFromGroups(
  groups: ReadonlyArray<{ name: string; explanation: string; findings: readonly DraftFinding[] }>,
  totalFindings: number,
  origin: DraftOrigin,
): ClashGroupDraft {
  const findings = new Map<string, DraftFinding>();
  const draftGroups = groups.map((group, index) => {
    for (const finding of group.findings) {
      if (findings.has(finding.occurrence)) throw new Error('A finding cannot belong to two proposed groups');
      findings.set(finding.occurrence, finding);
    }
    return { key: `g${index + 1}`, name: group.name, explanation: group.explanation, members: group.findings.map(f => f.occurrence) };
  });
  return { groups: draftGroups, findings, totalFindings, origin, nextKey: draftGroups.length + 1 };
}

/** A sample preview becomes an editable draft; the preview itself stays the AI answer's record. */
export function draftFromPreview(preview: ClashGroupPreview): ClashGroupDraft {
  return draftFromGroups(preview.groups, preview.totalFindings,
    { kind: 'sample', evidenceId: preview.evidence.id, omittedFromEvidence: preview.omittedFromEvidence });
}

export function draftAccounting(draft: ClashGroupDraft): DraftAccounting {
  const grouped = draft.groups.reduce((sum, group) => sum + group.members.length, 0);
  const failed = draft.origin.kind === 'full-run' ? draft.origin.failed : 0;
  const notRun = draft.origin.kind === 'full-run' ? draft.origin.notRun : 0;
  return { groups: draft.groups.length, grouped, unclassified: draft.totalFindings - grouped - failed - notRun,
    unclassifiedByReview: draft.findings.size - grouped, failed, notRun };
}

/** Proposed findings currently in no group, in proposal order. */
export function draftUnclassified(draft: ClashGroupDraft): DraftFinding[] {
  const grouped = new Set(draft.groups.flatMap(group => group.members));
  return [...draft.findings.values()].filter(finding => !grouped.has(finding.occurrence));
}

function checkName(draft: ClashGroupDraft, name: string, except?: string): DraftEdit | string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > DRAFT_NAME_LIMIT) return { ok: false, reason: 'name-invalid' };
  const folded = trimmed.toLocaleLowerCase();
  if (draft.groups.some(group => group.key !== except && group.name.toLocaleLowerCase() === folded)) return { ok: false, reason: 'name-taken' };
  return trimmed;
}

export function renameDraftGroup(draft: ClashGroupDraft, key: string, name: string): DraftEdit {
  if (!draft.groups.some(group => group.key === key)) return { ok: false, reason: 'unknown-group' };
  const checked = checkName(draft, name, key);
  if (typeof checked !== 'string') return checked;
  return { ok: true, draft: { ...draft, groups: draft.groups.map(group => group.key === key ? { ...group, name: checked } : group) } };
}

/**
 * Move findings to one group, to a new group (a split when they come from one
 * group) or, with `null`, to unclassified. Groups emptied by the move disappear.
 */
export function moveDraftFindings(
  draft: ClashGroupDraft,
  occurrences: readonly string[],
  target: { group: string } | { newGroup: string } | null,
): DraftEdit {
  const moving = new Set(occurrences.filter(occurrence => draft.findings.has(occurrence)));
  if (!moving.size) return { ok: false, reason: 'no-findings' };
  if (target && 'group' in target && !draft.groups.some(group => group.key === target.group)) return { ok: false, reason: 'unknown-group' };
  let created: DraftGroup | null = null;
  if (target && 'newGroup' in target) {
    const checked = checkName(draft, target.newGroup);
    if (typeof checked !== 'string') return checked;
    created = { key: `g${draft.nextKey}`, name: checked, explanation: '', members: [] };
  }
  // Keep proposal order inside the destination, independent of selection order.
  const ordered = [...draft.findings.keys()].filter(occurrence => moving.has(occurrence));
  const groups: DraftGroup[] = [];
  let placed = false;
  for (const group of draft.groups) {
    const kept = group.members.filter(member => !moving.has(member));
    const next = target && 'group' in target && target.group === group.key ? { ...group, members: [...kept, ...ordered] } : { ...group, members: kept };
    if (next.members.length) groups.push(next);
    // A split lands directly after the first group it took findings from.
    if (created && !placed && kept.length !== group.members.length) { groups.push({ ...created, members: ordered }); placed = true; }
  }
  if (created && !placed) groups.push({ ...created, members: ordered });
  return { ok: true, draft: { ...draft, groups, nextKey: created ? draft.nextKey + 1 : draft.nextKey } };
}

/** Merge `source` into `target`: the target keeps its name and rationale, the source disappears. */
export function mergeDraftGroups(draft: ClashGroupDraft, source: string, target: string): DraftEdit {
  const from = draft.groups.find(group => group.key === source);
  if (!from || source === target || !draft.groups.some(group => group.key === target)) return { ok: false, reason: 'unknown-group' };
  return { ok: true, draft: { ...draft, groups: draft.groups.flatMap(group => group.key === source ? []
    : group.key === target ? [{ ...group, members: [...group.members, ...from.members] }] : [group]) } };
}
