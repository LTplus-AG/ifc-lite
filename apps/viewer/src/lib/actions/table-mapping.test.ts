/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// P15 (#6912): the typed table.mapping contract and the "Suggest mapping" request.

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { installSampleModel, SAMPLE_WALLS } from '@/test/sample-corrections-fixture';
import { parseTableMapping, validateTableMapping } from './table-mapping';
import { suggestTableMapping, tableMappingContext } from './table-mapping-request';

const originalFetch = globalThis.fetch;
const original = useViewerStore.getState();
afterEach(() => { globalThis.fetch = originalFetch; useViewerStore.setState(original); });

const draft = {
  version: 1, kind: 'table.mapping', title: 'Wall schedule', identity: { column: 'GUID', key: 'GlobalId' },
  columns: [
    { column: 'Fire', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' },
    { column: 'Width [mm]', target: 'quantity', qset: 'Qto_WallBaseQuantities', name: 'Width', unit: 'mm' },
  ],
};

test('the mapping contract refuses what cannot be converted safely', () => {
  assert.equal(parseTableMapping(`\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``).columns.length, 2);
  const refuse = (patch: Record<string, unknown>, pattern: RegExp) => assert.throws(() => parseTableMapping(JSON.stringify({ ...draft, ...patch })), pattern);
  refuse({ identity: { column: 'GUID', key: 'ExpressId' } }, /identity must name a column and a key/);
  refuse({ columns: [{ column: 'Fire', target: 'property', pset: 'P', name: 'X' }] }, /valueType/);
  refuse({ columns: [{ column: 'Fire', target: 'quantity', qset: 'Q', name: 'X', unit: 'furlong' }] }, /unknown unit/);
  refuse({ columns: [{ column: 'Fire', target: 'attribute', name: 'GlobalId' }] }, /can only set Name/);
  refuse({ columns: [] }, /at least one data column/);
});

test('validation names unknown columns, a written identity column, duplicate targets and units on text', () => {
  const mapping = parseTableMapping(JSON.stringify({ ...draft, columns: [
    { column: 'Fire', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text', unit: 'mm' },
    { column: 'Rating', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' },
    { column: 'GUID', target: 'attribute', name: 'Tag' },
    { column: 'Nope', target: 'attribute', name: 'Name' },
  ] }));
  assert.deepEqual(validateTableMapping(mapping, ['GUID', 'Fire', 'Rating']).map((p) => [p.kind, p.column]), [
    ['unit-needs-number', 'Fire'], ['target-twice', 'Rating'], ['identity-mapped', 'GUID'], ['unknown-column', 'Nope']]);
  assert.deepEqual(validateTableMapping(parseTableMapping(JSON.stringify(draft)), ['GUID', 'Fire', 'Width [mm]']), []);
});

test('Suggest mapping sends bounded headers, samples and model set names, and returns only a strictly parsed draft', async () => {
  await installSampleModel();
  const rows = [{ GUID: SAMPLE_WALLS.rightFront, Fire: 'EI60', 'Width [mm]': '250', Note: 'x'.repeat(500) }];
  const context = tableMappingContext(useViewerStore.getState(), 'sample', Object.keys(rows[0]), rows);
  assert.ok(context.modelSets.qsets.Qto_WallBaseQuantities.includes('Width'), 'names come from the element the table names');
  assert.equal(context.sample[0].Note.length, 81, 'cells are clipped');

  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] })}\n\n`);
  };
  const outcome = await suggestTableMapping(context, 'openai/gpt-free', '/api/chat');
  assert.ok(outcome.ok);
  assert.equal(outcome.mapping.identity.key, 'GlobalId');
  assert.match(String(body.system), /untrusted/);
  assert.match(JSON.stringify(body.messages), /Qto_WallBaseQuantities/);

  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Here is a mapping: {"kind":"table.mapping"}' }, finish_reason: 'stop' }] })}\n\n`);
  const invalid = await suggestTableMapping(context, 'openai/gpt-free', '/api/chat');
  assert.deepEqual(invalid.ok ? null : invalid.reason, 'invalid');
});
