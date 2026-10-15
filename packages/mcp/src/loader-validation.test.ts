/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadIfcModel, loadIfcModelFromBytes } from './loader.js';

// PR #7632: share input errors while preserving the existing recovery loader.
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
  it('rejects bytes with no STEP signature using a structured error', async () => {
    await expect(loadIfcModelFromBytes(new TextEncoder().encode('not a model'), 'model.ifc'))
      .rejects.toMatchObject({ name: 'IfcInputError', code: 'INVALID_STEP' });
  });
  it('preserves partial-file recovery through the existing loader (PR #7632)', async () => {
    const input = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n" +
      "#1=IFCWALL('0000000000000000000001',$,'Recovered wall',$,$,$,$,$,$);";
    const loaded = await loadIfcModelFromBytes(new TextEncoder().encode(input), 'partial.ifc');
    expect(loaded.store.entities.getTypeName(1)).toBe('IfcWall');
    expect(loaded.bim.query().byType('IfcWall').count()).toBe(1);
  });
  it('preserves a DATA-less prefix as an empty recovery model (PR #7632)', async () => {
    const input = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nEND-ISO-10303-21;";
    const loaded = await loadIfcModelFromBytes(new TextEncoder().encode(input), 'prefix.ifc');
    expect(loaded.store.entityCount).toBe(0);
  });
});
