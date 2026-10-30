/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public declarations; the implementation lives in Rust (#8042).
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
 * `content-match:moved`, `content-match:reshaped` or `content-match:respecified`.
 */
export const CONTENT_MATCH_REASON_PREFIX = 'content-match:';

/**
 * Prefix on every {@link IdentityMapEntry.reason} minted from an ACCEPTED
 * successor claim: `successor:footprint` or `successor:position`. Distinct
 * from {@link CONTENT_MATCH_REASON_PREFIX} so a filter can tell an
 * engine-committed pairing from a heuristic one a human accepted.
 */
export const SUCCESSOR_REASON_PREFIX = 'successor:';

/**
 * Reason for an entry a human minted out of a group the engine reported as
 * `ambiguous` / `duplicated` / `deduplicated`. Never `content-match:ambiguous`
 * — that would record an engine-committed pairing where there was none.
 */
export const ACCEPTED_AMBIGUOUS_REASON = 'accepted:ambiguous';
