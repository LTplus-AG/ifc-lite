/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { compileNameMatcher, isNamePattern } from '@ifc-lite/lists';
import type { Combinator, FilterRule } from '../search/filter-rules.js';

export interface AppearanceQueryDefinition {
  name: string;
  combinator: Combinator;
  rules: FilterRule[];
}
const stringOps = ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'matches', 'notMatches'];
const numericOps = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
const valueOps = [...numericOps, 'contains', 'notContains', 'matches', 'notMatches', 'isSet', 'isNotSet'];
const classificationOps = valueOps.filter(op => !['gt', 'gte', 'lt', 'lte'].includes(op));
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The saved filter contains an invalid rule.');
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length <= 4096; }
function requireFields(rule: Record<string, unknown>, fields: string[], ops: string[]): void {
  if (fields.some(field => !text(rule[field])) || !ops.includes(String(rule.op))) {
    throw new Error('The saved filter contains an invalid value or operator.');
  }
}
/** Authoring must reject the entire query: dropping one AND predicate broadens
 * membership. Keep the existing Search evaluator and its regex safety checks. */
export function ownAppearanceQuery(raw: unknown): AppearanceQueryDefinition {
  const query = record(raw);
  if (!text(query.name) || !query.name.trim() || query.name.length > 80
    || (query.combinator !== 'AND' && query.combinator !== 'OR')
    || !Array.isArray(query.rules) || !query.rules.length || query.rules.length > 32) {
    throw new Error('Choose a named saved filter containing between 1 and 32 valid rules.');
  }
  let characters = query.name.length;
  for (const rawRule of query.rules) {
    const rule = record(rawRule);
    if (typeof rule.op !== 'string') throw new Error('The saved filter operator is invalid.');
    const fields: Record<string, string[]> = {
      model: ['values'], storey: ['values', 'refs'], ifcType: ['values'], predefinedType: ['values'], globalId: ['values'],
      name: ['value', 'valueKind'], material: ['value', 'valueKind'], type: ['value', 'valueKind'],
      attribute: ['name', 'value', 'valueKind'],
      property: ['setName', 'setNameKind', 'propertyName', 'propertyNameKind', 'value', 'valueKind'],
      quantity: ['setName', 'setNameKind', 'quantityName', 'quantityNameKind', 'value'],
      classification: ['system', 'value', 'valueKind'], elevation: ['value'],
    };
    const allowed = typeof rule.kind === 'string' ? fields[rule.kind] : undefined;
    if (!allowed || Object.keys(rule).some(key => !['kind', 'op', ...allowed].includes(key))) {
      throw new Error('The saved filter contains unsupported rule fields.');
    }
    for (const field of ['valueKind', 'setNameKind', 'propertyNameKind', 'quantityNameKind']) {
      if (rule[field] !== undefined && rule[field] !== 'literal' && rule[field] !== 'regex') {
        throw new Error('The saved filter contains an invalid text interpretation.');
      }
    }
    switch (rule.kind) {
      case 'model': case 'storey': case 'ifcType': case 'predefinedType': case 'globalId':
        if (!['in', 'notIn'].includes(String(rule.op)) || !Array.isArray(rule.values)
          || !rule.values.length || rule.values.length > 1000 || !rule.values.every(text)) {
          throw new Error('The saved filter contains an invalid membership rule.');
        }
        if (rule.kind === 'storey' && rule.refs !== undefined) {
          throw new Error('Exact storey selections are session-bound. Save a filter using storey names before applying appearance.');
        }
        break;
      case 'name': case 'material': case 'type': requireFields(rule, ['value'], stringOps); break;
      case 'attribute': requireFields(rule, ['name', 'value'], valueOps); break;
      case 'property': requireFields(rule, ['setName', 'propertyName', 'value'], valueOps); break;
      case 'classification':
        requireFields(rule, ['value'], classificationOps);
        if (rule.system !== undefined && !text(rule.system)) throw new Error('The classification system is invalid.');
        break;
      case 'quantity': case 'elevation':
        requireFields(rule, rule.kind === 'quantity' ? ['setName', 'quantityName'] : [], numericOps);
        if (typeof rule.value !== 'number' || !Number.isFinite(rule.value)) throw new Error('The filter threshold must be finite.');
        break;
      default: throw new Error('The saved filter contains an unsupported rule.');
    }
    for (const value of Object.values(rule)) {
      characters += Array.isArray(value) ? value.reduce((sum, item) => sum + String(item).length, 0)
        : typeof value === 'string' ? value.length : 0;
      if (characters > 32 * 1024) throw new Error('The saved filter exceeds the appearance query budget.');
    }
    for (const field of ['setName', 'propertyName', 'quantityName', 'value']) {
      const value = rule[field];
      if (typeof value !== 'string') continue;
      const kind = rule[`${field}Kind`];
      const pattern = field === 'value'
        ? ['matches', 'notMatches'].includes(rule.op) ? kind === undefined && isNamePattern(value) ? value : `/${value}/` : undefined
        : kind === 'regex' ? `/${value}/` : kind === undefined && isNamePattern(value) ? value : undefined;
      if (pattern !== undefined) {
        if (!isNamePattern(pattern)) throw new Error('The saved filter contains an invalid regular expression.');
        compileNameMatcher(pattern); // Validate the shared safety guard before examining any IFC rows.
      }
    }
  }
  // Bound before cloning. Nested unknown fields are refused instead of carrying
  // an unbounded graph into draft state or a portable assignment recipe.
  const owned = { name: query.name, combinator: query.combinator, rules: query.rules };
  const encoded = JSON.stringify(owned);
  if (encoded.length > 64 * 1024) throw new Error('The saved filter exceeds the appearance query budget.');
  return structuredClone({ name: query.name, combinator: query.combinator, rules: query.rules as FilterRule[] });
}
