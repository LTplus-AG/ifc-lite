/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Portable reviewed model changes (P04 / P19, #7070): a serialisable, bounded batch of
 * native data edits. Every change names its target by GlobalId and states the
 * value it expects to replace, so a preview can prove nothing moved underneath
 * it before one grouped commit. Producers (assistant answers, table imports,
 * validation corrections) only create this description; nothing here writes.
 */

import { validatePropertyDataType } from '@ifc-lite/export';

export type ChangeScalar = string | number | boolean | null;

/** IfcRoot string attributes a reviewed batch may set. Identity (GlobalId) is never editable here. */
export const EDITABLE_ATTRIBUTES = ['Name', 'Description', 'ObjectType', 'Tag'] as const;
export type EditableAttribute = typeof EDITABLE_ATTRIBUTES[number];

export interface ChangeTarget {
  /** IFC GlobalId of the element. */
  globalId: string;
  /** Restrict resolution to one loaded model; required when the GlobalId exists in several. */
  modelId?: string;
}

/** `expected: null` asserts the value is absent today. */
export type ModelChange =
  /** `dataType` optionally declares the IFC value type (e.g. `IfcLengthMeasure`); absent means it follows the JS value. */
  | { op: 'property.set'; target: ChangeTarget; pset: string; name: string; expected: ChangeScalar; value: Exclude<ChangeScalar, null>; dataType?: string }
  | { op: 'property.delete'; target: ChangeTarget; pset: string; name: string; expected: Exclude<ChangeScalar, null> }
  | { op: 'quantity.set'; target: ChangeTarget; qset: string; name: string; expected: number; value: number }
  | { op: 'attribute.set'; target: ChangeTarget; name: EditableAttribute; expected: string; value: string };

export interface ModelChangeBatch {
  version: 1;
  kind: 'model.changes';
  title: string;
  rationale?: string;
  changes: ModelChange[];
}

export const MODEL_CHANGE_LIMIT = 500;
const TEXT_LIMIT = 2000;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const scalar = (value: unknown): value is ChangeScalar =>
  value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && value.length <= TEXT_LIMIT);
const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;

function target(value: unknown): ChangeTarget {
  if (!record(value) || typeof value.globalId !== 'string' || !GLOBAL_ID.test(value.globalId)) {
    throw new Error('Each change needs a 22-character IFC GlobalId target');
  }
  if (value.modelId !== undefined && !text(value.modelId)) throw new Error('A target model id must be text');
  return value.modelId === undefined ? { globalId: value.globalId } : { globalId: value.globalId, modelId: value.modelId as string };
}

/** The canonical IFC type name, or a refusal naming why the value does not fit it. */
function declaredType(value: Exclude<ChangeScalar, null>, dataType: unknown, at: string): string {
  if (!text(dataType, 64)) throw new Error(`${at} has an invalid dataType`);
  try { return validatePropertyDataType(value, dataType).dataType; }
  catch (error) { throw new Error(`${at}: ${error instanceof Error ? error.message : String(error)}`); }
}

