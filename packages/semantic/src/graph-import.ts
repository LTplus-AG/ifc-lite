/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import jsonld from 'jsonld';
import type { JsonLdDocument } from 'jsonld';
import { Parser, Writer } from 'n3';
import { LIMITS, isObject } from './types.js';

export interface GraphImportOptions { format: 'text/turtle' | 'application/n-quads' | 'application/ld+json'; maxBytes?: number; maxQuads?: number }
/** Reject remote and scoped remote contexts before conversion; imports never run code or fetch URLs. */
function assertInlineContexts(value: unknown): void {
  const pending: unknown[] = [value]; let visits = 0;
  while (pending.length) {
    if (++visits > 100000) throw new Error('JSON-LD exceeds the 100,000 node work limit');
    const node = pending.pop();
    if (Array.isArray(node)) { for (const value of node) pending.push(value); continue; }
    if (!isObject(node)) continue;
    if ('@context' in node) {
      const contexts = Array.isArray(node['@context']) ? node['@context'] : [node['@context']];
      if (contexts.some(context => context !== null && !isObject(context))) throw new Error('Only inline JSON-LD contexts are supported; remote contexts are disabled');
    }
    if ('@import' in node) throw new Error('JSON-LD context imports are disabled');
    for (const value of Object.values(node)) pending.push(value);
  }
}
export async function parseGraph(input: unknown, options: GraphImportOptions): Promise<{ graph: string; format: 'application/n-quads'; quadCount: number }> {
  const maxBytes = options.maxBytes ?? LIMITS.bytes; const maxQuads = options.maxQuads ?? LIMITS.quads;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMITS.bytes || !Number.isInteger(maxQuads) || maxQuads < 1 || maxQuads > LIMITS.quads) throw new Error('Invalid graph import limits');
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > maxBytes) throw new Error('Graph exceeds the byte limit');
  let rdf: string;
  if (options.format === 'application/ld+json') {
    let document: unknown = input;
    if (typeof input === 'string') {
      try { document = JSON.parse(input); }
      catch { throw new Error('Invalid JSON-LD JSON syntax; provide a valid JSON object or array'); }
    }
    if (!isObject(document) && !Array.isArray(document)) throw new Error('Expected a JSON-LD document');
    assertInlineContexts(document);
    const converted = await jsonld.toRDF(document as JsonLdDocument, { format: 'application/n-quads',
      documentLoader: async () => { throw new Error('Remote JSON-LD documents and contexts are disabled'); } });
    if (typeof converted !== 'string') throw new Error('Expected N-Quads from JSON-LD conversion');
    rdf = converted;
  } else {
    if (typeof input !== 'string') throw new Error('Turtle and N-Quads input must be text');
    rdf = input;
  }
  if (new TextEncoder().encode(rdf).byteLength > maxBytes) throw new Error('Converted graph exceeds the byte limit');
  const quads = new Parser({ format: options.format === 'text/turtle' ? 'text/turtle' : 'N-Quads' }).parse(rdf);
  if (quads.length > maxQuads) throw new Error('Graph exceeds the quad limit');
  // N-Quads retains graph names, blank nodes, repeated predicates and literal metadata.
  const writer = new Writer({ format: 'N-Quads' }); writer.addQuads(quads);
  const graph = await new Promise<string>((resolve, reject) => writer.end((error, value) => error ? reject(error) : resolve(value)));
  if (new TextEncoder().encode(graph).byteLength > maxBytes) throw new Error('Serialized graph exceeds the byte limit');
  return { graph, format: 'application/n-quads', quadCount: quads.length };
}
