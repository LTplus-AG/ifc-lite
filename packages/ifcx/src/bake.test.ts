/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcxFile } from './types.js';
import { bakeLayers } from './bake.js';

function makeFile(
  imports: IfcxFile['imports'],
  schemas: IfcxFile['schemas'],
  id: string
): IfcxFile {
  return {
    header: {
      id,
      ifcxVersion: 'ifcx-alpha',
      dataVersion: '1',
      author: 'test',
      timestamp: '2026-06-09T00:00:00Z',
    },
    imports,
    schemas,
    data: [{ path: 'x', attributes: { a: 1 } }],
  };
}

describe('bakeLayers import/schema merge precedence', () => {
  it('dedupes imports on the same URI with the strongest (last) layer winning, matching mergeSchemas', () => {
    // bakeLayers takes layers weakest-first, strongest-last (its own doc
    // comment). mergeSchemas resolves same-key conflicts with the last
    // (strongest) layer's value via Object.assign; dedupeImports must
    // agree for the same URI, not silently keep the first (weakest)
    // layer's import metadata.
    const weak = makeFile(
      [{ uri: 'shared-uri', integrity: 'weak-hash' }],
      { 'shared-schema': { version: 'weak' } as any },
      'weak'
    );
    const strong = makeFile(
      [{ uri: 'shared-uri', integrity: 'strong-hash' }],
      { 'shared-schema': { version: 'strong' } as any },
      'strong'
    );

    const baked = bakeLayers([weak, strong]);

    assert.strictEqual(baked.imports.length, 1);
    assert.strictEqual(baked.imports[0].integrity, 'strong-hash');
    assert.strictEqual((baked.schemas['shared-schema'] as any).version, 'strong');
  });
});
