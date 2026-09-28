/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Subject` parsing for `.rules.json` files (#5138). Split out of
 * `rule-set-io.ts` to stay under the module-size cap — subjects are the
 * one shape every requirement kind (`unique`/`aggregate`/`compare`) shares,
 * so it earns its own file rather than living inside any one of them.
 */

import type { Subject } from './rule-set.js';
import { fail, isPlainObject } from './rule-set-io-shared.js';
import { isModelFact } from '../filter/filter-model-fact.js';
import { isMemberPath } from '../filter/subject-read-options.js';

const TEXT_KINDS = new Set(['literal', 'regex']);

const SUBJECT_KINDS = new Set([
  'attribute', 'property', 'quantity', 'classification', 'group', 'modelFact',
  'name', 'material', 'storey', 'parent', 'type', 'ifcType', 'predefinedType', 'globalId',
]);

/** Subject kinds that carry more than one value per element (an element can
 *  have several materials, classification refs, spatial ancestors, or groups).
 *  `sum|min|max|avg`/`compare` need a single number or string to read —
 *  plan §3; multi-valued subjects are only meaningful as a bucketing key
 *  (`unique`, `count`, `groupBy`). */
const MULTI_VALUED_SUBJECT_KINDS = new Set(['material', 'classification', 'parent', 'group']);

export function isSingleValuedSubject(subject: Subject): boolean {
  return !MULTI_VALUED_SUBJECT_KINDS.has(subject.kind);
}

export function parseSubject(raw: unknown, where: string): Subject {
  if (!isPlainObject(raw)) fail(`${where}: subject must be an object`);
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (typeof kind !== 'string' || !SUBJECT_KINDS.has(kind)) fail(`${where}: unrecognised subject kind ${JSON.stringify(kind)}`);

  if (kind === 'attribute') {
    if (typeof s.name !== 'string' || s.name.length === 0) fail(`${where}: attribute subject needs "name"`);
    return { kind: 'attribute', name: s.name };
  }
  if (kind === 'property' || kind === 'quantity') {
    const nameField = kind === 'property' ? 'propertyName' : 'quantityName';
    const nameKindField = kind === 'property' ? 'propertyNameKind' : 'quantityNameKind';
    if (typeof s.setName !== 'string' || s.setName.length === 0) fail(`${where}: ${kind} subject needs "setName"`);
    if (typeof s[nameField] !== 'string' || (s[nameField] as string).length === 0) {
      fail(`${where}: ${kind} subject needs "${nameField}"`);
    }
    if (s.setNameKind !== undefined && !TEXT_KINDS.has(s.setNameKind as string)) fail(`${where}: bad "setNameKind"`);
    if (s[nameKindField] !== undefined && !TEXT_KINDS.has(s[nameKindField] as string)) fail(`${where}: bad "${nameKindField}"`);
    if (s.inherit !== undefined && s.inherit !== 'type' && s.inherit !== 'aggregation') fail(`${where}: bad "inherit"`);
    if (s.memberPath !== undefined && (kind !== 'property' || !isMemberPath(s.memberPath))) {
      fail(`${where}: "memberPath" must be a non-empty list of member names, on a property subject`);
    }
    return {
      ...(s.inherit !== undefined ? { inherit: s.inherit } : {}),
      ...(s.memberPath !== undefined ? { memberPath: s.memberPath } : {}),
      kind,
      setName: s.setName,
      ...(s.setNameKind !== undefined ? { setNameKind: s.setNameKind } : {}),
      [nameField]: s[nameField],
      ...(s[nameKindField] !== undefined ? { [nameKindField]: s[nameKindField] } : {}),
    } as Subject;
  }
  if (kind === 'classification') {
    if (s.system !== undefined && typeof s.system !== 'string') fail(`${where}: "system" must be a string`);
    return { kind: 'classification', ...(s.system !== undefined ? { system: s.system as string } : {}) };
  }
  if (kind === 'modelFact') {
    if (!isModelFact(s.fact)) fail(`${where}: unrecognised model fact ${JSON.stringify(s.fact)}`);
    return { kind: 'modelFact', fact: s.fact };
  }
  if (kind === 'group') {
    if (s.groupClass !== undefined && typeof s.groupClass !== 'string') fail(`${where}: "groupClass" must be a string`);
    return { kind: 'group', ...(s.groupClass ? { groupClass: s.groupClass as string } : {}) };
  }
  // Bare-kind subjects: name/material/storey/parent/type/ifcType/predefinedType/globalId.
  return { kind } as Subject;
}
