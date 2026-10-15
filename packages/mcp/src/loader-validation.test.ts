/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { loadIfcModelFromBytes } from './loader.js';

// PR #7632: all built-in hosts use the same validated STEP boundary.
describe('MCP shared loading validation', () => {
  it.each([
    ['junk ISO-10303-21;\nDATA;\nEND-ISO-10303-21;', 'INVALID_STEP'],
    ['/* ISO-10303-21 */\nDATA;\nEND-ISO-10303-21;', 'INVALID_STEP'],
    ['ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n/* END-ISO-10303-21;', 'TRUNCATED_STEP'],
    ['ISO-10303-21;\nHEADER;\nDATA;\nENDSEC;\nEND-ISO-10303-21;', 'MISSING_DATA'],
  ])('rejects %s', async (input, code) => {
    await expect(loadIfcModelFromBytes(new TextEncoder().encode(input), 'model.ifc'))
      .rejects.toMatchObject({ name: 'IfcInputError', code });
  });
});
