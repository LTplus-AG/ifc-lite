/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded, fail-closed conversion of saved v1 lens criteria (#5896).
 * `FilterGroup[]` is disjunctive normal form: groups are OR'd, rules in each
 * group are AND'd. A conversion refusal retains the source JSON for the UI to
 * explain; it must never become an empty match set without a warning. */
import { IFC_SUBTYPE_TO_BASE, MAX_COMPOUND_DEPTH, type LensCriteria } from '@ifc-lite/lens';
import { legacyLensOperatorToFilterRule, type FilterGroup, type FilterRule } from '@ifc-lite/rules';

export type LegacyCriteriaConversion =
  | { status: 'readable'; groups: FilterGroup[] }
  | { status: 'unreadable'; reason: string };

const MAX_DNF_GROUPS = 32;
const MAX_RULES_PER_GROUP = 32;

function unreadable(reason: string): LegacyCriteriaConversion {
  return { status: 'unreadable', reason };
}

function leaf(rule: FilterRule): LegacyCriteriaConversion {
  return { status: 'readable', groups: [{ rules: [rule], combinator: 'AND' }] };
}

function valueOperator(criteria: LensCriteria, value: string | undefined): string {
  return criteria.operator ?? (value === undefined ? 'exists' : 'equals');
}

function convertLeaf(criteria: LensCriteria): LegacyCriteriaConversion {
  switch (criteria.type) {
    case 'ifcType': {
      if (!criteria.ifcType) return { status: 'readable', groups: [] };
      const subtypes = Object.entries(IFC_SUBTYPE_TO_BASE)
        .filter(([, base]) => base === criteria.ifcType)
        .map(([subtype]) => subtype);
      return leaf({ kind: 'ifcType', op: 'in', values: [criteria.ifcType, ...subtypes] });
    }
    case 'property': {
      if (!criteria.propertySet || !criteria.propertyName) return { status: 'readable', groups: [] };
      if (criteria.operator && criteria.operator !== 'exists' && criteria.propertyValue === undefined) {
        return unreadable('Property comparison is missing its saved value');
      }
      const result = legacyLensOperatorToFilterRule(valueOperator(criteria, criteria.propertyValue), {
        kind: 'property', setName: criteria.propertySet, setNameKind: 'literal',
        propertyName: criteria.propertyName, propertyNameKind: 'literal',
        op: 'eq', value: criteria.propertyValue ?? '',
      });
      return result.status === 'readable' ? leaf(result.value) : unreadable(`Unknown lens operator: ${result.operator}`);
    }
    case 'attribute': {
      if (!criteria.attributeName) return { status: 'readable', groups: [] };
      if (criteria.operator && criteria.operator !== 'exists' && criteria.attributeValue === undefined) {
        return unreadable('Attribute comparison is missing its saved value');
      }
      // GlobalId equality is case-sensitive in both engines. Other GlobalId
      // comparisons and Name cannot use the generic attribute reader; its
      // dedicated Name rule folds case, unlike saved Lens equality.
      if (criteria.attributeName === 'GlobalId') {
        return (criteria.operator === undefined || criteria.operator === 'equals') && criteria.attributeValue
          ? leaf({ kind: 'globalId', op: 'in', values: [criteria.attributeValue] })
          : unreadable('GlobalId comparison has no equivalent filter chip');
      }
      if (criteria.attributeName === 'Name') {
        if (criteria.operator === 'contains' && criteria.attributeValue) {
          return leaf({ kind: 'name', op: 'contains', value: criteria.attributeValue });
        }
        return unreadable('Name comparison has no exact equivalent filter chip');
      }
      const result = legacyLensOperatorToFilterRule(valueOperator(criteria, criteria.attributeValue), {
        kind: 'attribute', name: criteria.attributeName, op: 'eq', value: criteria.attributeValue ?? '',
      });
      return result.status === 'readable' ? leaf(result.value) : unreadable(`Unknown lens operator: ${result.operator}`);
    }
    case 'quantity': {
      if (!criteria.quantitySet || !criteria.quantityName) return { status: 'readable', groups: [] };
      const op = criteria.operator;
      if (op !== 'gt' && op !== 'gte' && op !== 'lt' && op !== 'lte') {
        return unreadable(`Quantity ${op ?? 'equals'} cannot be represented by a numeric chip exactly`);
      }
      const value = Number.parseFloat(criteria.quantityValue ?? '');
      if (!Number.isFinite(value)) return { status: 'readable', groups: [] };
      // The old provider reads type-only QTO values too; `inherit: 'type'`
      // selects that same shared subject-reader path for numeric chips.
      return leaf({ kind: 'quantity', setName: criteria.quantitySet, setNameKind: 'literal',
        quantityName: criteria.quantityName, quantityNameKind: 'literal', op, value, inherit: 'type' });
    }
    case 'group':
      return leaf({ kind: 'group', op: criteria.groupName ? 'contains' : 'isSet',
        value: criteria.groupName ?? '' });
    case 'material':
      // Canonical material chips also match Category. A saved lens matched
      // only material names, so a naive conversion could color extra entities.
      return unreadable('Material chips include Category as well as material names');
    case 'classification':
      // Legacy system/code fields are both substrings on the SAME reference;
      // canonical chips scope a system exactly and also match reference Name.
      return unreadable('Classification system/code matching differs from canonical chips');
    case 'model':
      // Saved criteria hold transient runtime ids; model chips require durable
      // source fingerprints. The importer must not guess that identity.
      return unreadable('Model rule has no durable source fingerprint');
    default:
      return unreadable(`Unknown lens criterion: ${String(criteria.type)}`);
  }
}

function convert(criteria: LensCriteria, depth: number): LegacyCriteriaConversion {
  if (!criteria || typeof criteria !== 'object') return unreadable('Malformed lens criterion');
  if (criteria.type !== 'and' && criteria.type !== 'or') return convertLeaf(criteria);
  if (depth >= MAX_COMPOUND_DEPTH) return unreadable('Lens criteria exceed the supported nesting depth');
  if (!Array.isArray(criteria.conditions) || criteria.conditions.length === 0) {
    return { status: 'readable', groups: [] };
  }
  let dnf: FilterGroup[] = criteria.type === 'and' ? [{ rules: [], combinator: 'AND' }] : [];
  for (const child of criteria.conditions) {
    const next = convert(child, depth + 1);
    if (next.status === 'unreadable') return next;
    if (criteria.type === 'or') {
      if (dnf.length + next.groups.length > MAX_DNF_GROUPS) return unreadable('Lens rule expands beyond 32 groups');
      dnf = [...dnf, ...next.groups];
      continue;
    }
    if (dnf.length * next.groups.length > MAX_DNF_GROUPS) return unreadable('Lens rule expands beyond 32 groups');
    const joined: FilterGroup[] = [];
    for (const left of dnf) for (const right of next.groups) {
      if (left.rules.length + right.rules.length > MAX_RULES_PER_GROUP) {
        return unreadable('Lens rule expands beyond 32 conditions per group');
      }
      joined.push({ rules: [...left.rules, ...right.rules], combinator: 'AND' });
    }
    dnf = joined;
  }
  return { status: 'readable', groups: dnf };
}

export function legacyCriteriaToFilterGroups(criteria: LensCriteria): LegacyCriteriaConversion {
  return convert(criteria, 0);
}
