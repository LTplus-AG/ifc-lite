/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { recordsFromGraph } from './graph.js';
import { recordsFromResults } from './results.js';
import { LIMITS, type RdfBinding } from './types.js';

it('PR #6645 Q9Yb: preserves every value of a maximal single-predicate graph without chunk merging', () => {
  const graph = Array.from({ length: LIMITS.quads }, (_, index) => `<urn:s> <urn:p> "v${index}".`).join('\n');
  const records = recordsFromGraph(graph);
  expect(records).toHaveLength(1);
  const values = records[0].properties['urn:p'];
  expect(values).toHaveLength(LIMITS.quads);
  expect(new Set(values.map(term => term.value)).size).toBe(LIMITS.quads);
  expect(values[0].value).toBe('v0');
  expect(values.at(-1)?.value).toBe(`v${LIMITS.quads - 1}`);
});

it('PR #6645 Q9Yb: SELECT projection preserves 5000 distinct values of one predicate', () => {
  const rows = Array.from({ length: LIMITS.rows }, (_, index) => ({
    subject: { type: 'uri', value: 'urn:s' } as RdfBinding,
    predicate: { type: 'uri', value: 'urn:p' } as RdfBinding,
    object: { type: 'literal', value: `v${index}` } as RdfBinding,
  }));
  const records = recordsFromResults({ columns: ['subject', 'predicate', 'object'], rows });
  expect(records[0].properties['urn:p'].map(term => term.value)).toEqual(rows.map(row => row.object.value));
});

it('PR #6645 Q9Yb: graph and SELECT deduplicate exact RDF terms while retaining lexical and metadata distinctions', () => {
  const objects: RdfBinding[] = [
    { type: 'literal', value: '01', datatype: 'http://www.w3.org/2001/XMLSchema#integer' },
    { type: 'literal', value: '1', datatype: 'http://www.w3.org/2001/XMLSchema#integer' },
    { type: 'literal', value: '01', datatype: 'http://www.w3.org/2001/XMLSchema#string' },
    { type: 'literal', value: '01', 'xml:lang': 'en' },
    { type: 'literal', value: '01', 'xml:lang': 'de' },
    { type: 'uri', value: 'urn:term' }, { type: 'bnode', value: 'term' },
    { type: 'literal', value: 'urn:term', datatype: 'http://www.w3.org/2001/XMLSchema#string' },
  ];
  const rows = [...objects, ...objects].map(object => ({ subject: { type: 'uri', value: 'urn:s' } as RdfBinding,
    predicate: { type: 'uri', value: 'urn:p' } as RdfBinding, object }));
  const fromResults = recordsFromResults({ columns: ['subject', 'predicate', 'object'], rows });
  expect(fromResults[0].properties['urn:p']).toEqual(objects);
  const graph = '<urn:s> <urn:p> "01"^^<http://www.w3.org/2001/XMLSchema#integer>, "1"^^<http://www.w3.org/2001/XMLSchema#integer>, "01", "01"@en, "01"@de, <urn:term>, _:term, "urn:term"; a <urn:Class>, <urn:Class>.';
  const fromGraph = recordsFromGraph(graph + graph);
  // N3 scopes blank-node labels per parse; identity is the RDF term kind and
  // preservation of one node across duplicate triples, not the parser label.
  expect(fromGraph[0].properties['urn:p']).toEqual(objects.map(object => object.type === 'bnode'
    ? expect.objectContaining({ type: 'bnode' }) : object));
  expect(fromGraph[0].types).toEqual(['urn:Class']);
});
