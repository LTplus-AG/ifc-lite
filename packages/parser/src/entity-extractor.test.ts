/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { EntityExtractor } from './entity-extractor.js';
import type { EntityRef } from './types.js';

/** Build an EntityExtractor over a single STEP record and extract it. */
function extract(record: string) {
  const bytes = new TextEncoder().encode(record);
  const ref: EntityRef = {
    expressId: 1,
    type: 'IFCPROPERTYSINGLEVALUE',
    byteOffset: 0,
    byteLength: bytes.length,
    lineNumber: 1,
  };
  return new EntityExtractor(bytes).extractEntity(ref);
}

describe('EntityExtractor typed-value unwrapping', () => {
  it('unwraps a single-line typed string value', () => {
    const ent = extract(`#1=IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('3410_balustrades'),$);`);
    expect(ent?.attributes[2]).toEqual(['IFCLABEL', '3410_balustrades']);
  });

  it('unwraps a typed string value whose text is broken across physical lines', () => {
    // Authoring tools wrap long STEP lines; a raw newline can land inside the
    // string literal. The typed value must still be decomposed, not leaked as a
    // raw `IFCLABEL('...')` literal.
    const ent = extract(
      `#1=IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('3410_balustrades en leuningen\r\n - balustrades'),$);`,
    );
    expect(ent?.attributes[2]).toEqual([
      'IFCLABEL',
      '3410_balustrades en leuningen\r\n - balustrades',
    ]);
  });

  it('unwraps a numeric typed value split across lines and keeps it numeric', () => {
    const ent = extract(`#1=IFCPROPERTYSINGLEVALUE('N',$,IFCREAL(\r\n1.5\r\n),$);`);
    expect(ent?.attributes[2]).toEqual(['IFCREAL', 1.5]);
  });
});
