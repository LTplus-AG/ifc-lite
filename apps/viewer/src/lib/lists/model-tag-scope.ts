/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A list's MODEL TAG scope (#4215): which of the federation's models a list
 * runs over, decided by the models' user-facing tags with the same four
 * predicates search and clash use (`lib/model-tags/types.ts`), so "Structure"
 * means the same set of models in a quantity list as in a clash rule.
 *
 * Lists have their own data-provider integration — one provider per model
 * (`ListPanel.modelProviderPairs`) — so a `modelTag` search rule alone does
 * not scope a list; this decides which providers the run is handed.
 *
 * Unresolved references are refused, never widened: a scope naming a tag
 * that no longer exists resolves to an error the panel shows, and the list
 * is not run — running it over every model, or over none with nothing on
 * screen to say why, would both misreport what the list covers.
 */

import type { ListDefinition, ListModelTagScope } from '@ifc-lite/lists';
import { modelTagRuleMatches, unresolvedModelTagIds, type ModelTag, type ModelTagOp } from '../model-tags/types.js';

// The package type and the viewer's operator set are the same four words;
// this fails to compile if either side ever changes alone.
const _sameOps: ListModelTagScope['op'] extends ModelTagOp ? (ModelTagOp extends ListModelTagScope['op'] ? true : never) : never = true;
void _sameOps;

/** The slice of store state a scope resolves against. Structural so tests need no store. */
export interface ListModelTagState {
  models: ReadonlyMap<string, unknown>;
  modelTags: ReadonlyMap<string, ModelTag>;
  modelTagAssignments: ReadonlyMap<string, ReadonlySet<string>>;
}

export type ResolvedListModelTagScope =
  /** No scope: every model. */
  | { kind: 'all' }
  /** The loaded models in scope, in federation order — possibly none. */
  | { kind: 'models'; modelIds: ReadonlySet<string> }
  /** The scope names tags that no longer exist; the list must not run. */
  | { kind: 'unresolved'; tagIds: string[] };

export function resolveListModelTagScope(
  scope: ListModelTagScope | undefined,
  state: ListModelTagState,
): ResolvedListModelTagScope {
  if (!scope) return { kind: 'all' };
  const defined = new Set(state.modelTags.keys());
  const unresolved = unresolvedModelTagIds(scope, defined);
  if (unresolved.length > 0) return { kind: 'unresolved', tagIds: unresolved };
  const modelIds = new Set<string>();
  for (const modelId of state.models.keys()) {
    if (modelTagRuleMatches(scope.op, scope.tagIds, state.modelTagAssignments.get(modelId), defined)) modelIds.add(modelId);
  }
  return { kind: 'models', modelIds };
}

/**
 * The subset of `pairs` (anything carrying a `modelId`) a list runs over.
 * Throws — with the reason the panel shows — when the scope is unresolved or
 * selects no loaded model: an empty scope is not an empty result, it is a
 * list that never looked at anything, and the user must be told which.
 */
export function scopeModelPairs<T extends { modelId: string }>(
  definition: Pick<ListDefinition, 'modelTagScope'>,
  pairs: readonly T[],
  state: ListModelTagState,
): T[] {
  const resolved = resolveListModelTagScope(definition.modelTagScope, state);
  if (resolved.kind === 'all') return [...pairs];
  if (resolved.kind === 'unresolved') {
    const n = resolved.tagIds.length;
    throw new Error(
      `This list's model tag scope names ${n === 1 ? 'a tag' : `${n} tags`} that no longer exist${n === 1 ? 's' : ''}. ` +
        'Edit the list scope — it was not run rather than run over models it never named.',
    );
  }
  const scoped = pairs.filter((p) => resolved.modelIds.has(p.modelId));
  if (scoped.length === 0) {
    throw new Error(
      `No loaded model matches this list's model tag scope (${describeListModelTagScope(definition.modelTagScope!, state.modelTags)}). Nothing was run.`,
    );
  }
  return scoped;
}

/**
 * "models that have any of Structure, MEP" — the scope hint under the
 * builder's select, and the empty-scope message. Same words as the advanced
 * filter's operator labels (has any of / has all of / has none of / is untagged).
 */
export function describeListModelTagScope(scope: ListModelTagScope, tags: ReadonlyMap<string, ModelTag>): string {
  if (scope.op === 'untagged') return 'untagged models';
  const names = scope.tagIds.map((id) => tags.get(id)?.name ?? 'unknown tag').join(', ');
  const verb = scope.op === 'hasAny' ? 'any of' : scope.op === 'hasAll' ? 'all of' : 'none of';
  return `models that have ${verb} ${names || '—'}`;
}
