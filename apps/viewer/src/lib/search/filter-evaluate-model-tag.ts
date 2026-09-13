/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MODEL-SCOPED rule arm of the evaluator (`filter-evaluate.ts`): `model`
 * and `modelTag` (#4215) are decided by the owning model alone, never by the
 * entity, so one answer per model serves every entity in it.
 *
 * Used twice, by design: as the per-entity arm (so OR keeps its boolean
 * meaning — a model failing the tag condition still contributes entities that
 * pass the other side of the OR) and as the whole-model prune under AND (a
 * model that fails any model-scoped rule can contribute no entity, so its scan
 * is skipped). Same function both times, so the two cannot disagree.
 */

import { modelTagRuleMatches } from '../model-tags/types.js';
import { setOpMatches } from './filter-ops.js';
import type { FilterRule, ModelRule, ModelTagRule } from './filter-rules.js';

/** What a model-scoped rule needs to know about one model. */
export interface ModelScope {
  /** Stable source identity compared by `ModelRule` (`sourceFingerprint`, else the id). */
  filterIdentity: string;
  /** The model's tag ids; absent = untagged. */
  tagIds?: ReadonlySet<string>;
  /** Every tag id that currently exists — a rule naming any other id is unresolved. */
  definedModelTagIds: ReadonlySet<string>;
}

export type ModelScopedRule = ModelRule | ModelTagRule;

export function isModelScopedRule(rule: FilterRule): rule is ModelScopedRule {
  return rule.kind === 'model' || rule.kind === 'modelTag';
}

export function modelScopedRuleMatches(rule: ModelScopedRule, scope: ModelScope): boolean {
  if (rule.kind === 'model') return setOpMatches(rule.op, scope.filterIdentity, rule.values);
  return modelTagRuleMatches(rule.op, rule.tagIds, scope.tagIds, scope.definedModelTagIds);
}

/**
 * Under AND, may this model be skipped outright? True when some model-scoped
 * rule fails for it. Under OR the answer is always `false`: the entity-level
 * rules on the other side of the OR can still admit its entities.
 */
export function modelPrunedUnderAnd(rules: readonly FilterRule[], scope: ModelScope): boolean {
  return rules.some((rule) => isModelScopedRule(rule) && !modelScopedRuleMatches(rule, scope));
}

/** Empty set for callers that know of no tags (single-model tests, adapters without a tag store). */
export const NO_MODEL_TAGS: ReadonlySet<string> = new Set();
