/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store as Oxigraph } from 'oxigraph';
import { DEFAULT_MAPPING, DEFAULT_PROFILE, assertReadOnlyQuery } from '@ifc-lite/semantic';
import { queryForSelection } from './related-query';
const GlobalId = '0000000000000000000001';
const selected = { modelId: 'live', expressId: 7 };
const entities = [{ ...selected, GlobalId }];
const input = { selection: [selected], entities, revisions: new Map<string, string>(), mapping: DEFAULT_MAPPING, profile: DEFAULT_PROFILE };
test('charter #6643 reverse queries discover generic semantic subjects from actual IFC selection', () => {
  const query = queryForSelection(input); assert.equal(assertReadOnlyQuery(query), 'select');
  const engine = new Oxigraph();
  engine.load(`<https://example.org/resource> <${DEFAULT_PROFILE.fields.GlobalId.iri}> "${GlobalId}"; <https://example.org/label> "Door"@en . <https://example.org/inspection> <https://example.org/about> <https://example.org/resource> . <https://example.org/outsider> <https://example.org/unrelated> "outside" .`, { format: 'text/turtle' });
  const response = engine.query(query, { results_format: 'application/sparql-results+json' });
  assert.equal(typeof response, 'string');
  const result = JSON.parse(response as string) as { results: { bindings: { subject: { value: string }; object: { value: string } }[] } };
  assert.equal(result.results.bindings.length, 3);
  assert.ok(result.results.bindings.every(row => row.subject.value !== 'https://example.org/outsider'));
  assert.ok(result.results.bindings.some(row => row.subject.value === 'https://example.org/inspection'));
});
test('charter #6643 mapped raw result URIs drive reverse retrieval without a domain document', () => {
  const query = queryForSelection({ ...input, mapping: { id: 'resource', GlobalId: 'guid', modelRevision: 'revision' }, results: {
    columns: ['resource', 'guid'], rows: [{ resource: { type: 'uri', value: 'https://example.org/door' }, guid: { type: 'literal', value: GlobalId } }],
  } });
  assert.ok(query.includes('<https://example.org/door>'));
  assert.ok(!query.includes('VALUES ?identity'));
  assert.throws(() => queryForSelection({ ...input, selection: [] }), /Select/);
});
test('charter #6643 reverse resource links retrieve linked subjects without a GlobalId predicate', () => {
  const resourceId = 'https://example.org/resource'; const modelRevision = 'https://example.org/revision';
  const settings = { strategy: 'resource-links', links: [{ resourceId, modelRevision, GlobalId }] };
  const profile = { ...DEFAULT_PROFILE, fields: { label: DEFAULT_PROFILE.fields.label } };
  const query = queryForSelection({ ...input, profile, settings, revisions: new Map([[modelRevision, 'live']]) });
  const engine = new Oxigraph(); engine.load(`<${resourceId}> <https://example.org/label> "Door" . <https://example.org/inspection> <https://example.org/about> <${resourceId}> .`, { format: 'text/turtle' });
  const output = engine.query(query, { results_format: 'application/sparql-results+json' });
  assert.equal(typeof output, 'string');
  assert.equal((JSON.parse(output as string) as { results: { bindings: unknown[] } }).results.bindings.length, 2);
  assert.throws(() => queryForSelection({ ...input, profile, settings }), /No explicit/);
});
test('charter #6643 reverse profile identity fields use configured predicate and mapped raw columns', () => {
  const settings = { strategy: 'profile-fields', links: [], identityFields: { GlobalId: 'customGuid', modelRevision: 'revisionUri' } };
  const profile = { ...DEFAULT_PROFILE, fields: { ...DEFAULT_PROFILE.fields, customGuid: { ...DEFAULT_PROFILE.fields.GlobalId, iri: 'https://example.org/customGuid' } } };
  const query = queryForSelection({ ...input, profile, settings });
  const engine = new Oxigraph(); engine.load(`<https://example.org/custom> <https://example.org/customGuid> "${GlobalId}" .`, { format: 'text/turtle' });
  const output = engine.query(query, { results_format: 'application/sparql-results+json' });
  assert.equal(typeof output, 'string'); assert.equal((JSON.parse(output as string) as { results: { bindings: unknown[] } }).results.bindings.length, 1);
  const known = queryForSelection({ ...input, profile, settings, mapping: { id: 'resource', customGuid: 'alias' }, results: { columns: ['resource', 'alias'], rows: [{ resource: { type: 'uri', value: 'https://example.org/custom' }, alias: { type: 'literal', value: GlobalId } }] } });
  assert.ok(known.includes('VALUES ?resource { <https://example.org/custom> }'));
});
test('charter #6643 adjacency queries exclude outsiders and deduplicate shared edges across selected resources', () => {
  const a = 'https://example.org/a'; const b = 'https://example.org/b';
  const settings = { strategy: 'resource-links', links: [a, b].map(resourceId => ({ resourceId, modelRevision: 'https://example.org/rev', GlobalId })) };
  const query = queryForSelection({ ...input, settings, revisions: new Map([['https://example.org/rev', 'live']]) });
  const engine = new Oxigraph(); engine.load(`<${a}> <https://example.org/edge> <${b}> . <https://example.org/outsider> <https://example.org/edge> "unrelated" .`, { format: 'text/turtle' });
  const output = engine.query(query, { results_format: 'application/sparql-results+json' });
  assert.equal(typeof output, 'string');
  const rows = (JSON.parse(output as string) as { results: { bindings: { subject: { value: string }; object: { value: string } }[] } }).results.bindings;
  assert.equal(rows.length, 1); assert.equal(rows[0].subject.value, a); assert.equal(rows[0].object.value, b);
});

