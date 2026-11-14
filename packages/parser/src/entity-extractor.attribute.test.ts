/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { EntityExtractor } from './entity-extractor.js';

// #9928: selective decoding must preserve the full reader's value semantics.
describe('selective STEP attribute decoding (#9928)', () => {
  for (const params of [
    "'a,()''b',#42,(#1,(#2,#3)),IFCLABEL('typed'),$,.T.",
    "/* comma, paren) */ #2,('nested',IFCREAL(3.5)),5/* split */6,*,()",
    "'PAGE \\S\\\' text',#12,('Unicode \\X2\\00E4\\X0\\')",
    '$,,$,',
  ]) {
    it(`matches full decoding for ${params}`, () => {
      const bytes = new TextEncoder().encode(`#1=IFCWALL /* trivia */ (${params});`);
      const ref = { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: bytes.length, lineNumber: 1 };
      const extractor = new EntityExtractor(bytes);
      const full = extractor.extractEntity(ref)!;
      for (let index = 0; index <= full.attributes.length; index++) {
        expect(extractor.extractAttribute(ref, index)).toEqual(full.attributes[index]);
      }
      expect(extractor.extractAttribute(ref, -1)).toBeUndefined();
    });
  }
});
