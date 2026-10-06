/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Strict reading of the Rules `FilterGroup[]` an artifact proposal carries
 * (filters, list scopes, lens rules, chart source filters). The output is the
 * native Rules shape, built through `Rule.*`, so every engine reads it exactly
 * as it reads a filter the user built by hand.
 *
 * The native JSON guard (`isFilterRule`) only checks a rule's kind, which is
 * right for reading the user's own saved filters but too lenient for model
 * output, so every field is checked here. Classes are canonical: a known IFC
 * class names its subclasses too (`expandTypes`, the same reading the selector
 * field gives `IfcWall`), so a wall filter reaches `IfcWallStandardCase`.
 * Numeric property and quantity comparisons are SI (`valueUnit: 'si'`): metres,
 * square metres, cubic metres, whatever unit the model stores in. For a
 * property that is every ordering op, and `eq` / `ne` with a JSON number; a
 * text or boolean equality compares the stored value. Values with no unit
 * (labels, counts) compare as stored either way.
 */

import { expandTypes, isKnownType, normalizeIfcTypeName } from '@ifc-lite/parser';
import { Rule, type FilterGroup, type FilterRule, type NumericOp, type SetOp, type StringOp, type ValueOp } from '@ifc-lite/rules';
import { onlyKeys, record, requiredText } from './artifact-json';

export const GROUP_LIMIT = 8;
export const RULE_LIMIT = 20;
const VALUE_LIMIT = 200;
const SET_OPS: readonly SetOp[] = ['in', 'notIn'];
const STRING_OPS: readonly StringOp[] = ['eq', 'ne', 'contains', 'notContains', 'startsWith'];
const NUMERIC_OPS: readonly NumericOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
const VALUE_OPS: readonly ValueOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'startsWith', 'endsWith', 'isSet', 'isNotSet'];
const PRESENCE_OPS: ReadonlySet<ValueOp> = new Set(['isSet', 'isNotSet']);
const NUMERIC_VALUE_OPS: ReadonlySet<ValueOp> = new Set(['gt', 'gte', 'lt', 'lte']);
const CLASSIFICATION_OPS = ['eq', 'ne', 'contains', 'notContains', 'isSet', 'isNotSet'] as const;
/** IfcRoot / IfcObject attributes a proposal may compare; Name and GlobalId have their own rule kinds. */
const ATTRIBUTES = ['Description', 'ObjectType', 'Tag', 'LongName', 'PredefinedType'] as const;
const REFUSED: Record<string, string> = {
  modelTag: 'Model tags are user-defined; add the tag in the filter editor after saving',
  group: 'Group membership is not available in assistant proposals',
  modelFact: 'Model facts are not available in assistant proposals',
  listCondition: 'List conditions are not available in assistant proposals; use property or quantity rules',
};
const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;

function op<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${at} "op" must be one of ${allowed.join(', ')}`);
  return value as T;
}

function textValue(value: unknown, at: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'string' || value.length > VALUE_LIMIT) throw new Error(`${at} "value" must be text of at most ${VALUE_LIMIT} characters`);
  return value;
}

function numberValue(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at} "value" must be a finite number (SI units: m, m², m³)`);
  return value;
}

function stringList(value: unknown, at: string, check?: (item: string) => string | null): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new Error(`${at} "values" must list 1 to 50 entries`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim() || item.length > VALUE_LIMIT) throw new Error(`${at} value ${index + 1} must be non-empty text`);
    const refusal = check?.(item);
    if (refusal) throw new Error(`${at}: ${refusal}`);
    return item;
  });
}

/** Known IFC classes plus their subclasses, in the PascalCase the filter chips show. */
export function canonicalClasses(values: readonly string[]): string[] {
  return [...new Set(expandTypes([...values]).map(normalizeIfcTypeName))];
}

export function knownClassRefusal(name: string): string | null {
  return /^Ifc[A-Za-z0-9]+$/.test(name) && isKnownType(name) ? null : `"${name}" is not an IFC class name (for example IfcWall, IfcSlab, IfcDoor)`;
}

