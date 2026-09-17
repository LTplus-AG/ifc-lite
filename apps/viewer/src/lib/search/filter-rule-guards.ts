/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON guards for `FilterRule` (saved filters, URL state, presets).
 *
 * Split out of `filter-rules.ts` (which keeps the taxonomy itself — the
 * interfaces and the `Rule` convenience constructors) to stay under the
 * module size cap, the same way `filter-match.ts`/`filter-iteration-source.ts`
 * split out of `filter-evaluate.ts`. Re-exported from `filter-rules.ts` so
 * every existing `import { isFilterRule } from './filter-rules.js'` keeps
 * working unchanged.
 */

import { isModelTagOp } from '../model-tags/types.js';
import type { FilterRule } from './filter-rules.js';

export function isFilterRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'modelTag') {
    // Structural: a bad op or a non-string id must not reach the evaluator.
    const r = value as { op?: unknown; tagIds?: unknown };
    return isModelTagOp(r.op) && Array.isArray(r.tagIds) && r.tagIds.every((t) => typeof t === 'string');
  }
  return (
    kind === 'model' ||
    kind === 'storey' ||
    kind === 'ifcType' ||
    kind === 'predefinedType' ||
    kind === 'name' ||
    kind === 'globalId' ||
    kind === 'attribute' ||
    kind === 'property' ||
    kind === 'quantity' ||
    kind === 'material' ||
    kind === 'classification' ||
    kind === 'elevation' ||
    kind === 'type' ||
    kind === 'parent'
  );
}

export function parseFilterRules(raw: unknown): FilterRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFilterRule);
}
