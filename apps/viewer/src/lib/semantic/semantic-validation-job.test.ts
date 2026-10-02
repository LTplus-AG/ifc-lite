/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store as Oxigraph } from 'oxigraph';
import { toRdf, parseResults } from '@ifc-lite/semantic';
import { executeValidation } from './validation-job';
import { pilotDocument, PILOT_QUERY } from './demo';
test('charter #6643 worker job maps real SELECT results and validates them through the existing profile pipeline', async () => {
  const original = pilotDocument(); const rdf = await toRdf(original);
  const engine = new Oxigraph(); engine.load(rdf, { format: 'application/n-quads' });
  const result = engine.query(PILOT_QUERY, { results_format: 'application/sparql-results+json' });
  assert.equal(typeof result, 'string');
  const results = parseResults(JSON.parse(result as string) as unknown);
  const output = await executeValidation({ results, source: original.source });
  assert.deepEqual(output.document?.resources.map(record => record.id).sort(), original.resources.map(record => record.id).sort());
  assert.equal(output.document?.completeness, 'partial'); assert.equal(output.findings.length, 4);
  assert.ok(output.graph.includes('https://example.org/ifc-lite/pilot/inspection.pdf'));
  assert.equal(output.report?.conforms, false);
});
test('charter #6643 unsupported analytical SELECT remains raw and cannot claim profile conformance', async () => {
  const results = parseResults({ head: { vars: ['count'] }, results: { bindings: [{ count: { type: 'literal', value: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }] } });
  await assert.rejects(executeValidation({ results }), /Project resource/);
  assert.equal(results.rows[0].count.value, '42'); assert.equal(results.rows[0].count.datatype, 'http://www.w3.org/2001/XMLSchema#integer');
});
