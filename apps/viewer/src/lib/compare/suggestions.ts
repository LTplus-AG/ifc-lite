/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rows for the Compare panel's **Suggestions** section (issue #4955): what the
 * engine found but would not decide.
 *
 * Three sources, one row shape:
 *
 * - **successor claims** (`diff.successors`): one deleted entity replaced in
 *   place by one added entity. Accept turns it into an identity-map entry
 *   (`successor:<confidence>`), "Not the same" hides it for the session.
 * - **split / merge claims** (`diff.splitMerges`): grouped display only. There
 *   is no Accept, because identity is not a relation that survives a split
 *   (`split-merge-types.ts`); the lineage sidecar carries these instead.
 * - **unresolved content groups** (`ambiguous` / `duplicated` /
 *   `deduplicated`): the engine's "several candidates, you decide". A user
 *   picks one base and one head out of the group and accepts THAT pair, with
 *   reason `accepted:ambiguous`, never `content-match:ambiguous`.
 *
 * Pure: names come through a callback, the accepted / rejected sets come in
 * as arguments, nothing here reads the store.
 */

import type {
  ContentMatch,
  ContentMatchKind,
  EntityFingerprint,
  IdentityMapEntry,
  SplitMergeClaim,
  SuccessorClaim,
  SuccessorConfidence,
} from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';
import { claimSignature } from './acceptedIdentity.js';
import { isRetiringMatch, MATCH_KIND_LABEL } from './contentMatches.js';

export type SuggestionKind = 'successor' | 'split' | 'merge' | ContentMatchKind;

/** One candidate a user can pick out of a group, with what to select in 3D. */
export interface SuggestionCandidate {
  key: string;
  name: string;
  ifcType: string;
  ref: CompareRef;
}

export interface SuggestionRow {
  /**
   * `suggest:<kind>:<base keys>><head keys>` - the row's IDENTITY, never its
   * position. A re-diff after an acceptance drops a row, and a position key
   * would hand the next row the dropped one's React state (its picked pair,
   * and with it a stale "decided"). Prefixed so it never collides with a
   * `DiffEntry.key` or a `match:` row key: it shares the panel's single
   * selected-key channel.
   */
  key: string;
  kind: SuggestionKind;
  /** The kind's label plus the numbers it rests on, e.g.
   *  `Replaced · footprint 0.81 · 0.02 m · agrees on Pset_WallCommon`. */
  evidence: string;
  ifcType: string;
  name: string;
  /** Present when a class changed on the way (successor or split/merge). */
  crossClass: boolean;
  /** Every entity the row stands for, for the click-to-select behaviour. */
  refs: CompareRef[];
  /** Candidates a 1:1 pair can be made from. A successor row has exactly one
   *  per side; a split / merge row has none (no Accept). */
  bases: SuggestionCandidate[];
  heads: SuggestionCandidate[];
  /** For a successor row: the confidence the accepted entry's reason carries. */
  confidence?: SuccessorConfidence;
}

/** Display form of a component key: `pset:Pset_WallCommon` → `Pset_WallCommon`. */
function componentLabel(key: string): string {
  return key.replace(/^(pset|qset):/, '');
}

const MAX_LISTED_COMPONENTS = 3;

/** `Replaced · footprint 0.81 · 0.02 m · agrees on Pset_WallCommon, type-assignment`. */
export function successorEvidence(claim: SuccessorClaim<unknown>): string {
  const parts = ['Replaced', `${claim.confidence} ${claim.overlap.toFixed(2)}`, `${claim.distance.toFixed(2)} m`];
  const agreeing = claim.agreeingComponents ?? [];
  if (agreeing.length > 0) {
    const listed = agreeing.slice(0, MAX_LISTED_COMPONENTS).map(componentLabel);
    const more = agreeing.length - listed.length;
    parts.push(`agrees on ${listed.join(', ')}${more > 0 ? ` +${more}` : ''}`);
  }
  return parts.join(' · ');
}

/** `Split into 3 · verified · Δvol −1.2%` / `Merged from 2 · extent`. */
export function splitMergeEvidence(claim: SplitMergeClaim<unknown>): string {
  const head = claim.kind === 'split'
    ? `Split into ${claim.pieces.length}`
    : `Merged from ${claim.pieces.length}`;
  const parts = [head, claim.confidence];
  if (claim.volumeResidual !== undefined) {
    const pct = claim.volumeResidual * 100;
    const sign = pct < 0 ? '−' : pct > 0 ? '+' : '';
    parts.push(`Δvol ${sign}${Math.abs(pct).toFixed(1)}%`);
  }
  return parts.join(' · ');
}

/** `Ambiguous · 2:3` — the group shape is the evidence: nothing pairs on its own. */
export function unresolvedEvidence(match: ContentMatch<unknown>): string {
  const parts = [MATCH_KIND_LABEL[match.kind], `${match.base.length}:${match.head.length}`];
  if (match.distance !== undefined && match.distance > 0) parts.push(`${match.distance.toFixed(3)} m`);
  return parts.join(' · ');
}

