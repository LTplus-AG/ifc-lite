/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_PROFILE, type ProfileDefinition } from './profiles.js';
import type { SemanticResource, SemanticDocument } from './profile-types.js';
import type { RdfBinding, SparqlResults } from './types.js';
import { documentOf } from './validation.js';
export type BindingMapping = Record<string, string>;
export const DEFAULT_MAPPING: BindingMapping = { id: 'id', type: 'type', label: 'label', GlobalId: 'GlobalId', modelRevision: 'modelRevision' };
const XSD = 'http://www.w3.org/2001/XMLSchema#';
function projected(term: RdfBinding, kind: string, field: string): unknown {
  if (kind === 'iri') { if (term.type !== 'uri') throw new Error(`Expected IRI: ${field}`); return term.value; }
  if (term.type !== 'literal') throw new Error(`Expected literal: ${field}`);
  if (kind === 'language') {
    if (!term['xml:lang']) throw new Error(`Expected language-tagged literal: ${field}`);
    return { [term['xml:lang']]: term.value };
  }
  if (term['xml:lang']) throw new Error(`Profile string cannot discard language: ${field}`);
  if (kind === 'string') {
    if (term.datatype && term.datatype !== XSD + 'string') throw new Error(`Expected string datatype: ${field}`);
    return term.value;
  }
  if (kind === 'boolean') {
    if (term.datatype !== XSD + 'boolean' || !['true', 'false', '1', '0'].includes(term.value)) throw new Error(`Expected boolean: ${field}`);
    return term.value === 'true' || term.value === '1';
  }
  if (!term.datatype || ![XSD + 'integer', XSD + 'decimal', XSD + 'double', XSD + 'float'].includes(term.datatype)
    || !term.value.trim() || !Number.isFinite(Number(term.value)) || (kind === 'integer' && !Number.isSafeInteger(Number(term.value)))) throw new Error(`Expected bounded numeric literal: ${field}`);
  return Number(term.value);
}
/** Explicit profile projection; raw SELECT rows remain the authoritative lossless data. */
export function resourcesFromResults(results: SparqlResults, source: string, mapping: BindingMapping = DEFAULT_MAPPING,
  profile: ProfileDefinition = DEFAULT_PROFILE): SemanticDocument {
  const records = new Map<string, SemanticResource>();
  for (const row of results.rows) {
    const id = row[mapping.id ?? 'id']; const type = row[mapping.type ?? 'type']; const label = row[mapping.label ?? 'label'];
    if (id?.type !== 'uri' || !type || type.type === 'bnode' || label?.type !== 'literal') throw new Error('Project resource id, type and label columns explicitly');
    const typeName = type.type === 'uri' ? Object.keys(profile.types).find(key => profile.types[key].iri === type.value) : type.value;
    if (!typeName || !profile.types[typeName]) throw new Error(`Unsupported profile type: ${type.value}`);
    const projectedLabel = projected(label, 'string', 'label');
    if (typeof projectedLabel !== 'string') throw new Error('Label must be a profile string');
    const record: SemanticResource = { id: id.value, type: typeName, label: projectedLabel };
    for (const key of Object.keys(profile.types[typeName].fields)) {
      if (key === 'label') continue;
      const term = row[mapping[key] ?? key]; if (!term) continue;
      const value = projected(term, profile.fields[key].kind, key);
      record[key] = (profile.types[typeName].fields[key].maxCount ?? 1) > 1 ? [value] : value;
    }
    const existing = records.get(record.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error(`Conflicting profile rows for ${record.id}; raw dataset is preserved, aggregate projection explicitly`);
    records.set(record.id, record);
  }
  return documentOf([...records.values()], source, profile);
}
