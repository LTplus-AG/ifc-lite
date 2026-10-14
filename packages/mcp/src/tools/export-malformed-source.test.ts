/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModelFromBytes } from '../loader.js';
import { exportTools } from './export.js';

const source = readFileSync(new URL('../../../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');
let directory: string;
beforeAll(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'mcp-malformed-export-'))); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('#7541 registered SDK/MCP STEP export refuses known partial source', () => {
  for (const clean of [false, true]) {
    it(`${clean ? 'writes all valid' : 'refuses omitted'} records through the actual handler`, async () => {
      const text = clean ? source.replace("it's", "it''s").replace("Bob's", "Bob''s") : source;
      const model = await loadIfcModelFromBytes(new TextEncoder().encode(text), 'authored.ifc', 'authored');
      expect(model.store.malformedRecordCount).toBe(clean ? 0 : 1);
      expect(model.store.entityIndex.byId.has(22)).toBe(true);
      expect(model.store.entityIndex.byId.has(20)).toBe(clean);
      const ctx: ToolContext = { registry: new InMemoryModelRegistry(), scope: fullScope(),
        progress: NOOP_PROGRESS, log: SILENT_LOGGER, signal: new AbortController().signal,
        config: { ...DEFAULT_CONFIG, allowedPaths: [directory] } };
      ctx.registry.add(model);
      const tool = exportTools.find(candidate => candidate.name === 'export_ifc');
      expect(tool).toBeDefined();
      const destination = join(directory, clean ? 'valid.ifc' : 'refused.ifc');
      if (!clean) {
        expect(() => model.bim.export.ifc()).toThrow(/source index incomplete/);
        await expect(tool!.handler({ file_path: destination }, ctx)).rejects.toThrow(/source index incomplete/);
        await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const result = await tool!.handler({ file_path: destination }, ctx);
        expect(result.isError).not.toBe(true);
        const exported = await loadIfcModelFromBytes(await readFile(destination), 'roundtrip.ifc', 'roundtrip');
        expect(Array.from(exported.store.entityIndex.byId.keys())).toEqual([1, 2, 3, 20, 21, 22, 30, 31]);
        expect(exported.store.malformedRecordCount).toBe(0);
      }
    });
  }
});
