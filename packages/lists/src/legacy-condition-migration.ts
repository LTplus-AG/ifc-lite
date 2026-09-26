/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Decode v1 saved List conditions without claiming that unsupported sources
 * have been converted. The retained rows remain available to the legacy
 * evaluator until the #5894 runtime migration is complete. */
import { legacyListOperatorToFilterRule, type FilterGroup, type FilterRule } from '@ifc-lite/rules';
import { isNamePattern } from './name-pattern.js';
import type { PropertyCondition, UnreadableListCondition } from './types.js';

type MigrationResult = { groups: FilterGroup[]; unreadableConditions: UnreadableListCondition[] };

export function migrateLegacyListConditions(conditions: readonly PropertyCondition[]): MigrationResult {
  const rules: FilterRule[] = [];
  const unreadableConditions: UnreadableListCondition[] = [];

  for (const condition of conditions) {
    if (typeof condition.value !== 'string' && typeof condition.value !== 'number' && typeof condition.value !== 'boolean') {
      unreadableConditions.push({ condition, reason: 'invalid-value' });
      continue;
    }
    if (condition.source === 'attribute') {
      // V1's pseudo-attributes (Name, GlobalId, Class, Type, etc.) have
      // distinct source semantics; keep them on the old path until parity is
      // proved for each rather than convert a superficially similar rule.
      unreadableConditions.push({ condition, reason: 'unsupported-attribute' });
      continue;
    }
    if (condition.source === 'property') {
      // Rules' regex names have their own syntax; keep v1 `/regex/flags`
      // conditions on the old path until flags and first-match parity land.
      if (isNamePattern(condition.psetName ?? '') || isNamePattern(condition.propertyName)) {
        unreadableConditions.push({ condition, reason: 'name-pattern' });
        continue;
      }
      const converted = legacyListOperatorToFilterRule(condition.operator, {
        kind: 'property', setName: condition.psetName ?? '', propertyName: condition.propertyName,
        nameCaseMode: 'exact', ...(condition.inherit ? { inherit: condition.inherit } : {}),
        op: 'eq', value: String(condition.value),
      });
      if (converted.status === 'readable') rules.push(converted.value);
      else unreadableConditions.push({ condition, reason: 'operator' });
      continue;
    }
    unreadableConditions.push({ condition, reason: 'unsupported-source' });
  }

  return {
    groups: rules.length > 0 ? [{ rules, combinator: 'AND' }] : [],
    unreadableConditions,
  };
}
