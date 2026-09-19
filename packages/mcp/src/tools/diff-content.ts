/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model_diff`'s `by_content` half: the real `@ifc-lite/diff` engine run over
 * two loaded models (issue #1891), plus `split_merge` / `successors`
 * (issue #4956). Split out of `diff.ts` for size.
 *
 * **Data scope only.** This server has no geometry pipeline, so there is no
 * world geometry hash and no bounding box; `scope: 'data'` is the honest
 * description of what it can see, and every unambiguous 1:1 content match is
 * therefore reported as `renamed` rather than `moved`/`reshaped`. `split_merge`
 * and `successors` are geometry-only stages: they are threaded through to
 * `diffModels` so the params exist and cost nothing today, but on this server
 * they currently produce no claims either way (`diff.splitMerges` /
 * `diff.successors` stay `undefined`, the engine's abstention) — they start
 * producing claims the moment this server gains a geometry pass, with no
 * further plumbing change. See `diff-fingerprints.ts`.
 */

import { diffModels, type ContentMatch, type ContentMatchKind } from '@ifc-lite/diff';
import { buildModelFingerprints, type DiffRef } from './diff-fingerprints.js';
import { fallbackPairDuplicateAuthoredKeys } from './diff-authored-keys.js';
import { pendingMutationsField, type PendingOverlay } from '../overlay.js';
import type { LoadedModel } from '../context.js';

/** Default cap on the listed `contentMatches`. Per-kind totals are reported
 *  whole, so the cap bounds the payload without hiding anything. */
export const DEFAULT_MAX_MATCHES = 200;

/**
 * Default cap on the GlobalIds listed per side of one match.
 *
 * `max_matches` bounds how many groups come back, not how big one is, and a
 * `duplicated` / `deduplicated` / `ambiguous` group is a set of candidates that
 * in a repetitive model can run to thousands of entities on each side. Without
 * this, `max_matches: 1` could still return a model-sized payload and overflow
 * the context window the cap exists to protect.
 *
 * 20 is chosen against what the list is *for*. A group is the engine declining
 * to guess, so its members are a hand-off to the caller; twenty candidates on a
 * side is already past what anyone resolves by reading a list rather than by
 * querying the two models. The overwhelmingly common match is a 1:1 `renamed`
 * pair, which this never touches. Every group still reports `baseCount` and
 * `headCount` whole, computed before the cap for the same reason
 * `contentMatchCounts` is: truncation must never be what makes a model look
 * cleanly matched.
 */
export const DEFAULT_MAX_GROUP_MEMBERS = 20;

/**
 * Kinds an agent has to resolve itself, listed before the ones the engine
 * already retired. Truncating the list must never be what drops the
 * "we could not tell" groups.
 */
const UNRESOLVED_FIRST: ContentMatchKind[] = [
  'ambiguous',
  'duplicated',
  'deduplicated',
  'moved',
  'reshaped',
  'respecified',
  'renamed',
];

/** Run the real `@ifc-lite/diff` engine over two loaded models. See the
 *  module doc for the scope and abstention contract. */
export function contentDiff(
  left: LoadedModel,
  right: LoadedModel,
  overlays: { left: PendingOverlay | null; right: PendingOverlay | null },
  maxMatches: number,
  maxGroupMembers: number,
  keyProperty?: string,
  splitMerge?: boolean,
  successors?: boolean,
): Record<string, unknown> {
  // Authored keys (issue #4955): `prop:<value>` where the model maintains one,
  // GlobalId otherwise; a value two entities share is refused for both and
  // reported so the agent sees why those two fell back.
  const duplicateAuthoredKeys = new Map<string, number[]>();
  const adapter = { keyProperty, duplicateAuthoredKeys };
  const baseFingerprints = buildModelFingerprints(left.store, overlays.left, adapter);
  const headFingerprints = buildModelFingerprints(right.store, overlays.right, adapter);
  fallbackPairDuplicateAuthoredKeys(
    [
      { fingerprints: baseFingerprints, store: left.store },
      { fingerprints: headFingerprints, store: right.store },
    ],
    duplicateAuthoredKeys,
  );
  const diff = diffModels(
    baseFingerprints,
    headFingerprints,
    {
      scope: 'data',
      matchUnpairedByContent: true,
      detectSplitMerge: splitMerge,
      detectSuccessors: successors,
    },
  );

  const matches = [...(diff.contentMatches ?? [])].sort(
    (a: ContentMatch<DiffRef>, b: ContentMatch<DiffRef>) =>
      UNRESOLVED_FIRST.indexOf(a.kind) - UNRESOLVED_FIRST.indexOf(b.kind),
  );
  const byKind: Record<string, number> = {};
  for (const match of matches) byKind[match.kind] = (byKind[match.kind] ?? 0) + 1;

  return {
    scope: diff.scope,
    keyProperty: keyProperty ?? null,
    duplicateAuthoredKeys: [...duplicateAuthoredKeys.keys()].sort(),
    counts: diff.counts,
    // Whole totals, computed before the cap: an agent reading `contentMatches`
    // can always tell whether the list it got is the whole story.
    contentMatchCounts: byKind,
    contentMatches: matches.slice(0, maxMatches).map((match) => ({
      kind: match.kind,
      ifcType: match.base[0]?.ifcType ?? match.head[0]?.ifcType,
      // Groups are reported as groups. Collapsing a `duplicated` or
      // `ambiguous` set to a single pair would be the engine guessing, which
      // is exactly what it refuses to do (#1923). Long groups are cut to
      // `maxGroupMembers` per side and say so, whole size included, so a cut
      // group still reads as a group of that size.
      ...listSide('base', match.base, maxGroupMembers),
      ...listSide('head', match.head, maxGroupMembers),
      ...(match.distance !== undefined ? { distance: match.distance } : {}),
    })),
    truncatedMatches: Math.max(0, matches.length - maxMatches),
    // Absent (not `[]`) exactly when the stage did not run, or ran and the
    // geometry abstention fired — this server's current state, always, until
    // it has a geometry pipeline. The engine's "absent means not proved"
    // contract, preserved rather than flattened.
    splitMerges: diff.splitMerges?.map((claim) => ({
      kind: claim.kind,
      confidence: claim.confidence,
      whole: claim.whole.key,
      pieces: claim.pieces.map((piece) => piece.key),
    })),
    successors: diff.successors?.map((claim) => ({
      confidence: claim.confidence,
      base: claim.base.key,
      head: claim.head.key,
      overlap: claim.overlap,
      distance: claim.distance,
    })),
    // Uncommitted edits are folded into the comparison; saying how many there
    // are is what separates "the two files differ" from "this session has
    // edits it has not written yet". Absent when neither model has any.
    //
    // `pendingMutations` is the scalar every other payload carries; the split a
    // two-model comparison can additionally give lives under its own name rather
    // than overloading that one.
    ...pendingMutationsField(overlays.left, overlays.right),
    ...(overlays.left || overlays.right
      ? {
        pendingMutationsBySide: {
          base: overlays.left?.pendingMutations ?? 0,
          head: overlays.right?.pendingMutations ?? 0,
        },
      }
      : {}),
  };
}

/** One side of a match: the (capped) keys, the whole count, and whether the
 *  list was cut. Emits `base`/`baseCount`/`baseTruncated` (or `head…`). */
function listSide(
  side: 'base' | 'head',
  entities: ReadonlyArray<{ key: string }>,
  maxGroupMembers: number,
): Record<string, unknown> {
  return {
    [side]: entities.slice(0, maxGroupMembers).map((entity) => entity.key),
    [`${side}Count`]: entities.length,
    [`${side}Truncated`]: entities.length > maxGroupMembers,
  };
}

/** One-line human summary of the engine result, for the text block. */
export function describeCounts(content: Record<string, unknown>): string {
  const counts = content.counts as { added: number; modified: number; deleted: number; unchanged: number };
  const byKind = content.contentMatchCounts as Record<string, number>;
  const kinds = Object.entries(byKind).map(([kind, n]) => `${n} ${kind}`).join(', ');
  return `${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, `
    + `${counts.unchanged} unchanged`
    + (kinds ? `; content matches: ${kinds}` : '; no content matches');
}
