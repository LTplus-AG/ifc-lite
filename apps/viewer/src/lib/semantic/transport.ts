/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Parser as SparqlParser } from 'sparqljs';
import { coreNetworkRequest, type FetchTransport } from '@ifc-lite/sandbox';
import { parseCapability } from '@ifc-lite/extensions';
import { documentOf } from './validation';
import { RESOURCE_TYPES, VOCAB, type BindingMapping, type RdfBinding, type SemanticResource, type SparqlResults } from './types';
import { fields } from './profile';

export const DEFAULT_MAPPING: BindingMapping = { id: 'id', type: 'type', label: 'label', GlobalId: 'GlobalId', modelRevision: 'modelRevision' };
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function parseResults(value: unknown): SparqlResults {
  if (!object(value) || !object(value.head) || !Array.isArray(value.head.vars)
    || !value.head.vars.every(v => typeof v === 'string') || !object(value.results)
    || !Array.isArray(value.results.bindings) || value.results.bindings.length > 5000) throw new Error('Expected bounded SPARQL SELECT JSON results');
  const columns: string[] = value.head.vars;
  if (new Set(columns).size !== columns.length) throw new Error('Duplicate SPARQL result columns');
  const rows = value.results.bindings.map((row: unknown) => {
    if (!object(row)) throw new Error('Invalid SPARQL result row');
    const parsed: Record<string, RdfBinding> = Object.create(null) as Record<string, RdfBinding>;
    for (const [key, binding] of Object.entries(row)) {
      if (!columns.includes(key) || !object(binding) || typeof binding.value !== 'string'
        || !['uri', 'literal', 'bnode'].includes(String(binding.type))
        || (binding.datatype !== undefined && typeof binding.datatype !== 'string')
        || (binding['xml:lang'] !== undefined && typeof binding['xml:lang'] !== 'string')
        || (binding.type !== 'literal' && (binding.datatype !== undefined || binding['xml:lang'] !== undefined))
        || (binding.datatype !== undefined && binding['xml:lang'] !== undefined)) throw new Error(`Invalid RDF term in ${key}`);
      parsed[key] = binding as unknown as RdfBinding;
    }
    return parsed;
  });
  return { columns, rows };
}
export function assertSelect(query: string): void {
  if (query.length > 256000) throw new Error('Query exceeds the pilot limit');
  const ast = new SparqlParser().parse(query);
  if (ast.type !== 'query' || ast.queryType !== 'SELECT') throw new Error('Only SELECT queries are supported');
  const pending: unknown[] = [ast];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) pending.push(...current);
    else if (object(current)) {
      if (current.type === 'service' || current.from !== undefined) throw new Error('SERVICE and FROM are outside the pilot scope');
      pending.push(...Object.values(current));
    }
  }
}
/** The explicit hostname is the user's grant, not an implicit grant derived from the URL. */
export async function request(endpoint: string, grantedHost: string, signal: AbortSignal,
  query?: string, transport?: FetchTransport): Promise<unknown> {
  const capability = parseCapability(`network.fetch:${grantedHost}`);
  if (!capability.ok) throw new Error('Enter a valid granted hostname');
  if (query !== undefined) assertSelect(query);
  const response = await coreNetworkRequest({ url: endpoint, method: query === undefined ? 'GET' : 'POST',
    headers: query === undefined ? { Accept: 'application/json' } : {
      Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: query === undefined ? undefined : new URLSearchParams({ query }).toString(),
    signal, timeoutMs: 15000, maxBytes: 5 * 1024 * 1024 }, [capability.value], transport);
  if (response.status < 200 || response.status >= 300) throw new Error(`Endpoint returned HTTP ${response.status}`);
  if (response.truncated) throw new Error('Endpoint response exceeded the pilot limit');
  return JSON.parse(response.body) as unknown;
}
export function resourcesFromResults(results: SparqlResults, source: string, mapping = DEFAULT_MAPPING) {
  const byId = new Map<string, SemanticResource>();
  for (const row of results.rows) {
    const id = row[mapping.id]; const type = row[mapping.type]; const label = row[mapping.label];
    if (id?.type !== 'uri' || !type || type.type === 'bnode' || !label || label.type !== 'literal') throw new Error('Project resource id, type and label bindings');
    const typeName = type.value.startsWith(VOCAB) ? type.value.slice(VOCAB.length) : type.value;
    if (!RESOURCE_TYPES.some(t => t === typeName)) throw new Error(`Unsupported resource type: ${type.value}`);
    const resource: Record<string, string> = { id: id.value, type: typeName, label: label.value };
    for (const [key, field] of Object.entries(fields)) {
      if (key === 'label') continue;
      const column = key === 'GlobalId' ? mapping.GlobalId : key === 'modelRevision' ? mapping.modelRevision : key;
      const term = row[column];
      if (!term) continue;
      if (term.type !== (field.kind === 'iri' ? 'uri' : 'literal')) throw new Error(`Wrong RDF term kind for ${key}`);
      if (field.kind === 'literal' && (term['xml:lang'] || (term.datatype && term.datatype !== 'http://www.w3.org/2001/XMLSchema#string'))) {
        throw new Error(`Expected an untagged string literal for ${key}`);
      }
      resource[key] = term.value;
    }
    const existing = byId.get(id.value);
    if (existing && JSON.stringify(existing) !== JSON.stringify(resource)) throw new Error(`Conflicting rows for ${id.value}; aggregate multi-valued data explicitly`);
    byId.set(id.value, resource as unknown as SemanticResource);
  }
  return documentOf([...byId.values()], source);
}
