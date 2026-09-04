/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit MEMBERSHIP for a rule's A / B set.
 *
 * `ClashRule.a` / `.b` are type-name selectors, and a `ClashElement` carries
 * nothing but its type (`tag`), name and storey — so a selector cannot express
 * "walls whose `Pset_WallCommon.IsExternal` is true". A caller that DOES have
 * the model (the viewer resolves its advanced filter against the parsed store)
 * resolves such a set to element identities and hands them over as
 * `membersA` / `membersB`; the engine then partitions by membership instead of
 * by the selector, and everything downstream — severity, exclusions, dedup,
 * coverage, both kernels — is untouched.
 *
 * The identity is `(model, ref)`, not `key`. `ref` is what a caller holding a
 * `(modelId, expressId)` pair can compute directly (it is exactly what the
 * adapter derives it from), while `key` is built inside the adapter out of the
 * stored GlobalId plus an occurrence suffix and cannot be reconstructed from
 * the store alone. Two GPU-instanced occurrences of one entity share a `ref`
 * and both land in the set, which is the intended reading of "this entity is
 * in set A".
 *
 * An EMPTY member list is not the same as an absent one: `[]` means the filter
 * resolved to nothing and the side matches no element, while `undefined` means
 * no filter was given and the selector decides. Anything else would turn a
 * filter that matched nothing into a run over everything.
 */

import { matchesSelector } from './selectors.js';
import type { ClashElement } from './types.js';

/** The membership identity of one element: its model plus its `ref`. */
export function clashMemberKey(model: string, ref: number): string {
  // NUL separates: a model id can hold any character but this one, so no two
  // distinct (model, ref) pairs can collide on one string.
  return `${model}\u0000${ref}`;
}

/** Index a rule's member list; `null` when the side has no explicit members. */
export function clashMemberSet(
  members: readonly string[] | undefined,
): ReadonlySet<string> | null {
  return members ? new Set(members) : null;
}

/** Whether one element belongs to a rule side, by membership when the side has
 *  an explicit member set and by type selector otherwise. */
export function inClashSet(
  element: Pick<ClashElement, 'model' | 'ref' | 'tag'>,
  selector: string,
  members: ReadonlySet<string> | null,
): boolean {
  if (members) return members.has(clashMemberKey(element.model, element.ref));
  return matchesSelector(element.tag, selector);
}
