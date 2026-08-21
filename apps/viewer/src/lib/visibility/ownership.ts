/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who owns the SHARED visibility channels, expressed once.
 *
 * `isolatedEntities` / `ghostExceptEntities` (visibilitySlice) are shared by
 * clash, IDS, "Isolate in 3D" (#2532), assembly isolation (#2531),
 * `LayerDiffView`, Space Sketch's `useSpaceGhostPreview`, BCF and
 * `syncSourceModel`'s post-removal purge. A feature's teardown may therefore
 * only release a presentation IT ITSELF installed.
 *
 * Clash worked that out first, in painful detail (`lib/clash/visibility-
 * ownership.ts`, #2654 / #2662) — record what you installed, test ownership by
 * VALUE rather than by `Set` reference or by "was my feature active", and
 * release only on a match. IDS's per-row focus (#2867) needs exactly the same
 * predicate over its own record. This module is that predicate, once: two
 * subsystems that must agree about a shared channel cannot drift apart if
 * there is only one implementation for them to drift from.
 */

/** Which shared channel a presentation was installed into. */
export type VisibilityChannel = 'ghost' | 'isolate';

/**
 * What a feature last installed into a shared visibility channel, and which
 * one. `null` means the feature owns neither channel — including after a
 * full-context "highlight" focus, which deliberately takes ownership of
 * nothing.
 *
 * The installed CONTENT is kept, not just the channel name, because ownership
 * is tested by value: see {@link ownsCurrentVisibility}.
 */
export type VisibilityOwnership =
  | { channel: VisibilityChannel; ids: ReadonlySet<number> }
  | null;

/**
 * Content equality for an ownership record. The shared channels are only ever
 * REPLACED wholesale (every slice setter stores a fresh `Set`), never mutated
 * in place, so equal members mean the channel still shows exactly the
 * presentation that was installed.
 *
 * Ownership is tested by VALUE, not by `Set` reference: reference identity
 * would be exact, but it is destroyed by every flow that snapshots and later
 * restores the channel with equal content in a fresh `Set` — Space Sketch's
 * open/close view capture (`useSpaceSceneFraming` clones the prior sets and
 * replays them through the cloning slice setters) and a source-model resync
 * (`syncSourceModel` rebuilds the kept sets even when nothing was filtered).
 * Under reference identity those flows silently converted a feature-owned
 * focus into "user" state, so the next run replaced the result set but left
 * the old presentation isolated/ghosted (#2662 P2). Value identity survives
 * any content-preserving rewrite, and its one false positive is harmless by
 * construction: it only fires when the channel shows EXACTLY what was
 * installed, in which case releasing it renders precisely what discarding that
 * presentation should render.
 */
export function sameMembers(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** The channel surface a release reads and writes. Every member is optional:
 *  slice-level tests drive store actions through harnesses that stub `get()`
 *  with a single slice, so a slice reaching across must tolerate genuinely
 *  absent fields rather than assume the combined store. */
export interface VisibilityChannels {
  ghostExceptEntities?: Set<number> | null;
  isolatedEntities?: Set<number> | null;
  clearGhost?: () => void;
  clearIsolation?: () => void;
}

/**
 * Does the channel named by `owned` still show exactly what was installed?
 *
 * A record that no longer matches is NOT inert — ownership is tested by VALUE,
 * so a stale record goes matching → cleared → MATCHING AGAIN as soon as any
 * other owner installs a set with equal content (#2654 fourth review). Every
 * caller therefore drops its record as it releases, whatever this answers.
 */
export function ownsCurrentVisibility(
  state: VisibilityChannels,
  owned: VisibilityOwnership,
): boolean {
  if (!owned) return false;
  const current =
    owned.channel === 'isolate'
      ? state.isolatedEntities ?? null
      : state.ghostExceptEntities ?? null;
  return current !== null && sameMembers(current, owned.ids);
}

/**
 * Clear the shared channel `owned` names — and ONLY if it still holds exactly
 * what was installed. Isolation or ghosting established by another feature
 * does not content-match, so it survives untouched.
 *
 * The RECORD is not touched here: every caller nulls its own record
 * unconditionally afterwards (a stale record is dangerous, see
 * {@link ownsCurrentVisibility}), and the record lives in the caller's own
 * slice under the caller's own field name.
 *
 * @returns whether a channel was actually released — i.e. whether the caller
 *   was still, verifiably, the owner.
 */
export function releaseOwnedVisibility(
  state: VisibilityChannels,
  owned: VisibilityOwnership,
): boolean {
  if (!ownsCurrentVisibility(state, owned)) return false;
  if (owned!.channel === 'isolate') state.clearIsolation?.();
  else state.clearGhost?.();
  return true;
}

/**
 * Every store field that holds one of these records, so a THIRD subsystem
 * recording a claim on the same two channels is invalidated by construction
 * rather than by remembering to extend a list somewhere else.
 */
export interface OwnedVisibilityRecords {
  idsFocusVisibilityOwned?: VisibilityOwnership;
  clashVisibilityOwned?: VisibilityOwnership;
}

const OWNERSHIP_RECORD_FIELDS = [
  'idsFocusVisibilityOwned',
  'clashVisibilityOwned',
] as const satisfies readonly (keyof OwnedVisibilityRecords)[];

/**
 * The record fields a channel write has just made STALE — the one shared
 * invalidation point (review of #2867).
 *
 * A record that outlives its presentation is not inert. Ownership is tested by
 * VALUE, so it goes matching → cleared → MATCHING AGAIN the moment any other
 * owner installs a set with equal content, and the next release then destroys
 * THAT owner's presentation (#2654 fourth review). Each subsystem already drops
 * its OWN record as it releases, and IDS's set-level isolate drops the row
 * focus's — but nothing dropped a record when a DIFFERENT owner replaced the
 * channel underneath it. Three running reproductions, one per direction:
 * clash's `focusClash` over an IDS row focus, `useClash.clearHighlight()` over
 * one, and an IDS row focus over a clash ghost.
 *
 * Fixing that per caller is one direction of a two-way rule, and the next owner
 * of the channel reintroduces it. So it is answered where the channels are
 * actually written instead — and for EVERY record symmetrically, not for the
 * one that happened to be reported. "Where they are written" is the store's own
 * `set`, wrapped once in `store/visibility-invalidation.ts`: a list of writing
 * ACTIONS was tried first and was already incomplete on the day it was written
 * (`showAllInAllModels`, and ten actions in `pinboardSlice`).
 *
 * Invalidation is by CONTENT, not by "somebody wrote": `next` is the state the
 * channels are about to hold, and a record still content-matching it survives.
 * That is what keeps the content-preserving rewrites alive — Space Sketch's
 * open/close view capture and `syncSourceModel`'s rebuild both replay an
 * unchanged channel through these setters, and under a blanket "any write
 * invalidates" rule they would silently convert a feature-owned focus into
 * "user" state, which is #2662 P2 again. It is also why this cannot strand a
 * presentation the way an unconditional null would: every installer writes the
 * CHANNEL first and its record second (`useClash.installClashIsolation` /
 * `installClashGhost`, `useIDS.installFocusIsolation` / `installFocusGhost`),
 * so a record can never be invalidated by the very write that installed it.
 * (The middleware also leaves a record the patch itself carries alone, so an
 * installer that committed both in ONE `set()` would be safe too.)
 *
 * @returns a partial state patch — `{}` when nothing went stale, so the common
 *   case adds no keys to the `set()` and slice-level harnesses that stub `get()`
 *   without these fields are unaffected.
 */
export function staleOwnershipReset(
  records: OwnedVisibilityRecords,
  next: Pick<VisibilityChannels, 'isolatedEntities' | 'ghostExceptEntities'>,
): Partial<OwnedVisibilityRecords> {
  const reset: Partial<OwnedVisibilityRecords> = {};
  for (const field of OWNERSHIP_RECORD_FIELDS) {
    const owned = records[field];
    if (owned && !ownsCurrentVisibility(next, owned)) reset[field] = null;
  }
  return reset;
}