test('URI identity #6783 reverse template discovery works before results and retains once-encoded known RDF subjects', () => {
  const guid = '1Oms875aH3Wg$9l65H2ZGw'; const rawId = `https://lbd.org/${guid}`; const encodedId = rawId.replace('$', '%24');
  const settings = { strategy: 'resource-uri', links: [], uriConfig: { mode: 'template' as const, template: 'https://lbd.org/{GlobalId}' } };
  const base = { ...input, entities: [{ ...selected, GlobalId: guid }], settings };
  const engine = new Oxigraph(); engine.load(`<${rawId}> <urn:label> "raw" . <${encodedId}> <urn:label> "encoded" . <urn:inspection> <urn:about> <${encodedId}> . <urn:outsider> <urn:label> "outside" .`, { format: 'text/turtle' });
  const before = queryForSelection(base); const known = queryForSelection({ ...base, mapping: { id: 'resource' }, results: { columns: ['resource'], rows: [{ resource: { type: 'uri', value: encodedId } }] } });
  assert.equal(assertReadOnlyQuery(before), 'select'); assert.equal(assertReadOnlyQuery(known), 'select');
  const run = (query: string) => { const value = engine.query(query, { results_format: 'application/sparql-results+json' }); assert.equal(typeof value, 'string'); return JSON.parse(value as string) as { results: { bindings: { subject: { value: string }; object: { value: string } }[] } }; };
  const initial = run(before).results.bindings; assert.equal(initial.length, 1); assert.equal(initial[0].subject.value, rawId);
  const rows = run(known).results.bindings; assert.equal(rows.length, 2); assert.ok(rows.some(row => row.subject.value === encodedId)); assert.ok(rows.some(row => row.subject.value === 'urn:inspection'));
  assert.ok(!rows.some(row => row.subject.value === 'urn:outsider' || row.subject.value === rawId));
  assert.throws(() => queryForSelection({ ...base, settings: { ...settings, uriConfig: { mode: 'last-path-segment' } } }), /full URI template|known resource/);
  assert.ok(queryForSelection({ ...base, settings: { ...settings, uriConfig: { mode: 'last-path-segment' } }, mapping: { id: 'resource' }, results: { columns: ['resource'], rows: [{ resource: { type: 'uri', value: encodedId } }] } }).includes(encodedId));
});

test('URI identity #6783 mixed known and unknown selected entities preserve encoded subjects and discover every uncovered entity', () => {
  const firstGuid = '1Oms875aH3Wg$9l65H2ZGw'; const secondGuid = '0000000000000000000002';
  const encoded = `https://lbd.org/${firstGuid.replace('$', '%24')}`; const generated = `https://lbd.org/${secondGuid}`;
  const other = { modelId: 'live', expressId: 8 };
  const settings = { strategy: 'resource-uri', links: [], uriConfig: { mode: 'template' as const, template: 'https://lbd.org/{GlobalId}' } };
  const mixed = { ...input, settings, selection: [selected, other], entities: [{ ...selected, GlobalId: firstGuid }, { ...other, GlobalId: secondGuid }], mapping: { id: 'resource' }, results: { columns: ['resource'], rows: [{ resource: { type: 'uri' as const, value: encoded } }] } };
  const engine = new Oxigraph(); engine.load(`<${encoded}> <urn:p> "first" . <${generated}> <urn:p> "second" . <https://lbd.org/${firstGuid}> <urn:p> "wrong alias" .`, { format: 'text/turtle' });
  const response = engine.query(queryForSelection(mixed), { results_format: 'application/sparql-results+json' }); assert.equal(typeof response, 'string');
  const result = JSON.parse(response as string) as { results: { bindings: { subject: { value: string } }[] } };
  assert.deepEqual(result.results.bindings.map(row => row.subject.value).sort(), [encoded, generated].sort());
  assert.throws(() => queryForSelection({ ...mixed, settings: { ...settings, uriConfig: { mode: 'last-path-segment' } } }), /full URI template|known resource/);
});
