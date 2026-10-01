/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LIMITS, assertIri, isObject, type RdfBinding, type SparqlResults, type SemanticRecord } from './types.js';

export function parseResults(value: unknown): SparqlResults {
  if (!isObject(value) || !isObject(value.head) || !Array.isArray(value.head.vars)
    || !value.head.vars.every(v => typeof v === 'string') || !isObject(value.results)
    || !Array.isArray(value.results.bindings) || value.results.bindings.length > LIMITS.rows) {
    throw new Error('Expected bounded SPARQL SELECT JSON results');
  }
  const columns: string[] = value.head.vars;
  if (new Set(columns).size !== columns.length || columns.some(v => !v || v.length > 1024)) throw new Error('Invalid SPARQL columns');
  const rows = value.results.bindings.map((row: unknown) => {
    if (!isObject(row)) throw new Error('Invalid SPARQL result row');
    const result: Record<string, RdfBinding> = Object.create(null) as Record<string, RdfBinding>;
    for (const [name, raw] of Object.entries(row)) {
      if (!columns.includes(name) || !isObject(raw) || typeof raw.value !== 'string'
        || !['uri', 'literal', 'bnode'].includes(String(raw.type))) throw new Error(`Invalid RDF binding: ${name}`);
      const type = raw.type as RdfBinding['type'];
      if ((raw.datatype !== undefined && typeof raw.datatype !== 'string')
        || (raw['xml:lang'] !== undefined && typeof raw['xml:lang'] !== 'string')
        || (type !== 'literal' && (raw.datatype !== undefined || raw['xml:lang'] !== undefined))
        || (raw.datatype !== undefined && raw['xml:lang'] !== undefined)) throw new Error(`Invalid RDF literal metadata: ${name}`);
      if (type === 'uri') assertIri(raw.value);
      if (typeof raw.datatype === 'string') assertIri(raw.datatype);
      if (typeof raw['xml:lang'] === 'string' && !/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(raw['xml:lang'])) throw new Error('Invalid language tag');
      if (type === 'bnode' && !raw.value) throw new Error('Blank node label is empty');
      result[name] = { type, value: raw.value,
        ...(typeof raw.datatype === 'string' ? { datatype: raw.datatype } : {}),
        ...(typeof raw['xml:lang'] === 'string' ? { 'xml:lang': raw['xml:lang'] } : {}) };
    }
    return result;
  });
  return { columns: [...columns], rows };
}

/** RDF-shaped SELECT results are optional; arbitrary analytical columns stay in raw rows. */
export function recordsFromResults(results: SparqlResults, mapping = { subject: 'subject', predicate: 'predicate', object: 'object' }): SemanticRecord[] {
  const records = new Map<string, SemanticRecord>();
  for (const row of results.rows) {
    const subject = row[mapping.subject]; const predicate = row[mapping.predicate]; const object = row[mapping.object];
    if (!subject || !predicate || !object || !['uri', 'bnode'].includes(subject.type) || predicate.type !== 'uri') throw new Error('Expected subject, predicate and object RDF bindings');
    const id = subject.type === 'bnode' ? `_:${subject.value}` : subject.value;
    const record = records.get(id) ?? { id, types: [], properties: Object.create(null) as Record<string, RdfBinding[]> };
    const values = record.properties[predicate.value] ?? [];
    if (!values.some(term => term.type === object.type && term.value === object.value && term.datatype === object.datatype && term['xml:lang'] === object['xml:lang'])) values.push({ ...object });
    record.properties[predicate.value] = values;
    if (predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && object.type === 'uri' && !record.types.includes(object.value)) record.types.push(object.value);
    records.set(id, record);
  }
  return [...records.values()];
}
