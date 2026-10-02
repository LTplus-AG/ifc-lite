/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const GUID_PATTERN = '^[0-3][0-9A-Za-z_$]{21}$';
/** W3C SPARQL JSON RDF terms; an absent binding remains absent. */
export interface RdfBinding {
  type: 'uri' | 'literal' | 'bnode';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}
export interface SparqlResults { columns: string[]; rows: Record<string, RdfBinding>[] }
/** Multi-valued predicates are preserved independently of any domain profile. */
export interface SemanticRecord { id: string; types: string[]; properties: Record<string, RdfBinding[]> }
export interface SemanticDataset {
  id: string; source: string; completeness: 'complete' | 'partial';
  resources?: SemanticRecord[]; rows?: SparqlResults;
  graph?: string; graphFormat?: 'text/turtle' | 'application/n-quads'; profileId?: string;
}
export const LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, rows: 5000, quads: 50000, findings: 1000, literalCharacters: 65536, query: 256000, timeoutMs: 15000 });
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function assertIri(value: string): void {
  if (!value || /[\s<>"{}|^`\\]/u.test(value)) throw new Error('Expected an absolute IRI');
  try { new URL(value); } catch { throw new Error('Expected an absolute IRI'); }
}