/**
 * What the user has already decided for this model pair, in the shape the
 * openness rule needs: an accepted pair binds BOTH its keys (identity is 1:1,
 * so `a` accepted as `c` leaves no `(a, d)` to decide), a refusal binds only
 * that one pair.
 */
export interface SuggestionDecisions {
  /** The accepted identity entries (`acceptedForPair`). */
  accepted: readonly IdentityMapEntry[];
  /** Signatures (`claimSignature`) of the refused pairs (`rejectedForPair`). */
  rejected: ReadonlySet<string>;
}

/** Is this (base, here) pair still undecided? Not if it was refused, and not
 *  if either key already has an accepted identity - `acceptCompareIdentity`
 *  would refuse it, so offering it would be offering a dead click. An
 *  accepted pair is gone for good once the re-run aliases it, but the row
 *  must vanish on the click, not one render later. */
export function pairIsUndecided(base: string, here: string, decisions: SuggestionDecisions): boolean {
  if (decisions.rejected.has(claimSignature(base, here))) return false;
  return !decisions.accepted.some((entry) => entry.base === base || entry.here === here);
}

export interface SuggestionRowsInput extends SuggestionDecisions {
  successors?: readonly SuccessorClaim<CompareRef>[];
  splitMerges?: readonly SplitMergeClaim<CompareRef>[];
  contentMatches?: readonly ContentMatch<CompareRef>[];
}

const keysOf = (side: readonly EntityFingerprint<unknown>[]): string => side.map((f) => f.key).join('+');

/**
 * Build the section's rows. Order: successors, then split / merge claims, then
 * unresolved groups, each in engine order (already deterministic).
 */
export function suggestionRows(
  input: SuggestionRowsInput,
  nameOf: (ref: CompareRef) => string,
): SuggestionRow[] {
  const candidate = (fp: EntityFingerprint<CompareRef>): SuggestionCandidate => ({
    key: fp.key,
    name: nameOf(fp.ref),
    ifcType: fp.ifcType || 'IfcProduct',
    ref: fp.ref,
  });
  const rows: SuggestionRow[] = [];

  for (const claim of input.successors ?? []) {
    if (!pairIsUndecided(claim.base.key, claim.head.key, input)) continue;
    rows.push({
      key: `suggest:successor:${claim.base.key}>${claim.head.key}`,
      kind: 'successor',
      evidence: successorEvidence(claim),
      ifcType: claim.head.ifcType || 'IfcProduct',
      name: nameOf(claim.head.ref) || nameOf(claim.base.ref),
      crossClass: !!claim.crossClass,
      refs: [claim.base.ref, claim.head.ref],
      bases: [candidate(claim.base)],
      heads: [candidate(claim.head)],
      confidence: claim.confidence,
    });
  }

  for (const claim of input.splitMerges ?? []) {
    const [bases, heads] = claim.kind === 'split' ? [[claim.whole], claim.pieces] : [claim.pieces, [claim.whole]];
    rows.push({
      key: `suggest:${claim.kind}:${keysOf(bases)}>${keysOf(heads)}`,
      kind: claim.kind,
      evidence: splitMergeEvidence(claim),
      ifcType: claim.whole.ifcType || 'IfcProduct',
      name: nameOf(claim.whole.ref),
      crossClass: !!claim.crossClass,
      refs: [claim.whole.ref, ...claim.pieces.map((piece) => piece.ref)],
      bases: [],
      heads: [],
    });
  }

  for (const match of input.contentMatches ?? []) {
    if (isRetiringMatch(match.kind)) continue;
    const sample = match.head[0] ?? match.base[0];
    if (!sample) continue;
    // Pairs the user already decided on are not offered again; a group whose
    // every pair is decided has nothing left to ask.
    const bases = match.base.map(candidate);
    const heads = match.head.map(candidate);
    const open = bases.some((b) => heads.some((h) => pairIsUndecided(b.key, h.key, input)));
    if (!open) continue;
    rows.push({
      key: `suggest:${match.kind}:${keysOf(match.base)}>${keysOf(match.head)}`,
      kind: match.kind,
      evidence: unresolvedEvidence(match),
      ifcType: sample.ifcType || 'IfcProduct',
      name: nameOf(sample.ref),
      crossClass: false,
      refs: [...match.base.map((f) => f.ref), ...match.head.map((f) => f.ref)],
      bases,
      heads,
    });
  }

  return rows;
}

/** Is this (base, here) pair one of the row's candidates and still undecided? */
export function pairIsOpen(
  row: SuggestionRow,
  base: string,
  here: string,
  decisions: SuggestionDecisions,
): boolean {
  if (!row.bases.some((b) => b.key === base) || !row.heads.some((h) => h.key === here)) return false;
  return pairIsUndecided(base, here, decisions);
}
