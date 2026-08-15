/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Key normalization for {@link DiffOptions.keyAliases} (issue #1891).
 *
 * An alias is a *claim* ("the head entity keyed `here` is the base entity keyed
 * `base`"), usually one a human accepted from a previous run's content matches.
 * Applying it is a rename of the head entity's diff key before the key-based
 * pass indexes anything, so an accepted pair is classified by key — modified or
 * unchanged — and never reaches the content pass at all.
 *
 * Every rejection rule here degrades to *today's* behaviour: the entity keeps
 * its own key and reads as an add/delete that the content pass may still pair.
 * A bad map therefore costs a caller the benefit of the alias, never a lost or
 * fabricated entity.
 */

import type { EntityFingerprint } from './types.js';

/**
 * Rewrite head keys through `aliases` (head key → base key).
 *
 * `headByKey` must already be deduplicated by key (the `indexByKey` first-wins
 * map), so aliasing operates on the entities the diff will actually classify
 * and a shadowed duplicate cannot claim a target.
 *
 * An alias is applied only when all of these hold; otherwise it is dropped and
 * the entity keeps its own key:
 *
 * 1. **The target is a non-empty string different from the head key.** A
 *    self-alias is a no-op; a non-string arrives only from an untyped JS caller.
 * 2. **The target exists in the base revision.** A stale map — the base entity
 *    was since deleted, or the map was written against a different base — must
 *    not conjure an entity. Renaming a head entity onto a key no base entity
 *    holds would turn a legitimate `added` into an `added` under someone else's
 *    name: a phantom, and a confusing one, because the key printed in the diff
 *    would belong to nothing in either file.
 * 3. **No live head entity already holds the target key.** That entity is going
 *    to be matched against the base key on its own, honest evidence; letting an
 *    alias claim the same identity would put two head entities on one base
 *    entity, and a `Map` would silently keep whichever was written last.
 * 4. **Exactly one head entity claims the target.** Two aliases onto one base
 *    key is the same collision arriving from the map instead of from the model.
 *
 * Rules 3 and 4 encode one decision: **on a collision the alias loses, and every
 * colliding entity stays unaliased.** A collision proves the map is wrong (a
 * base entity is one entity; it cannot be two head entities), and the only
 * options are to drop an entity, to pick a winner, or to refuse. Dropping is
 * silent data loss. Picking a winner is a guess with no evidence behind it —
 * the map, the thing that would have decided, is the thing now known to be
 * broken. Refusing leaves both entities visible as add/delete, which is exactly
 * what the caller would have seen without the map, and is the state a human can
 * act on.
 *
 * Rule 3 makes rule 4's fallback safe: because an accepted target is never any
 * head entity's own key, an entity reverting to its own key can never collide
 * with an accepted alias. Rejection therefore terminates in one pass instead of
 * cascading.
 *
 * Pure: returns a new map (insertion order preserved) and never mutates its
 * inputs. Returns `headByKey` itself when there is nothing to apply.
 */
export function resolveKeyAliases<TRef>(
  headByKey: Map<string, EntityFingerprint<TRef>>,
  baseByKey: ReadonlyMap<string, EntityFingerprint<TRef>>,
  aliases: ReadonlyMap<string, string> | undefined,
): { headByKey: Map<string, EntityFingerprint<TRef>>; applied: Map<string, string> } {
  const applied = new Map<string, string>();
  if (!aliases || aliases.size === 0) return { headByKey, applied };

  // Head key → target, for the aliases that survive rules 1-3.
  const proposed = new Map<string, string>();
  // Target → how many head entities want it (rule 4).
  const claims = new Map<string, number>();

  for (const headKey of headByKey.keys()) {
    const target = aliases.get(headKey);
    if (typeof target !== 'string' || target.length === 0) continue; // rule 1
    if (target === headKey) continue; // rule 1
    if (!baseByKey.has(target)) continue; // rule 2 — stale alias
    if (headByKey.has(target)) continue; // rule 3 — target is a live head key
    proposed.set(headKey, target);
    claims.set(target, (claims.get(target) ?? 0) + 1);
  }

  for (const [headKey, target] of proposed) {
    if (claims.get(target) === 1) applied.set(headKey, target);
  }
  if (applied.size === 0) return { headByKey, applied };

  const resolved = new Map<string, EntityFingerprint<TRef>>();
  for (const [headKey, entity] of headByKey) {
    resolved.set(applied.get(headKey) ?? headKey, entity);
  }
  return { headByKey: resolved, applied };
}
