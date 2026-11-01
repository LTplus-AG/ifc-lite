/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWithStrategy, identityFromRow, createIndexedIdentityResolver } from './resolver-context';
import { parseResourceLinks } from '@/components/viewer/SemanticIdentityControls';
const GlobalId = '0000000000000000000001';
const context = { entities: [{ modelId: 'current', expressId: 42, GlobalId }], revisions: new Map([['https://example.org/revision', 'current']]) };
test('charter #6643 explicit resource links and profile fields resolve through the shared strategy registry', () => {
  const links = parseResourceLinks(JSON.stringify([{ resourceId: 'https://example.org/resource', modelRevision: 'https://example.org/revision', GlobalId, expressId: 999, modelId: 'old' }]));
  assert.equal('expressId' in links[0], false); assert.equal('modelId' in links[0], false);
  assert.deepEqual(resolveWithStrategy({ id: 'https://example.org/resource' }, context, { strategy: 'resource-links', links }), { status: 'resolved', ref: { modelId: 'current', expressId: 42 } });
  assert.equal(resolveWithStrategy({ id: 'https://example.org/resource' }, { ...context, revisions: new Map() }, { strategy: 'resource-links', links }).status, 'unscoped');
  assert.equal(resolveWithStrategy({ customGuid: GlobalId, revisionUri: 'https://example.org/revision' }, context,
    { strategy: 'profile-fields', links: [], identityFields: { GlobalId: 'customGuid', modelRevision: 'revisionUri' } }).status, 'resolved');
  assert.equal(resolveWithStrategy({}, context, { strategy: 'unknown', links: [] }).status, 'invalid');
  assert.throws(() => parseResourceLinks('[{"resourceId":"relative","modelRevision":"https://example.org/rev","GlobalId":"0000000000000000000001"}]'), /IRI/);
});

test('charter #6643 identity result bindings reject typed numbers and language-tagged GUIDs', () => {
  assert.equal(identityFromRow({ GlobalId: { type: 'literal', value: GlobalId, datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }, {}), undefined);
  assert.equal(identityFromRow({ GlobalId: { type: 'literal', value: GlobalId, 'xml:lang': 'en' } }, {}), undefined);
  assert.equal(identityFromRow({ GlobalId: { type: 'literal', value: GlobalId }, modelRevision: { type: 'literal', value: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }, {}), undefined);
  assert.equal(identityFromRow({ alias: { type: 'literal', value: GlobalId } }, { customGuid: 'alias' }, { strategy: 'profile-fields', links: [], identityFields: { GlobalId: 'customGuid' } })?.customGuid, GlobalId);
});

test('URI identity #6783 accepts URI RDF terms only and never changes explicit direct GUID semantics', () => {
  const settings = { strategy: 'resource-uri', links: [] };
  const id = `https://lbd.org/${GlobalId}`;
  const mapped = identityFromRow({ resource: { type: 'uri', value: id } }, { id: 'resource' }, settings);
  assert.ok(mapped); assert.equal(mapped.id, id); assert.equal(resolveWithStrategy(mapped, context, settings).status, 'resolved');
  for (const type of ['literal', 'bnode'] as const) assert.equal(identityFromRow({ id: { type, value: id } }, {}, settings), undefined);
  const direct = { strategy: 'ifc-global-id', links: [] };
  assert.equal(resolveWithStrategy({ id, GlobalId: 'wrong' }, context, direct).status, 'invalid');
});


test('#8556 indexed batch resolution bounds GlobalId reads and retains URI ambiguity', () => {
  let reads = 0;
  const guid = (id: number) => String(id).padStart(22, '0');
  const entities = Array.from({ length: 100000 }, (_, id) => ({ modelId: 'm', expressId: id + 1, get GlobalId() { reads++; return guid(id); } }));
  const resolve = createIndexedIdentityResolver({ entities, revisions: new Map() }, { strategy: 'resource-uri', links: [] });
  for (let id = 0; id < 5000; id++) assert.deepEqual(resolve({ id: `https://lbd.org/${guid(id)}` }), { status: 'resolved', ref: { modelId: 'm', expressId: id + 1 } });
  assert.ok(reads <= 105000, `one snapshot scan plus candidate reads, got ${reads}`);
  const duplicate = [...entities.slice(0, 1), { modelId: 'other', expressId: 1, GlobalId: guid(0) }];
  const ambiguous = createIndexedIdentityResolver({ entities: duplicate, revisions: new Map() }, { strategy: 'resource-uri', links: [] });
  assert.equal(ambiguous({ id: `https://lbd.org/${guid(0)}` }).status, 'ambiguous');
});