function change(value: unknown, index: number): ModelChange {
  if (!record(value)) throw new Error(`Change ${index + 1} is not an object`);
  const at = `Change ${index + 1}`;
  if (!Object.hasOwn(value, 'expected')) throw new Error(`${at} must state the expected current value`);
  switch (value.op) {
    case 'property.set':
      if (!text(value.pset) || !text(value.name)) throw new Error(`${at} needs a property set and property name`);
      if (!scalar(value.expected) || !scalar(value.value) || value.value === null) throw new Error(`${at} has an invalid value`);
      if (value.dataType === undefined) {
        return { op: 'property.set', target: target(value.target), pset: value.pset, name: value.name, expected: value.expected, value: value.value };
      }
      return { op: 'property.set', target: target(value.target), pset: value.pset, name: value.name, expected: value.expected, value: value.value,
        dataType: declaredType(value.value, value.dataType, at) };
    case 'property.delete':
      if (!text(value.pset) || !text(value.name)) throw new Error(`${at} needs a property set and property name`);
      if (!scalar(value.expected) || value.expected === null) throw new Error(`${at} must state the value being deleted`);
      return { op: 'property.delete', target: target(value.target), pset: value.pset, name: value.name, expected: value.expected };
    case 'quantity.set':
      if (!text(value.qset) || !text(value.name)) throw new Error(`${at} needs a quantity set and quantity name`);
      if (typeof value.expected !== 'number' || !Number.isFinite(value.expected) || typeof value.value !== 'number'
        || !Number.isFinite(value.value)) throw new Error(`${at} quantities must be finite numbers`);
      return { op: 'quantity.set', target: target(value.target), qset: value.qset, name: value.name, expected: value.expected, value: value.value };
    case 'attribute.set':
      if (!EDITABLE_ATTRIBUTES.includes(value.name as EditableAttribute)) {
        throw new Error(`${at} can only set ${EDITABLE_ATTRIBUTES.join(', ')}`);
      }
      if (typeof value.expected !== 'string' || typeof value.value !== 'string' || value.value.length > TEXT_LIMIT) {
        throw new Error(`${at} attribute values must be text`);
      }
      return { op: 'attribute.set', target: target(value.target), name: value.name as EditableAttribute, expected: value.expected, value: value.value };
    default:
      throw new Error(`${at} has an unsupported operation`);
  }
}

/** Strict, bounded parse of a complete JSON answer (optionally fenced). Throws with a reason a person can act on. */
export function parseModelChangeBatch(answer: string): ModelChangeBatch {
  if (answer.length > 400_000) throw new Error('The change batch exceeds the text limit');
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!record(value) || value.version !== 1 || value.kind !== 'model.changes') throw new Error('Not a model change batch');
  if (!text(value.title)) throw new Error('A change batch needs a short title');
  if (value.rationale !== undefined && !text(value.rationale, TEXT_LIMIT)) throw new Error('The rationale must be text');
  if (!Array.isArray(value.changes) || value.changes.length === 0) throw new Error('A change batch needs at least one change');
  if (value.changes.length > MODEL_CHANGE_LIMIT) throw new Error(`A change batch may hold at most ${MODEL_CHANGE_LIMIT} changes`);
  const changes = value.changes.map(change);
  const keys = new Set<string>();
  for (const item of changes) {
    const key = changeKey(item);
    if (keys.has(key)) throw new Error('A change batch may change each value only once');
    keys.add(key);
  }
  return { version: 1, kind: 'model.changes', title: value.title.trim(),
    ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}), changes };
}

/** Identity of the value a change addresses: one edit per value per batch. */
export function changeKey(item: ModelChange): string {
  const where = [item.target.modelId ?? null, item.target.globalId];
  switch (item.op) {
    case 'property.set': case 'property.delete': return JSON.stringify([...where, 'p', item.pset, item.name]);
    case 'quantity.set': return JSON.stringify([...where, 'q', item.qset, item.name]);
    case 'attribute.set': return JSON.stringify([...where, 'a', item.name]);
  }
}

/** Guidance for providers: the exact contract, kept short so it fits beside evidence. Data edits only; hosts add their supported authoring contracts separately. */
export const MODEL_DATA_CHANGE_OUTPUT_GUIDANCE =
  'When asked to prepare corrections, return only JSON {"version":1,"kind":"model.changes","title":"Short title",'
  + '"rationale":"Why","changes":[{"op":"property.set","target":{"globalId":"<22-char GlobalId>"},"pset":"Pset_WallCommon",'
  + '"name":"FireRating","expected":null,"value":"EI60"}]}. Ops: property.set, property.delete (expected = current value), '
  + 'quantity.set (qset, name, numeric expected/value), attribute.set (Name, Description, ObjectType or Tag). '
  + '"expected" must be the value shown in the evidence (null when absent). Use only GlobalIds from the evidence; '
  + 'never invent values the user did not ask for. The user reviews every change before anything is applied. ';
