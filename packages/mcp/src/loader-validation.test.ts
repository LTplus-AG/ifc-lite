/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadIfcModel, loadIfcModelFromBytes } from './loader.js';

// PR #7632: all built-in hosts use the same validated STEP boundary.
describe('MCP shared loading validation', () => {
  it('returns the same empty-input code for a path and its bytes (PR #7632)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifclite-empty-'));
    try {
      const path = join(dir, 'empty.ifc');
      await writeFile(path, new Uint8Array());
      await expect(loadIfcModel(path)).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
      await expect(loadIfcModelFromBytes(new Uint8Array(), 'empty.ifc')).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
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
