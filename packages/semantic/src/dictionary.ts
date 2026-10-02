/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertProfile, DEFAULT_PROFILE, type ProfileDefinition, type ProfileField, type ProfileType } from './profiles.js';
import { isObject } from './types.js';
export interface DictionaryTerm { name: string; definition: ProfileField }
export interface DictionaryClass { name: string; definition: ProfileType }
export interface SemanticDictionary { id: string; version: string; vocabulary: string; properties: DictionaryTerm[]; classes: DictionaryClass[]; unsupported?: unknown[] }
export interface DictionaryImport { profile: ProfileDefinition; raw: SemanticDictionary; diagnostics: string[] }
/** Neutral supported-subset projection; this is deliberately not a normative bSDD import file. */
export function profileToDictionary(profile = DEFAULT_PROFILE, unsupported?: unknown[]): SemanticDictionary {
  assertProfile(profile);
  return { id: profile.id, version: profile.version, vocabulary: profile.vocabulary,
    properties: Object.entries(profile.fields).map(([name, definition]) => ({ name, definition: structuredClone(definition) })),
    classes: Object.entries(profile.types).map(([name, definition]) => ({ name, definition: structuredClone(definition) })),
    ...(unsupported ? { unsupported: structuredClone(unsupported) } : {}) };
}
export function dictionaryToProfile(value: unknown): DictionaryImport {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.version !== 'string' || typeof value.vocabulary !== 'string'
    || !Array.isArray(value.properties) || !Array.isArray(value.classes) || value.unsupported !== undefined && !Array.isArray(value.unsupported)) throw new Error('Expected a neutral semantic dictionary envelope');
  if (value.properties.length > 500 || value.classes.length > 100) throw new Error('Dictionary exceeds the supported profile limits');
  if (Object.keys(value).some(key => !['id', 'version', 'vocabulary', 'properties', 'classes', 'unsupported'].includes(key))) throw new Error('Unsupported neutral dictionary member');
  for (const term of [...value.properties, ...value.classes]) if (!isObject(term) || typeof term.name !== 'string' || !isObject(term.definition)
    || Object.keys(term).some(key => !['name', 'definition'].includes(key))) throw new Error('Invalid neutral dictionary term');
  const dictionary = value as unknown as SemanticDictionary;
  const unique = (names: string[]) => new Set(names).size === names.length;
  if (!unique(dictionary.properties.map(term => term.name)) || !unique(dictionary.classes.map(term => term.name))) throw new Error('Duplicate dictionary term name');
  const profile: ProfileDefinition = { id: dictionary.id, version: dictionary.version, vocabulary: dictionary.vocabulary,
    fields: Object.fromEntries(dictionary.properties.map(term => [term.name, structuredClone(term.definition)])),
    types: Object.fromEntries(dictionary.classes.map(term => [term.name, structuredClone(term.definition)])) };
  assertProfile(profile);
  return { profile, raw: structuredClone(dictionary), diagnostics: (dictionary.unsupported ?? []).map((_, i) => `Unsupported relation ${i + 1} retained in raw dictionary; no IFC or profile projection was inferred`) };
}
