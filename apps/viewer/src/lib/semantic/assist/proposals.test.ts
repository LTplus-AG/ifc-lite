/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredSemanticKind, parseSemanticProposal, semanticProposalCount } from './proposals';
import { lintSemanticQuery, parseSemanticQuery } from './query-proposal';
import { parseSemanticMapping } from './mapping-proposal';
import { parseSemanticProjection } from './projection-proposal';
import { parseSemanticRequirements } from './requirement-proposal';

const span = { source: 'S1', start: 0, end: 5, quote: 'Doors' };
const query = { version: 1, kind: 'semantic.query', title: 'Doors', purpose: 'List installed doors', expected: { form: 'select', columns: ['id', 'GlobalId'] },
  query: 'PREFIX p: <https://example.org/p/> SELECT ?id ?GlobalId WHERE { ?id p:GlobalId ?GlobalId } LIMIT 100' };
const mapping = { version: 1, kind: 'semantic.mapping', title: 'Fire', modelRevision: 'https://example.org/revision/1',
  mappings: [{ ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'FireRating' }, ontology: { property: 'fireRating' }, confidence: 0.8, sources: [span] }] };
const requirements = { version: 1, kind: 'semantic.requirements', title: 'Spec',
  requirements: [{ id: 'R1', statement: 'Doors EI30', appliesTo: { ifcClass: 'IfcDoor' }, property: 'FireRating', operator: 'equals', value: 'EI30', span }],
  unsupported: [{ text: 'as appropriate', reason: 'ambiguous', span }] };
const json = (value: unknown) => JSON.stringify(value);
const refusal = (parse: (answer: string) => unknown, value: unknown, pattern: RegExp) => assert.throws(() => parse(json(value)), pattern);

test('#6920 every semantic kind parses strictly: fenced or bare JSON, unknown fields refused, never prose', () => {
  assert.equal(parseSemanticQuery('```json\n' + json(query) + '\n```').title, 'Doors');
  assert.equal(parseSemanticMapping(json(mapping)).mappings.length, 1);
  assert.equal(parseSemanticRequirements(json(requirements)).unsupported.length, 1);
  assert.equal(parseSemanticProjection(json({ version: 1, kind: 'semantic.projection', title: 'P', projections: [{ resource: 'r', field: 'fireRating' }] })).projections[0].policy, 'error');
  assert.throws(() => parseSemanticQuery('Here is your query: ' + json(query)), /not one complete JSON object/);
  assert.throws(() => parseSemanticQuery(json({ ...query, bearer: 'x' })), /unsupported field "bearer"/);
  assert.throws(() => parseSemanticQuery(json({ ...query, version: 2 })), /version": 1/);
  assert.throws(() => parseSemanticQuery(json({ ...query, kind: 'semantic.mapping' })), /Not a semantic.query/);
  assert.equal(declaredSemanticKind(json(mapping)), 'semantic.mapping');
  assert.equal(declaredSemanticKind('The kind "semantic.query" is described here'), null);
  assert.equal(declaredSemanticKind('{"kind":"clash.groups"}'), null);
  assert.deepEqual([query, mapping, requirements].map(value => semanticProposalCount(parseSemanticProposal(json(value), value.kind as 'semantic.query'))), [1, 1, 2]);
});

test('#6920 span offsets and quotes are validated structurally before any review', () => {
  const bad = (override: object) => refusal(parseSemanticRequirements, { ...requirements, requirements: [{ ...requirements.requirements[0], span: { ...span, ...override } }] }, /span|offsets|quote|attached source|unsupported field/);
  bad({ start: 5, end: 5 }); bad({ start: -1 }); bad({ start: 1.5 }); bad({ source: 'attachment' }); bad({ quote: '' }); bad({ extra: 1 });
  assert.throws(() => parseSemanticRequirements(json({ ...requirements, requirements: [{ ...requirements.requirements[0], span: undefined }] })), /needs a source span/);
  // Ambiguous or unsupported statements are retained, not dropped.
  assert.equal(parseSemanticRequirements(json({ ...requirements, requirements: [] })).unsupported.length, 1);
  assert.throws(() => parseSemanticRequirements(json({ ...requirements, requirements: [], unsupported: [] })), /at least one requirement/);
  refusal(parseSemanticRequirements, { ...requirements, requirements: [requirements.requirements[0], requirements.requirements[0]] }, /unique short id/);
  refusal(parseSemanticRequirements, { ...requirements, requirements: [{ ...requirements.requirements[0], operator: 'equals', value: undefined }] }, /needs a value/);
  refusal(parseSemanticRequirements, { ...requirements, requirements: [{ ...requirements.requirements[0], operator: 'approx' }] }, /operator must be one of/);
});

test('#6920 mapping proposals map class to class or property to property and never repeat a mapping', () => {
  const only = (row: object) => ({ ...mapping, mappings: [{ ...mapping.mappings[0], ...row }] });
  refusal(parseSemanticMapping, only({ ontology: { class: 'Door' } }), /property to a property, or a class to a class/);
  refusal(parseSemanticMapping, only({ ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon' } }), /both a property set and a property/);
  refusal(parseSemanticMapping, only({ ifc: { class: 'Door' } }), /IFC class/);
  refusal(parseSemanticMapping, only({ confidence: 1.2 }), /confidence between 0 and 1/);
  refusal(parseSemanticMapping, { ...mapping, mappings: [mapping.mappings[0], mapping.mappings[0]] }, /repeats an earlier mapping/);
  refusal(parseSemanticMapping, { ...mapping, modelRevision: undefined }, /model revision/);
});

test('#6920 query lint enforces native read-only forms, declared columns and a bounded outer LIMIT', () => {
  const lint = (override: Partial<typeof query> & { expected?: object }) => lintSemanticQuery(parseSemanticQuery(json({ ...query, ...override })));
  assert.deepEqual(lint({}), { ok: true, form: 'select', limit: 100 });
  const issues = (result: ReturnType<typeof lint>) => result.ok ? '' : result.issues.join(' | ');
  assert.match(issues(lint({ query: query.query.replace(' LIMIT 100', '') })), /Add an outer LIMIT/);
  assert.match(issues(lint({ query: query.query.replace('LIMIT 100', 'LIMIT 5001') })), /LIMIT must be between 1 and 5000/);
  assert.match(issues(lint({ query: query.query.replace('?id ?GlobalId WHERE', '* WHERE') })), /SELECT \* cannot be checked/);
  assert.match(issues(lint({ query: query.query.replace('?id ?GlobalId WHERE', '?id WHERE') })), /returns columns id, but the proposal expects GlobalId, id/);
  assert.match(issues(lint({ query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 10' })), /query is CONSTRUCT, but the proposal expects SELECT/);
  // An inner subquery LIMIT never satisfies the outer bound.
  assert.match(issues(lint({ query: 'SELECT ?id ?GlobalId WHERE { { SELECT ?id ?GlobalId WHERE { ?id ?p ?GlobalId } LIMIT 10 } }' })), /Add an outer LIMIT/);
  assert.match(issues(lint({ query: 'SELECT ?id ?GlobalId WHERE { SERVICE <https://evil.example/sparql> { ?id ?p ?GlobalId } } LIMIT 10' })), /SERVICE/);
  assert.match(issues(lint({ query: 'DELETE WHERE { ?s ?p ?o }' })), /Only SELECT and CONSTRUCT/);
  assert.match(issues(lint({ query: 'SELECT ?id ?GlobalId FROM <https://evil.example/g> WHERE { ?id ?p ?GlobalId } LIMIT 10' })), /graph|FROM/i);
});
