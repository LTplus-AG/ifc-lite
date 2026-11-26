/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadIfcModel, loadIfcModelFromBytes } from './loader.js';

const MINIMAL = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('0000000000000000000001',$,'w',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";

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

  // #11534: model_load needs only read scope, so a FIFO in an allowed root
  // must fail fast instead of blocking the open forever.
  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-fifo-'));
    try {
      const fifo = join(dir, 'pipe.ifc');
      execFileSync('mkfifo', [fifo]);
      await expect(loadIfcModel(fifo)).rejects.toThrow(/not a regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // #11534: --allow is checked on the real path too, so a symlink inside a
  // root cannot lead outside it; a root spelled through a link still works.
  it.skipIf(process.platform === 'win32')('checks allowed roots against real paths', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ifc-lite-roots-'));
    try {
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(outside, 'm.ifc'), MINIMAL);
      await writeFile(join(root, 'in.ifc'), MINIMAL);
      await symlink(join(outside, 'm.ifc'), join(root, 'escape.ifc'));
      await expect(loadIfcModel(join(root, 'escape.ifc'), { allowedPaths: [root] })).rejects.toThrow(/outside the allowed roots/);
      // A root reached through a symlinked directory, and with a trailing separator.
      await symlink(root, join(base, 'linked'));
      await expect(loadIfcModel(join(base, 'linked', 'in.ifc'), { allowedPaths: [join(base, 'linked') + '/'] })).resolves.toBeDefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
