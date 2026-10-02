/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Technology-neutral profile. This is the only source for exchange and graph constraints. */
import { isObject, GUID_PATTERN, assertIri } from './types.js';
export { GUID_PATTERN } from './types.js';
export interface ProfileField {
  iri: string;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'iri' | 'language';
  labels?: Record<string, string>;
  enum?: (string | number | boolean)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  unit?: string;
  targetType?: string;
  external?: boolean;
}
export interface ProfileType { iri: string; labels?: Record<string, string>; fields: Record<string, { minCount?: number; maxCount?: number }> }
export interface ProfileDefinition { id: string; version: string; vocabulary: string; fields: Record<string, ProfileField>; types: Record<string, ProfileType> }
export const PROFILE_ID = 'https://example.org/ifc-lite/semantic-pilot/v1';
export const VOCAB = 'https://example.org/ifc-lite/semantic-pilot#';
export const RESOURCE_TYPES = ['Building', 'Logbook', 'Installation', 'Product', 'Passport', 'Inspection'] as const;
const iri = (name: string, targetType?: string): ProfileField => ({ iri: VOCAB + name, kind: 'iri', targetType });
const common = ['label', 'dictionaryUri', 'evidenceId'];
const type = (name: string, extra: string[], required: string[]): ProfileType => ({ iri: VOCAB + name,
  fields: Object.fromEntries([...common, ...extra].map(key => [key, { maxCount: 1, minCount: key === 'label' || required.includes(key) ? 1 : 0 }])) });
