/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LIMITS, assertIri, isObject, type SemanticDataset } from './types.js';
import { GUID_PATTERN, type ResourceIdentityLink } from './resolver.js';
import { parseResults } from './results.js';
export interface WorkspaceQuery {
  id: string; endpoint: string; kind: 'json' | 'select' | 'construct'; query?: string;
  mapping?: Record<string, string>; profileId?: string; resolverStrategy?: string;
}
export interface RevisionLink { revision: string; modelLabel: string }
export interface SemanticWorkspace {
  version: 1; datasets: SemanticDataset[]; queries: WorkspaceQuery[]; revisions: RevisionLink[]; resourceLinks?: ResourceIdentityLink[];
}
export interface ImportedWorkspace { workspace: SemanticWorkspace; grants: readonly string[]; associations: ReadonlyMap<string, string> }
function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Expected workspace ${name}`);
  return value;
}
function safeEndpoint(value: unknown): string {
  const url = new URL(string(value, 'endpoint'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Portable endpoints must be HTTPS without credentials, query parameters or fragments');
  return url.href;
}
export function sanitizeSource(value: unknown): string {
  const source = string(value, 'source');
  if (!/^https?:/u.test(source)) return source;
  const url = new URL(source); url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href;
}
function parseWorkspace(value: unknown): SemanticWorkspace {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.datasets) || !Array.isArray(value.queries) || !Array.isArray(value.revisions)) throw new Error('Unsupported semantic workspace version');
  if (value.datasets.length > 100 || value.queries.length > 100 || value.revisions.length > LIMITS.rows) throw new Error('Workspace exceeds configured limits');
  const datasets: SemanticDataset[] = value.datasets.map(raw => {
    if (!isObject(raw) || !['complete', 'partial'].includes(String(raw.completeness))) throw new Error('Invalid workspace dataset');
    const dataset: SemanticDataset = { id: string(raw.id, 'dataset id'), source: sanitizeSource(raw.source), completeness: raw.completeness as SemanticDataset['completeness'] };
    if (raw.profileId !== undefined) dataset.profileId = string(raw.profileId, 'profile id');
    if (raw.rows !== undefined) {
      if (!isObject(raw.rows)) throw new Error('Invalid workspace rows');
      dataset.rows = parseResults({ head: { vars: raw.rows.columns }, results: { bindings: raw.rows.rows } });
    }
    if (raw.graph !== undefined) {
      dataset.graph = string(raw.graph, 'graph');
      if (raw.graphFormat !== 'text/turtle' && raw.graphFormat !== 'application/n-quads') throw new Error('Invalid graph format');
      dataset.graphFormat = raw.graphFormat;
    }
    if (raw.resources !== undefined) {
      if (!Array.isArray(raw.resources) || raw.resources.length > LIMITS.rows) throw new Error('Invalid workspace resource count');
      dataset.resources = raw.resources.map(record => {
        if (!isObject(record) || !Array.isArray(record.types) || !record.types.every(v => typeof v === 'string') || !isObject(record.properties)) throw new Error('Invalid semantic record');
        const id = string(record.id, 'resource id');
        if (!id.startsWith('_:')) assertIri(id);
        const properties: Record<string, import('./types.js').RdfBinding[]> = Object.create(null) as Record<string, import('./types.js').RdfBinding[]>;
        for (const [predicate, terms] of Object.entries(record.properties)) {
          assertIri(predicate);
          if (!Array.isArray(terms) || terms.length > LIMITS.rows) throw new Error('Invalid semantic predicate values');
          properties[predicate] = parseResults({ head: { vars: ['term'] }, results: { bindings: terms.map(term => ({ term })) } }).rows.map(row => row.term);
        }
        return { id, types: [...record.types] as string[], properties };
      });
    }
    return dataset;
  });
  const queries: WorkspaceQuery[] = value.queries.map(raw => {
    if (!isObject(raw) || !['json', 'select', 'construct'].includes(String(raw.kind))) throw new Error('Invalid workspace query');
    const query: WorkspaceQuery = { id: string(raw.id, 'query id'), endpoint: safeEndpoint(raw.endpoint), kind: raw.kind as WorkspaceQuery['kind'] };
    if (raw.query !== undefined) query.query = string(raw.query, 'query');
    if (raw.profileId !== undefined) query.profileId = string(raw.profileId, 'profile id');
    if (raw.resolverStrategy !== undefined) query.resolverStrategy = string(raw.resolverStrategy, 'resolver');
    if (raw.mapping !== undefined) {
      if (!isObject(raw.mapping) || !Object.values(raw.mapping).every(v => typeof v === 'string')) throw new Error('Invalid query mapping');
      query.mapping = { ...raw.mapping } as Record<string, string>;
    }
    return query;
  });
  const revisions = value.revisions.map(raw => {
    if (!isObject(raw)) throw new Error('Invalid revision link');
    return { revision: string(raw.revision, 'revision'), modelLabel: string(raw.modelLabel, 'model label') };
  });
  let resourceLinks: ResourceIdentityLink[] | undefined;
  if (value.resourceLinks !== undefined) {
    if (!Array.isArray(value.resourceLinks) || value.resourceLinks.length > LIMITS.rows) throw new Error('Invalid resource identity links');
    resourceLinks = value.resourceLinks.map(raw => {
      if (!isObject(raw)) throw new Error('Invalid resource identity link');
      const resourceId = string(raw.resourceId, 'resource URI'); const modelRevision = string(raw.modelRevision, 'model revision'); const GlobalId = string(raw.GlobalId, 'IFC GlobalId');
      assertIri(resourceId); assertIri(modelRevision);
      if (!new RegExp(GUID_PATTERN).test(GlobalId)) throw new Error('Invalid linked IFC GlobalId');
      return { resourceId, modelRevision, GlobalId };
    });
  }
  return { version: 1, datasets, queries, revisions, ...(resourceLinks ? { resourceLinks } : {}) };
}
/** Whitelist the portable contract: credentials, grants and loaded model ids never cross sessions. */
export function exportWorkspace(workspace: SemanticWorkspace): string {
  const serialized = JSON.stringify(parseWorkspace(workspace), null, 2);
  if (new TextEncoder().encode(serialized).length > LIMITS.bytes) throw new Error('Workspace exceeds byte limit');
  return serialized;
}
export function importWorkspace(serialized: string): ImportedWorkspace {
  if (new TextEncoder().encode(serialized).length > LIMITS.bytes) throw new Error('Workspace exceeds byte limit');
  return { workspace: parseWorkspace(JSON.parse(serialized) as unknown), grants: [], associations: new Map<string, string>() };
}
