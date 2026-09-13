/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which model-tag memberships a clash run was COMPUTED ON (#4215).
 *
 * A clash set filter with a `modelTag` rule resolves its members from one
 * snapshot of the store (`evaluatorModelsFromState` in `useClash.runPresets`),
 * so re-tagging a model while the engine runs cannot move an element between
 * the sets halfway through. The flip side is that a finished result can be on
 * screen while the tags it was computed on have since changed — the rows are
 * still correct for the run that produced them, but no longer describe what
 * "Structure vs Architecture" would find NOW. This module lets the panel say
 * so instead of leaving the user to guess.
 *
 * Bound to the result object with a WeakMap for the reason
 * `federation-identity.ts` gives: a sibling store field can describe a result
 * that is no longer there; an entry keyed on the result cannot.
 */

import type { ClashSetFilters } from './set-filter.js';

/**
 * For each tag id the run's filters named: the ids of the models that carried
 * it. An `untagged` rule names no tag but still has an input — which models
 * carry ANY tag (the federation is fixed for a result, so that set moving is
 * exactly the untagged set moving) — recorded under {@link UNTAGGED_INPUT}.
 */
export type ClashModelTagInputs = ReadonlyMap<string, ReadonlySet<string>>;

/** Key of the "models carrying any tag" input an `untagged` rule depends on. Never a tag id (those are UUIDs). */
export const UNTAGGED_INPUT = 'untagged';

/** The tag ids every `modelTag` rule across `presets` refers to, plus {@link UNTAGGED_INPUT} when one is `untagged` (empty when none does). */
export function referencedModelTagIds(presets: readonly ClashSetFilters[]): Set<string> {
  const ids = new Set<string>();
  for (const p of presets) {
    for (const filter of [p.filterA, p.filterB]) {
      for (const rule of filter?.rules ?? []) {
        if (rule.kind !== 'modelTag') continue;
        if (rule.op === 'untagged') ids.add(UNTAGGED_INPUT);
        else for (const id of rule.tagIds) ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Snapshot the membership of every referenced tag from the SAME state the
 * evaluator's model list was built from. `null` when no filter names a tag —
 * a run with no tag inputs has nothing that can go stale here.
 */
export function captureModelTagInputs(
  presets: readonly ClashSetFilters[],
  assignments: ReadonlyMap<string, ReadonlySet<string>>,
): ClashModelTagInputs | null {
  const referenced = referencedModelTagIds(presets);
  if (referenced.size === 0) return null;
  return membershipOf(referenced, assignments);
}

function membershipOf(
  tagIds: ReadonlySet<string>,
  assignments: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const id of tagIds) out.set(id, new Set());
  for (const [modelId, tags] of assignments) {
    for (const id of tagIds) if (id === UNTAGGED_INPUT ? tags.size > 0 : tags.has(id)) out.get(id)!.add(modelId);
  }
  return out;
}

const inputs = new WeakMap<object, ClashModelTagInputs>();

/** Bind the inputs to the result they produced. Call at the publish site. */
export function rememberModelTagInputs(result: object, captured: ClashModelTagInputs | null): void {
  if (captured) inputs.set(result, captured);
  else inputs.delete(result);
}

/**
 * Have the memberships this result was computed on changed since? Compares
 * only the tags the run referenced, so tagging an unrelated model "Review" does
 * not cry wolf. A result with no recorded inputs (no tag rules, a fixture) is
 * never stale here.
 */
export function clashModelTagInputsChanged(
  result: object | null | undefined,
  assignments: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!result) return false;
  const captured = inputs.get(result);
  if (!captured) return false;
  const now = membershipOf(new Set(captured.keys()), assignments);
  for (const [tagId, then] of captured) {
    const current = now.get(tagId)!;
    if (current.size !== then.size) return true;
    for (const modelId of then) if (!current.has(modelId)) return true;
  }
  return false;
}
