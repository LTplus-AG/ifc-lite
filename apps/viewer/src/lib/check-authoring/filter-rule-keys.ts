/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fields each native filter-rule kind (`FilterRule` in `@ifc-lite/rules`)
 * carries. The native parser keeps a filter rule verbatim once it is valid, so
 * a field outside its kind would survive into the saved rule set unreviewed.
 */

const VALUE = ['op', 'value', 'valueKind'];
const READ = ['valueUnit', 'inherit'];

export const FILTER_RULE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(Object.entries({
  storey: ['values', 'op', 'refs'],
  model: ['values', 'op'],
  modelTag: ['op', 'tagIds'],
  ifcType: ['values', 'op', 'exactClass'],
  predefinedType: ['values', 'op'],
  globalId: ['values', 'op'],
  name: VALUE,
  material: VALUE,
  type: VALUE,
  parent: VALUE,
  elevation: ['op', 'value'],
  classification: ['system', ...VALUE],
  group: ['groupClass', ...VALUE],
  modelFact: ['fact', ...VALUE],
  attribute: ['name', ...VALUE, 'comparison'],
  property: ['setName', 'setNameKind', 'propertyName', 'propertyNameKind', 'nameCaseMode', 'legacyListFirst', 'memberPath', 'comparison', ...VALUE, ...READ],
  quantity: ['setName', 'setNameKind', 'quantityName', 'quantityNameKind', 'op', 'value', ...READ],
  listCondition: ['source', 'psetName', 'propertyName', 'operator', 'value', 'inherit'],
}).map(([kind, keys]) => [kind, new Set(['kind', ...keys])]));

/** Keys of `rule` its kind does not carry. */
export function unknownFilterRuleKeys(rule: Record<string, unknown>): string[] {
  const allowed = typeof rule.kind === 'string' ? FILTER_RULE_KEYS[rule.kind] : undefined;
  return allowed ? Object.keys(rule).filter(key => !allowed.has(key)) : [];
}
