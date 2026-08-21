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
