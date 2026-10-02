/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DataFactory, type Store } from 'n3';
import { assertBoundedPattern } from './profiles.js';
const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const counts = new Set(['minCount', 'maxCount', 'maxLength']);
const booleans = new Set(['closed', 'uniqueLang', 'deactivated']);
const strings = new Set(['pattern', 'flags']);
/** Check executable scalar parameters before the engine can coerce or ignore them.
 * SHACL 4.2 / 4.4 / 4.8 and 2.1.6: https://www.w3.org/TR/shacl/.
 */
export function assertShapeParameters(shapes: Store): void {
  const seen = new Set<string>();
  const normalized: ReturnType<Store['getQuads']> = [];
  for (const quad of shapes) {
    if (!quad.predicate.value.startsWith(SH)) continue;
    const name = quad.predicate.value.slice(SH.length);
    if (!counts.has(name) && !booleans.has(name) && !strings.has(name)) continue;
    const key = JSON.stringify([quad.subject.termType, quad.subject.value, name]);
    if (seen.has(key)) throw new Error(`SHACL ${name} requires at most one value per shape`);
    seen.add(key);
    const value = quad.object;
    if (counts.has(name) && (value.termType !== 'Literal' || value.datatype.value !== XSD + 'integer'
      || !/^\+?\d+$/.test(value.value) || !Number.isSafeInteger(Number(value.value)))) {
      throw new Error(`SHACL ${name} must be a non-negative integer within the supported safe range`);
    }
    if (booleans.has(name)) {
      if (value.termType !== 'Literal' || value.datatype.value !== XSD + 'boolean' || !/^(true|false|1|0)$/.test(value.value)) {
        throw new Error(`SHACL ${name} must be an xsd:boolean`);
      }
      // The engine compares RDF terms against the canonical lexical 'true'.
      if (value.value === '1' || value.value === '0') normalized.push(DataFactory.quad(quad.subject, quad.predicate, quad.object, quad.graph));
    }
    if (strings.has(name)) {
      if (value.termType !== 'Literal' || value.datatype.value !== XSD + 'string') throw new Error(`SHACL ${name} must be an xsd:string`);
      if (name === 'pattern') assertBoundedPattern(value.value, 'SHACL shape');
      if (name === 'flags' && (!/^[isu]*$/.test(value.value) || new Set(value.value).size !== value.value.length)) {
        throw new Error('Unsupported SHACL regular-expression flags');
      }
    }
  }
  for (const quad of normalized) {
    shapes.removeQuad(quad);
    shapes.addQuad(quad.subject, quad.predicate, DataFactory.literal(quad.object.value === '1' ? 'true' : 'false', DataFactory.namedNode(XSD + 'boolean')), quad.graph);
  }
}
