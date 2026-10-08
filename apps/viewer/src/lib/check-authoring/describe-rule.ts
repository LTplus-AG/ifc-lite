/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact one-line reading of a native information rule for the review card
 * (#6915). It restates the parsed native fields verbatim (IFC names, ops,
 * values); the native rule editor remains the full presentation.
 */

import type { FilterRule, InformationRule, RuleBlock, Subject } from '@ifc-lite/rules';

const NOISE = new Set(['kind', 'op', 'value', 'values', 'valueKind', 'setNameKind', 'propertyNameKind', 'quantityNameKind', 'comparison', 'refs']);

function fields(rule: object): string {
  return Object.entries(rule).filter(([key]) => !NOISE.has(key)).map(([, value]) => String(value)).join('.');
}

export function describeFilterRule(rule: FilterRule): string {
  const subject = [rule.kind, fields(rule)].filter(Boolean).join(' ');
  const values = 'values' in rule && Array.isArray(rule.values) ? rule.values.join(', ')
    : 'value' in rule && rule.value !== undefined && rule.value !== '' ? String(rule.value) : '';
  return [subject, 'op' in rule ? rule.op : '', values].filter(Boolean).join(' ');
}

export function describeBlock(block: RuleBlock): string {
  const groups = block.groups.filter(group => group.rules.length > 0)
    .map(group => group.rules.map(describeFilterRule).join(` ${group.combinator} `));
  return groups.length > 1 ? groups.map(text => `(${text})`).join(' OR ') : groups[0] ?? '—';
}

function describeSubject(subject: Subject): string {
  return [subject.kind, fields(subject)].filter(Boolean).join(' ');
}

export function describeRequirement(requirement: InformationRule['requirement']): string {
  switch (requirement.kind) {
    case 'element': return describeBlock(requirement.block);
    case 'unique': return `unique ${describeSubject(requirement.subject)}${requirement.scope ? ` (${requirement.scope})` : ''}`;
    case 'aggregate': return `${requirement.fn}(${requirement.subject ? describeSubject(requirement.subject) : ''})`
      + `${requirement.groupBy ? ` by ${describeSubject(requirement.groupBy.subject)}` : ''} ${requirement.op} ${requirement.value}`;
    case 'compare': return `${describeSubject(requirement.left)} ${requirement.op} ${describeSubject(requirement.right)}`;
    case 'unit': return `${describeSubject(requirement.subject)} in ${requirement.unit}`;
  }
}