function parseRule(value: unknown, at: string): FilterRule {
  if (!record(value)) throw new Error(`${at} is not an object`);
  const kind = value.kind;
  if (typeof kind === 'string' && REFUSED[kind]) throw new Error(`${at}: ${REFUSED[kind]}`);
  switch (kind) {
    case 'ifcType':
      onlyKeys(value, ['kind', 'op', 'values'], at);
      return Rule.ifcType(canonicalClasses(stringList(value.values, at, knownClassRefusal)), op(value.op, SET_OPS, at));
    case 'predefinedType':
      onlyKeys(value, ['kind', 'op', 'values'], at);
      return Rule.predefinedType(stringList(value.values, at).map((item) => item.toUpperCase()), op(value.op, SET_OPS, at));
    case 'globalId':
      onlyKeys(value, ['kind', 'op', 'values'], at);
      return Rule.globalId(stringList(value.values, at, (id) => GLOBAL_ID.test(id) ? null : `"${id}" is not a 22-character IFC GlobalId`), op(value.op, SET_OPS, at));
    case 'storey':
      onlyKeys(value, ['kind', 'op', 'values'], at);
      return Rule.storey(stringList(value.values, at), op(value.op, SET_OPS, at));
    case 'model':
      // Loaded model names, as the schema digest lists them; the review resolves them to fingerprints (`model-scope.ts`).
      onlyKeys(value, ['kind', 'op', 'values'], at);
      return Rule.model(stringList(value.values, at), op(value.op, SET_OPS, at));
    case 'name': case 'material': case 'type': case 'parent': {
      onlyKeys(value, ['kind', 'op', 'value'], at);
      const ruleOp = op(value.op, STRING_OPS, at);
      const ruleValue = textValue(value.value, at);
      return kind === 'name' ? Rule.name(ruleOp, ruleValue) : kind === 'material' ? Rule.material(ruleOp, ruleValue)
        : kind === 'type' ? Rule.typeName(ruleOp, ruleValue) : Rule.parent(ruleOp, ruleValue);
    }
    case 'attribute': {
      onlyKeys(value, ['kind', 'name', 'op', 'value'], at);
      if (!ATTRIBUTES.includes(value.name as typeof ATTRIBUTES[number])) throw new Error(`${at} attribute "name" must be one of ${ATTRIBUTES.join(', ')} (Name has the "name" rule, GlobalId the "globalId" rule)`);
      const ruleOp = op(value.op, VALUE_OPS, at);
      return Rule.attribute(value.name as string, ruleOp, PRESENCE_OPS.has(ruleOp) ? '' : textValue(value.value, at));
    }
    case 'property': {
      onlyKeys(value, ['kind', 'setName', 'propertyName', 'op', 'value'], at);
      const ruleOp = op(value.op, VALUE_OPS, at);
      const ruleValue = PRESENCE_OPS.has(ruleOp) ? '' : textValue(value.value, at);
      // `Number('')` is 0, so a blank operand is refused before the numeric check.
      if (NUMERIC_VALUE_OPS.has(ruleOp) && (ruleValue.trim() === '' || !Number.isFinite(Number(ruleValue)))) throw new Error(`${at} compares with "${ruleOp}", so "value" must be a number`);
      const rule = Rule.property(requiredText(value.setName, `${at} "setName"`), requiredText(value.propertyName, `${at} "propertyName"`), ruleOp, ruleValue);
      // A numeric comparison of a measure, an equality with a JSON number included, reads the operand in SI, never the file's unit.
      const numeric = NUMERIC_VALUE_OPS.has(ruleOp) || ((ruleOp === 'eq' || ruleOp === 'ne') && typeof value.value === 'number');
      return numeric ? { ...rule, valueUnit: 'si' } : rule;
    }
    case 'quantity': {
      onlyKeys(value, ['kind', 'setName', 'quantityName', 'op', 'value'], at);
      const rule = Rule.quantity(requiredText(value.setName, `${at} "setName"`), requiredText(value.quantityName, `${at} "quantityName"`),
        op(value.op, NUMERIC_OPS, at), numberValue(value.value, at));
      return { ...rule, valueUnit: 'si' };
    }
    case 'classification': {
      onlyKeys(value, ['kind', 'system', 'op', 'value'], at);
      if (value.system !== undefined && (typeof value.system !== 'string' || value.system.length > VALUE_LIMIT)) throw new Error(`${at} "system" must be text`);
      const ruleOp = op(value.op, CLASSIFICATION_OPS, at);
      return Rule.classification(typeof value.system === 'string' ? value.system : '', ruleOp, ruleOp === 'isSet' || ruleOp === 'isNotSet' ? '' : textValue(value.value, at));
    }
    case 'elevation':
      onlyKeys(value, ['kind', 'op', 'value'], at);
      return Rule.elevation(op(value.op, NUMERIC_OPS, at), numberValue(value.value, at));
    default:
      throw new Error(`${at} has unsupported kind ${JSON.stringify(kind)}; use ifcType, predefinedType, globalId, storey, model, name, attribute, property, quantity, material, classification, type, parent or elevation`);
  }
}

/** Groups OR together; a group's rules combine by its own `combinator`. */
export function parseProposalGroups(value: unknown, at: string, options: { allowEmpty?: boolean } = {}): FilterGroup[] {
  if (value === undefined && options.allowEmpty) return [];
  if (!Array.isArray(value) || (value.length === 0 && !options.allowEmpty)) throw new Error(`${at} needs at least one filter group`);
  if (value.length > GROUP_LIMIT) throw new Error(`${at} may hold at most ${GROUP_LIMIT} groups`);
  return value.map((group, groupIndex) => {
    const where = `${at} group ${groupIndex + 1}`;
    if (!record(group)) throw new Error(`${where} is not an object`);
    onlyKeys(group, ['combinator', 'rules'], where);
    if (group.combinator !== 'AND' && group.combinator !== 'OR') throw new Error(`${where} "combinator" must be AND or OR`);
    if (!Array.isArray(group.rules) || group.rules.length === 0 || group.rules.length > RULE_LIMIT) throw new Error(`${where} needs 1 to ${RULE_LIMIT} rules`);
    return { combinator: group.combinator, rules: group.rules.map((rule, ruleIndex) => parseRule(rule, `${where} rule ${ruleIndex + 1}`)) };
  });
}
