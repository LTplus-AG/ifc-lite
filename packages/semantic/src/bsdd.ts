/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertProfile, isUri, type ProfileDefinition, type ProfileField } from './profiles.js';
/** Structurally compatible with the existing SDK BsddNamespace.fetchClassByUri API. */
export interface BsddProvider { fetchClassByUri(uri: string): Promise<BsddClass | null> }
export interface BsddClass {
  uri: string; code: string; name: string; definition: string | null; parentClassUri: string | null;
  relatedIfcEntityNames: string[] | null;
  classProperties: { name: string; uri: string; description: string | null; dataType: string | null; propertySet: string | null;
    allowedValues: { value: string; uri?: string; description?: string }[] | null; units: string[] | null }[];
}
/** Consume the versioned official Class API via SDK provider; never dereference identifier URIs.
 * https://technical.buildingsmart.org/services/bsdd/using-the-bsdd-api/
 * The SDK currently uses /api/Class/v1?Uri=...&IncludeClassProperties=true.
 */
export async function profileFromBsdd(provider: BsddProvider, classUri: string, options: { id: string; version: string; vocabulary: string }) {
  if (!isUri(classUri)) throw new Error('bSDD class identifier must be an absolute URI');
  const raw = await provider.fetchClassByUri(classUri);
  if (!raw) throw new Error(`bSDD class not found: ${classUri}`);
  if (raw.classProperties.length > 499) throw new Error('bSDD class exceeds the 500 field limit');
  const diagnostics: string[] = []; const fields: Record<string, ProfileField> = { label: { iri: options.vocabulary + 'label', kind: 'string' } };
  for (const property of raw.classProperties) {
    const kinds: Record<string, ProfileField['kind']> = { String: 'string', Real: 'number', Integer: 'integer', Boolean: 'boolean', Number: 'number' };
    const kind = kinds[property.dataType ?? ''];
    if (!kind) { diagnostics.push(`Unsupported bSDD datatype for ${property.uri}: ${property.dataType}; raw definition retained`); continue; }
    if (fields[property.name] || ['id', 'type', '__proto__', 'constructor', 'prototype'].includes(property.name)) { diagnostics.push(`Conflicting bSDD field ${property.name}; raw definition retained`); continue; }
    const convert = (value: string): string | number | boolean => kind === 'boolean' ? value.toLowerCase() === 'true' : kind === 'number' || kind === 'integer' ? Number(value) : value;
    let allowed = property.allowedValues?.map(value => convert(value.value));
    if (allowed && property.allowedValues?.some((value, i) => {
      const projected = allowed?.[i];
      return typeof projected === 'number' && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.value)
        || !Number.isFinite(projected) || kind === 'integer' && !Number.isSafeInteger(projected))
        || kind === 'boolean' && !['true', 'false'].includes(value.value.toLowerCase());
    })) {
      diagnostics.push(`Unsupported bSDD enumeration for ${property.uri}; raw values retained`); allowed = undefined;
    }
    if ((property.units?.length ?? 0) > 1) diagnostics.push(`Multiple bSDD units for ${property.uri}; no unit conversion inferred`);
    fields[property.name] = { iri: property.uri, kind, labels: { en: property.name }, ...(allowed?.length ? { enum: allowed } : {}),
      ...(property.units?.length === 1 ? { unit: property.units[0] } : {}) };
  }
  const profile: ProfileDefinition = { ...options, fields, types: { [raw.code]: { iri: raw.uri, labels: { en: raw.name },
    fields: Object.fromEntries(Object.keys(fields).map(name => [name, { minCount: name === 'label' ? 1 : 0, maxCount: 1 }])) } } };
  assertProfile(profile);
  if (raw.parentClassUri) diagnostics.push('bSDD parent class retained as dictionary metadata; inheritance is not inferred');
  return { profile, raw: structuredClone(raw), diagnostics };
}
