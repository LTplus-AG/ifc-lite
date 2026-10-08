/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { assertReadOnlyQuery, inspectReadOnlyQuery, relatedResourceQuery, relatedIdentityQuery } from './query.js';
import { LIMITS } from './types.js';
import { parseResults, recordsFromResults } from './results.js';
import { recordsFromGraph } from './graph.js';
import { createSemanticProvider } from './provider.js';
import { ResolverRegistry, resolveResource, createResourceLinkStrategy, createProfileMappingStrategy } from './resolver.js';
import { exportWorkspace, importWorkspace, type SemanticWorkspace } from './workspace.js';

const iri = (value: string) => ({ type: 'uri', value });
const literal = (value: string, metadata = {}) => ({ type: 'literal', value, ...metadata });
const envelope = { head: { vars: ['subject', 'predicate', 'object', 'optional', 'count'] }, results: { bindings: [
  { subject: iri('https://example.org/item'), predicate: iri('https://example.org/label'), object: literal('Tür', { 'xml:lang': 'de' }), count: literal('01', { datatype: 'http://www.w3.org/2001/XMLSchema#integer' }) },
  { subject: iri('https://example.org/item'), predicate: iri('https://example.org/label'), object: literal('Door', { 'xml:lang': 'en' }) },
  { subject: { type: 'bnode', value: 'node' }, predicate: iri('https://example.org/link'), object: iri('https://example.org/item') },
] } };
describe('semantic core charter #6643', () => {
  it('retains lexical typed terms, languages, blank nodes and unbound columns without coercion', () => {
    const results = parseResults(envelope);
    expect(results.rows[0].count.value).toBe('01');
    expect(results.rows[1]).not.toHaveProperty('optional');
    expect(recordsFromResults(results)[0].properties['https://example.org/label']).toEqual([
      { type: 'literal', value: 'Tür', 'xml:lang': 'de' }, { type: 'literal', value: 'Door', 'xml:lang': 'en' },
    ]);
    expect(recordsFromResults(results)[1].id).toBe('_:node');
  });
  it('projects generic RDF subjects without losing multilingual or repeated predicates', () => {
    const records = recordsFromGraph('<https://example.org/s> <https://example.org/label> "Tür"@de, "Door"@en; <https://example.org/size> "01"^^<http://www.w3.org/2001/XMLSchema#integer> .');
    expect(records[0].properties['https://example.org/label']).toHaveLength(2);
    expect(records[0].properties['https://example.org/size'][0]).toEqual({ type: 'literal', value: '01', datatype: 'http://www.w3.org/2001/XMLSchema#integer' });
  });
  it('rejects malformed RDF metadata and undeclared columns', () => {
    expect(() => parseResults({ head: { vars: ['x'] }, results: { bindings: [{ x: literal('v', { datatype: 'https://example.org/type', 'xml:lang': 'en' }) }] } })).toThrow();
    expect(() => parseResults({ head: { vars: ['x'] }, results: { bindings: [{ other: iri('https://example.org/x') }] } })).toThrow();
  });
  it('parses syntax and denies updates, nested SERVICE and unauthorized datasets', () => {
    expect(assertReadOnlyQuery('SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }')).toBe('select');
    expect(assertReadOnlyQuery('CONSTRUCT { ?s ?p ?o } WHERE {?s ?p ?o}')).toBe('construct');
    expect(() => assertReadOnlyQuery('INSERT DATA { <https://a> <https://b> <https://c> }')).toThrow();
    expect(() => assertReadOnlyQuery('SELECT * WHERE { { SELECT * WHERE { SERVICE SILENT <https://example.org> {?s ?p ?o} } } }')).toThrow('SERVICE');
    expect(() => assertReadOnlyQuery('SELECT * FROM <https://example.org/graph> WHERE {?s ?p ?o}')).toThrow('FROM');
    expect(assertReadOnlyQuery('SELECT * FROM <https://example.org/graph> WHERE {?s ?p ?o}', ['https://example.org/graph'])).toBe('select');
    expect(assertReadOnlyQuery('SELECT * WHERE { ?s ?p "SERVICE" } # INSERT DATA')).toBe('select');
    expect(() => assertReadOnlyQuery('SELECT * WHERE {')).toThrow();
  });
  it('inspects the outer projection and LIMIT with the same read-only refusals', () => {
    expect(inspectReadOnlyQuery('PREFIX p: <https://e/> SELECT ?a (COUNT(?b) AS ?n) WHERE { ?a p:x ?b { SELECT ?b WHERE { ?b ?q ?r } LIMIT 9 } } GROUP BY ?a LIMIT 10'))
      .toEqual({ form: 'select', variables: ['a', 'n'], limit: 10 });
    expect(inspectReadOnlyQuery('SELECT * WHERE { ?s ?p ?o }')).toEqual({ form: 'select', variables: '*' });
    expect(inspectReadOnlyQuery('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 5')).toEqual({ form: 'construct', variables: [], limit: 5 });
    expect(() => inspectReadOnlyQuery('DELETE WHERE { ?s ?p ?o }')).toThrow();
    expect(() => inspectReadOnlyQuery('SELECT * WHERE { SERVICE <https://example.org> { ?s ?p ?o } } LIMIT 1')).toThrow('SERVICE');
  });
  it('builds related queries as bounded validated VALUES instead of executable string fragments', () => {
    expect(assertReadOnlyQuery(relatedResourceQuery(['https://example.org/item']))).toBe('select');
    expect(() => relatedResourceQuery(['https://example.org/x> } SERVICE <https://evil.org> { ?s ?p ?o'])).toThrow();
    expect(() => relatedResourceQuery([], 1)).toThrow();
  });
  it('counts distinct related identities against the query budget (#6643 review)', () => {
    const repeated = Array<string>(LIMITS.rows + 1).fill('https://example.org/item');
    expect(relatedResourceQuery(repeated)).toBe(relatedResourceQuery(['https://example.org/item']));
    expect(relatedIdentityQuery('https://example.org/identity', repeated)).toBe(relatedIdentityQuery('https://example.org/identity', ['https://example.org/item']));
    const distinct = repeated.map((_, index) => `https://example.org/item/${index}`);
    expect(() => relatedResourceQuery(distinct)).toThrow('bounds');
    expect(() => relatedIdentityQuery('https://example.org/identity', distinct)).toThrow('bounds');
    expect(() => relatedIdentityQuery('https://example.org/identity', [])).toThrow('bounds');
  });
  it('requires explicit host grants before calling a transport', async () => {
    let calls = 0;
    const provider = createSemanticProvider(async () => { calls++; return new Response('{}'); });
    await expect(provider.read({ endpoint: 'https://evil.org/data', host: 'example.org', kind: 'json' })).rejects.toThrow('not covered');
    await expect(provider.read({ endpoint: 'http://example.org/data', host: 'example.org', kind: 'json' })).rejects.toThrow('https');
    expect(calls).toBe(0);
  });
  it('negotiates SELECT/CONSTRUCT, preserves auth only in request, and rejects oversize/redirects', async () => {
    const seen: RequestInit[] = [];
    const provider = createSemanticProvider(async (_url, init) => { seen.push(init); const construct = String(init.body).includes('CONSTRUCT'); return new Response(construct ? '<https://example.org/s> <https://example.org/p> "v" .' : JSON.stringify(envelope), { headers: { 'Content-Type': construct ? 'text/turtle' : 'application/sparql-results+json' } }); });
    const selected = await provider.read({ endpoint: 'https://example.org/query', host: 'example.org', kind: 'select', query: 'SELECT * WHERE {?s ?p ?o}', bearer: 'secret' });
    expect(selected.kind).toBe('select'); expect(selected).not.toHaveProperty('bearer');
    expect(seen[0].headers).toHaveProperty('Authorization', 'Bearer secret');
    expect(seen[0].redirect).toBe('manual');
    const constructed = await provider.read({ endpoint: 'https://example.org/query', host: 'example.org', kind: 'construct', query: 'CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o}' });
    expect(constructed.kind === 'construct' && constructed.quadCount).toBe(1);
    await expect(createSemanticProvider(async () => new Response('x'.repeat(5 * 1024 * 1024 + 1))).read({ endpoint: 'https://example.org', host: 'example.org', kind: 'json' })).rejects.toThrow('limit');
    await expect(createSemanticProvider(async () => new Response('', { status: 302 })).read({ endpoint: 'https://example.org', host: 'example.org', kind: 'json' })).rejects.toThrow('redirect');
  });
  it('fails closed on duplicate GlobalIds, stale revisions and conflicting scope', () => {
    const GlobalId = '0000000000000000000001';
    const entities = [{ modelId: 'a', expressId: 1, GlobalId }, { modelId: 'b', expressId: 2, GlobalId }];
    expect(resolveResource({ GlobalId }, entities, new Map()).status).toBe('ambiguous');
    expect(resolveResource({ GlobalId, modelRevision: 'https://example.org/rev' }, entities, new Map()).status).toBe('unscoped');
    expect(resolveResource({ GlobalId, modelRevision: 'rev' }, entities, new Map([['rev', 'a']]), 'b').status).toBe('unmatched');
    expect(resolveResource({ GlobalId, modelRevision: 'rev' }, entities, new Map([['rev', 'a']]))).toEqual({ status: 'resolved', ref: { modelId: 'a', expressId: 1 } });
    expect(resolveResource({ GlobalId: 'bad' }, entities, new Map()).status).toBe('invalid');
    const registry = new ResolverRegistry(); expect(() => registry.resolve('missing', {}, { entities, revisions: new Map() })).toThrow();
    expect(() => registry.register({ id: 'ifc-global-id', resolve: () => ({ status: 'external' }) })).toThrow();
  });
  it('re-resolves portable resource links after model replacement and deletion', () => {
    const GlobalId = '0000000000000000000001';
    const registry = new ResolverRegistry([createResourceLinkStrategy([{ resourceId: 'https://example.org/product', modelRevision: 'rev', GlobalId }]), createProfileMappingStrategy('custom', { GlobalId: 'ifcId', modelRevision: 'revision' })]);
    const record = { id: 'https://example.org/product' };
    expect(registry.resolve('resource-links', record, { entities: [], revisions: new Map() }).status).toBe('unscoped');
    expect(registry.resolve('resource-links', record, { entities: [{ modelId: 'new', expressId: 999, GlobalId }], revisions: new Map([['rev', 'new']]) })).toEqual({ status: 'resolved', ref: { modelId: 'new', expressId: 999 } });
    expect(registry.resolve('resource-links', record, { entities: [], revisions: new Map([['rev', 'new']]) }).status).toBe('unmatched');
    expect(registry.resolve('custom', { ifcId: GlobalId, revision: 'rev' }, { entities: [{ modelId: 'new', expressId: 999, GlobalId }], revisions: new Map([['rev', 'new']]) }).status).toBe('resolved');
  });
  it('round-trips portable rows/links while stripping auth, grants and model sessions', () => {
    const workspace: SemanticWorkspace = { version: 1, datasets: [{ id: 'd', source: 'local', completeness: 'partial', rows: parseResults(envelope), resources: recordsFromResults(parseResults(envelope)) }],
      queries: [{ id: 'q', endpoint: 'https://example.org/query', kind: 'select', query: 'SELECT * WHERE {?s ?p ?o}' }], revisions: [{ revision: 'rev', modelLabel: 'Door model' }], resourceLinks: [{ resourceId: 'https://example.org/product', modelRevision: 'rev', GlobalId: '0000000000000000000001' }] };
    Object.assign(workspace.queries[0], { bearer: 'SECRET', grantedHost: 'example.org' });
    Object.assign(workspace.revisions[0], { modelId: 'old-session' });
    const exported = exportWorkspace(workspace); expect(exported).not.toContain('SECRET'); expect(exported).not.toContain('old-session');
    const imported = importWorkspace(exported); expect(imported.grants).toEqual([]); expect(imported.associations.size).toBe(0);
    expect(imported.workspace.datasets[0].rows).toEqual(workspace.datasets[0].rows);
    expect(imported.workspace.resourceLinks).toEqual(workspace.resourceLinks);
    expect(imported.workspace.revisions).toEqual([{ revision: 'rev', modelLabel: 'Door model' }]);
    expect(() => importWorkspace('{"version":2}')).toThrow('version');
    expect(() => exportWorkspace({ ...workspace, queries: [{ id: 'q', endpoint: 'https://example.org/query?token=secret', kind: 'json' }] })).toThrow('Portable');
  });
});