export const DEFAULT_PROFILE: ProfileDefinition = {
  id: PROFILE_ID, version: '1.0.0', vocabulary: VOCAB,
  fields: {
    label: { iri: VOCAB + 'label', kind: 'string' },
    buildingId: iri('buildingId', 'Building'), productId: iri('productId', 'Product'), passportId: iri('passportId', 'Passport'),
    installationId: iri('installationId', 'Installation'), replacesId: iri('replacesId', 'Installation'),
    evidenceId: { ...iri('evidenceId'), external: true }, dictionaryUri: { ...iri('dictionaryUri'), external: true },
    modelRevision: { ...iri('modelRevision'), external: true }, GlobalId: { iri: VOCAB + 'GlobalId', kind: 'string', pattern: GUID_PATTERN },
    granularity: { iri: VOCAB + 'granularity', kind: 'string', enum: ['model', 'batch', 'item'] }, fireRating: { iri: VOCAB + 'fireRating', kind: 'string' },
    thermalTransmittance: { iri: VOCAB + 'thermalTransmittance', kind: 'number', minimum: 0, unit: 'W/(m2.K)' },
  },
  types: {
    Building: type('Building', [], []), Logbook: type('Logbook', ['buildingId'], ['buildingId']),
    Installation: type('Installation', ['buildingId', 'productId', 'replacesId', 'GlobalId', 'modelRevision'], ['buildingId', 'productId']),
    Product: type('Product', ['passportId', 'granularity', 'fireRating', 'thermalTransmittance'], ['granularity']),
    Passport: type('Passport', ['productId', 'granularity', 'fireRating', 'thermalTransmittance'], ['productId', 'granularity']),
    Inspection: type('Inspection', ['installationId'], ['installationId']),
  },
};
export function isUri(value: string): boolean {
  try { assertIri(value); return true; } catch { return false; }
}
/** Shared bounded pattern policy for both profile-generated and imported shapes. */
export function assertBoundedPattern(pattern: string, location: string): void {
  // Several optional/ranged repetitions can backtrack combinatorially even
  // without groups. Count actual quantifiers, ignoring escapes and classes.
  let variableRepetitions = 0; let inClass = false; let alternation = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\') {
      // XPath/SPARQL and JavaScript assign different alphabets to shorthand
      // and property classes. Require explicit ranges, including in classes.
      if ('dDwWsSpP'.includes(pattern[index + 1] ?? '\0')) throw new Error(`Pattern for ${location} requires explicit character ranges instead of shorthand or property classes`);
      index++; continue;
    }
    if (inClass) { if (character === ']') inClass = false; continue; }
    if (character === '[') { inClass = true; continue; }
    if (character === '|') alternation = true;
    if ('+*?'.includes(character)) variableRepetitions++;
    if (character === '{') {
      const range = /^\{(\d+)(?:,(\d+))?\}/.exec(pattern.slice(index));
      if (range) {
        if (range[2] !== undefined && Number(range[1]) !== Number(range[2])) variableRepetitions++;
        index += range[0].length - 1;
      }
    }
  }
  if (pattern.length > 256 || /[()]|\\[1-9]/.test(pattern) || /[{}]/.test(pattern.replace(/\{[0-9]+(?:,[0-9]+)?\}/g, ''))
    || variableRepetitions > 1 || variableRepetitions > 0 && (!pattern.startsWith('^') || alternation)
    || [...pattern.matchAll(/\{([0-9]+)(?:,([0-9]+))?\}/g)].some(match => Number(match[1]) > 5000 || Number(match[2] ?? 0) > 5000)) {
    throw new Error(`Pattern for ${location} exceeds the supported bounded regular-expression subset`);
  }
  new RegExp(pattern, 'u');
}
/** Validate profiles before compiling schemas or executing graph validation. */
export function assertProfile(value: unknown): asserts value is ProfileDefinition {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.vocabulary !== 'string'
    || typeof value.version !== 'string' || !isObject(value.fields) || !isObject(value.types)) throw new Error('Profile requires id, version, vocabulary, fields and types');
  const closed = (object: Record<string, unknown>, allowed: readonly string[], location: string) => {
    const unknown = Object.keys(object).find(key => !allowed.includes(key));
    if (unknown) throw new Error(`Unsupported profile member ${location}.${unknown}`);
  };
  closed(value, ['id', 'version', 'vocabulary', 'fields', 'types'], 'profile');
  const labels = (candidate: unknown) => candidate === undefined || isObject(candidate) && Object.values(candidate).every(label => typeof label === 'string');
  for (const [name, field] of Object.entries(value.fields)) {
    if (!isObject(field) || typeof field.iri !== 'string' || typeof field.kind !== 'string'
    || !labels(field.labels) || field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.some(item => !['string', 'number', 'boolean'].includes(typeof item)))
    || field.pattern !== undefined && typeof field.pattern !== 'string' || field.minimum !== undefined && typeof field.minimum !== 'number'
    || field.maximum !== undefined && typeof field.maximum !== 'number' || field.unit !== undefined && typeof field.unit !== 'string'
    || field.targetType !== undefined && typeof field.targetType !== 'string' || field.external !== undefined && typeof field.external !== 'boolean') throw new Error('Invalid profile field definition');
    closed(field, ['iri', 'kind', 'labels', 'enum', 'pattern', 'minimum', 'maximum', 'unit', 'targetType', 'external'], `field ${name}`);
  }
  for (const [name, definition] of Object.entries(value.types)) {
    if (!isObject(definition) || typeof definition.iri !== 'string' || !isObject(definition.fields) || !labels(definition.labels)) throw new Error('Invalid profile type definition');
    closed(definition, ['iri', 'labels', 'fields'], `type ${name}`);
    for (const [key, count] of Object.entries(definition.fields)) {
      if (!isObject(count) || count.minCount !== undefined && typeof count.minCount !== 'number'
        || count.maxCount !== undefined && typeof count.maxCount !== 'number') throw new Error('Invalid profile cardinality');
      closed(count, ['minCount', 'maxCount'], `${name}.${key}`);
    }
  }
  const profile = value as unknown as ProfileDefinition;
  if (!isUri(profile.id) || !isUri(profile.vocabulary) || !profile.version) throw new Error('Profile requires absolute identifiers and a version');
  if (!Object.keys(profile.types).length || Object.keys(profile.types).length > 100 || Object.keys(profile.fields).length > 500) throw new Error('Profile exceeds the 100 type / 500 field limit');
  const terms = new Set<string>();
  for (const [name, field] of Object.entries(profile.fields)) {
    if (['id', 'type', '__proto__', 'constructor', 'prototype'].includes(name) || !isUri(field.iri) || terms.has(field.iri)) throw new Error(`Invalid or duplicate profile field: ${name}`);
    terms.add(field.iri);
    if (!['string', 'number', 'integer', 'boolean', 'iri', 'language'].includes(field.kind)) throw new Error(`Unsupported field kind: ${name}`);
    if (field.pattern && !['string', 'iri'].includes(field.kind)) throw new Error(`Pattern requires a string field: ${name}`);
    if ((field.minimum !== undefined || field.maximum !== undefined) && !['number', 'integer'].includes(field.kind)) throw new Error(`Range requires a numeric field: ${name}`);
    if (field.pattern) assertBoundedPattern(field.pattern, name);
    if (field.enum && (!field.enum.length || field.enum.length > 1000)) throw new Error(`Invalid enum: ${name}`);
    if (field.enum?.some(value => field.kind === 'iri' ? typeof value !== 'string' || !isUri(value)
      : field.kind === 'integer' ? typeof value !== 'number' || !Number.isSafeInteger(value)
        : field.kind === 'number' ? typeof value !== 'number' || !Number.isFinite(value)
          : field.kind === 'language' || typeof value !== field.kind)) throw new Error(`Enum values do not match field kind: ${name}`);
    if (field.minimum !== undefined && !Number.isFinite(field.minimum) || field.maximum !== undefined && !Number.isFinite(field.maximum)) throw new Error(`Non-finite range: ${name}`);
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) throw new Error(`Inverted range: ${name}`);
    if (field.kind === 'integer' && (field.minimum !== undefined && !Number.isSafeInteger(field.minimum)
      || field.maximum !== undefined && !Number.isSafeInteger(field.maximum))) throw new Error(`Integer profile ranges must use JavaScript safe integers: ${name}`);
    if (field.targetType && (!Object.hasOwn(profile.types, field.targetType) || field.kind !== 'iri')) throw new Error(`Invalid target type: ${name}`);
  }
  for (const [name, definition] of Object.entries(profile.types)) {
    if (!isUri(definition.iri) || terms.has(definition.iri) || ['id', 'type', '__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(profile.fields, name)) throw new Error(`Invalid type: ${name}`);
    if (!definition.fields.label || profile.fields.label?.kind !== 'string'
      || definition.fields.label.minCount !== 1 || (definition.fields.label.maxCount ?? 1) !== 1) throw new Error(`Type ${name} requires exactly one common string label field`);
    terms.add(definition.iri);
    for (const [key, count] of Object.entries(definition.fields)) {
      if (!Object.hasOwn(profile.fields, key)) throw new Error(`Unknown field ${key} on ${name}`);
      const min = count.minCount ?? 0; const max = count.maxCount ?? 1;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max < 1 || max > 5000) throw new Error(`Invalid cardinality: ${name}.${key}`);
      if (profile.fields[key].kind === 'language' && (max !== 1 || min > 1)) throw new Error(`Language maps use one value per language: ${name}.${key}`);
    }
  }
}
