/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning content matches into *identity claims* (issue #1891).
 *
 * `matchUnpairedByContent` answers "these two entities look like the same
 * element" for one comparison and then forgets it, so the next run of the same
 * comparison re-derives everything from scratch. An identity map is the durable
 * form of that answer: `{ base, here, reason }` triples that a later diff can
 * consume as {@link DiffOptions.keyAliases}, so a re-GUIDed element is matched
 * by key and never reaches the content pass again.
 *
 * The vocabulary is deliberately the one the layer-PR provenance manifest
 * already uses — `IdentityMapEntry` in `@ifc-lite/ifcx`'s `provenance.ts`,
 * specced in `docs/architecture/layer-prs/03-provenance.md` §3.1 and
 * `04-identity.md` §4.1(2) — so an entry produced here can be written straight
 * into a layer's `identity_map` without translation. The interface is restated
 * rather than imported because `@ifc-lite/diff` is a leaf package with no
 * runtime dependencies and the shape is three strings; the *names* are what
 * must not fork.
 */

import type { ContentMatch, ContentMatchKind } from './types.js';

/**
 * One identity claim: "the entity known as {@link base} in the base revision is
 * the entity known as {@link here} in this one".
 *
 * Structurally identical to `IdentityMapEntry` in `@ifc-lite/ifcx`
 * (`packages/ifcx/src/provenance.ts`), which is what a published layer carries
 * in `identity_map`.
 */
export interface IdentityMapEntry {
  /** Entity identity (typically a `GlobalId`) in the base revision. */
  base: string;
  /** Entity identity in the head revision — "here". */
  here: string;
  /**
   * Human-readable provenance of the claim. Entries minted by
   * {@link identityMapFromContentMatches} use
   * `` `${CONTENT_MATCH_REASON_PREFIX}${kind}` `` so a reviewer (and a filter)
   * can tell an engine-derived claim from a hand-authored one, and can tell
   * *which* evidence produced it.
   */
  reason: string;
}

/**
 * Prefix on every {@link IdentityMapEntry.reason} minted from a content match.
 *
 * `04-identity.md` §4.1(3) reserves the bare string `"derived"` for the
 * content-derived identity *fallback*. That is a different claim from this one
 * and recording both as `"derived"` would erase the distinction, so these
 * entries name their evidence: the reason is `content-match:renamed`,
 * `content-match:moved`, or `content-match:reshaped`.
 */
export const CONTENT_MATCH_REASON_PREFIX = 'content-match:';

/**
 * The match kinds that may become an identity claim.
 *
 * These are exactly the *destructive* kinds — the ones where the engine already
 * committed to the pairing by retiring the `added`/`deleted` entries. The
 * reporting-only kinds are excluded on purpose:
 *
 * - `ambiguous` is the engine saying "several candidates on both sides and no
 *   principled pairing". Minting an identity from it is precisely the
 *   `?? candidates[0]` guess the pass exists to refuse (see #1923).
 * - `duplicated` / `deduplicated` are 1:N / N:1 by construction, and identity
 *   is not a relation that survives being split or merged. Which of the three
 *   copies "is" the original is not a question a content hash can answer.
 */
const CLAIMABLE_KINDS: ReadonlySet<ContentMatchKind> = new Set<ContentMatchKind>([
  'renamed',
  'moved',
  'reshaped',
]);

/**
 * Derive identity-map entries from the content matches of a
 * {@link ModelDiff} — the durable form of "we decided these are the same
 * element".
 *
 * Pure, order-preserving, and deliberately conservative. An entry is emitted
 * only for a match that is BOTH claimable ({@link CLAIMABLE_KINDS}) AND
 * one-to-one. Two exclusions carry the design:
 *
 * **Non-destructive kinds emit nothing.** `ambiguous`, `duplicated`, and
 * `deduplicated` are the engine's way of saying it could not tell. A claim
 * derived from an abstention is a fabrication, and — because the map is
 * consumed as a key alias on the next run — it would convert an honest
 * "here are the candidates, you decide" into a silent, unreviewable pairing.
 *
 * **N:N `renamed` groups emit nothing.** A group of `N` per side agreed on the
 * data hash and the world geometry hash `N` times over, which is exactly why
 * the engine reports it as a set rather than a pairing: every bijection between
 * the two sides is identical in every field the engine can see. Picking one
 * (even a deterministic one, sorted by key) would be arbitrary. It is tempting
 * to argue the choice is harmless *because* the members are indistinguishable,
 * but that is only true in this revision — an identity map is written down and
 * replayed, and the pairing starts to matter in the first later revision where
 * two of those members diverge, or where one of them carries downstream
 * annotation (a BCF topic, a review comment, a cost line). At that point a
 * coin-flip pairing silently swaps two elements' histories, and nothing in the
 * artifact records that it was a coin flip. `04-identity.md`: human-in-the-loop
 * identity beats wrong automatic identity. The group is still visible in
 * `ModelDiff.contentMatches`, so a UI can offer the human the pairing to
 * confirm; the engine simply will not mint it unattended.
 *
 * @param matches `ModelDiff.contentMatches` (accepts `undefined` so
 *   `identityMapFromContentMatches(diff.contentMatches)` is a valid call on a
 *   diff that never ran the content pass).
 */
export function identityMapFromContentMatches<TRef>(
  matches: Iterable<ContentMatch<TRef>> | undefined,
): IdentityMapEntry[] {
  if (!matches) return [];
  const entries: IdentityMapEntry[] = [];
  for (const match of matches) {
    if (!CLAIMABLE_KINDS.has(match.kind)) continue;
    if (match.base.length !== 1 || match.head.length !== 1) continue;
    const base = match.base[0].key;
    const here = match.head[0].key;
    // A pair that agrees on its key was matched by the key pass and never
    // reached the content pass, so this cannot normally happen — but a
    // self-alias is a no-op the consumer would have to filter anyway, and an
    // identity map is a reviewed artifact that should not carry noise.
    if (base === here) continue;
    entries.push({ base, here, reason: `${CONTENT_MATCH_REASON_PREFIX}${match.kind}` });
  }
  return entries;
}
