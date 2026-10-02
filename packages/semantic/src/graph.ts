/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Parser } from 'n3';
import { LIMITS, type RdfBinding, type SemanticRecord } from './types.js';
import { createRecordAccumulator } from './results.js';
/** Keep original dataset text for named graph identity; records are an explicit subject projection. */
export function recordsFromGraph(graph: string, format: 'text/turtle' | 'application/n-quads' = 'text/turtle'): SemanticRecord[] {
  if (new TextEncoder().encode(graph).length > LIMITS.bytes) throw new Error('RDF graph exceeds byte limit');
  const quads = new Parser({ format }).parse(graph);
  if (quads.length > LIMITS.quads) throw new Error('RDF graph exceeds quad limit');
  const term = (value: (typeof quads)[number]['object']): RdfBinding => {
    if (value.termType === 'NamedNode') return { type: 'uri', value: value.value };
    if (value.termType === 'BlankNode') return { type: 'bnode', value: value.value };
    if (value.termType === 'Literal') return { type: 'literal', value: value.value,
      ...(value.language ? { 'xml:lang': value.language } : { datatype: value.datatype.value }) };
    throw new Error('RDF-star quoted triples are outside the supported RDF 1.1 term model');
  };
  const accumulator = createRecordAccumulator();
  for (const quad of quads) accumulator.append(term(quad.subject), term(quad.predicate), term(quad.object));
  return accumulator.records();
}
