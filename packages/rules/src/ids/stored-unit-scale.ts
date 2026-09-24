/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What unit a property or quantity is stored in, across the loaded models,
 * so the IDS export can state a model-unit bound in SI (#5225 decision).
 *
 * For each model, the first element carrying the subject is found with the
 * search evaluator (limit 1) and read with `readSubject`, the same reader
 * the rule engine compares with. Every model that has the value must agree
 * on its SI factor; a disagreement, or no model having the value at all, is
 * `unknown` with the reason, and the export refuses that rule.
 */

import { evaluateFilterRules, type EvaluatorModel } from '../filter/filter-evaluate.js';
import type { FilterRule, PropertyRule, QuantityRule } from '../filter/filter-rules.js';
import { readSubject } from '../filter/read-subject.js';
import type { StoredUnitScale, StoredUnitScaleOf } from './rule-to-ids-facets.js';

/** A rule that matches every element carrying `rule`'s subject. */
function presenceProbe(rule: PropertyRule | QuantityRule): FilterRule {
  if (rule.kind === 'quantity') {
    return { kind: 'quantity', setName: rule.setName, setNameKind: rule.setNameKind, quantityName: rule.quantityName, quantityNameKind: rule.quantityNameKind, op: 'gte', value: -Number.MAX_VALUE };
  }
  return { kind: 'property', setName: rule.setName, setNameKind: rule.setNameKind, propertyName: rule.propertyName, propertyNameKind: rule.propertyNameKind, op: 'isSet', value: '' };
}

function label(rule: PropertyRule | QuantityRule): string {
  return `${rule.setName}.${rule.kind === 'quantity' ? rule.quantityName : rule.propertyName}`;
}

export function storedUnitScaleOf(models: ReadonlyArray<EvaluatorModel>): StoredUnitScaleOf {
  const cache = new Map<string, StoredUnitScale>();
  return (rule) => {
    const key = JSON.stringify(presenceProbe(rule));
    const cached = cache.get(key);
    if (cached) return cached;
    const scales = new Set<number | 'unitless'>();
    for (const model of models) {
      if (!model.store) continue;
      const [first] = evaluateFilterRules(model.id, model.store, [presenceProbe(rule)], 'AND', { limit: 1 });
      if (!first) continue;
      const subject = readSubject(rule, { store: model.store, expressId: first.expressId });
      for (const scale of subject.valueSiScales ?? []) scales.add(scale ?? 'unitless');
    }
    let result: StoredUnitScale;
    if (scales.size === 0) {
      result = { kind: 'unknown', reason: `no loaded model has ${label(rule)}, so its unit (and the SI value IDS needs) is unknown` };
    } else if (scales.size > 1) {
      result = { kind: 'unknown', reason: `the loaded models record ${label(rule)} in different units, so no single SI value matches all of them` };
    } else {
      const [only] = scales;
      result = only === 'unitless' ? { kind: 'unitless' } : { kind: 'scale', scale: only };
    }
    cache.set(key, result);
    return result;
  };
}
