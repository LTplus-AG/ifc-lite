/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BASE_MODEL } from './diff-test-helpers.js';
import { CLASS, FIRE, makeDelta } from './layer-test-helpers.js';

const execute = promisify(execFile);
const diffUrl = new URL('../../../diff/dist/index.js', import.meta.url).href;
const commandUrl = (name: string): string => new URL(`../../dist/commands/${name}.js`, import.meta.url).href;

// A separate process is essential: another test's init hook must not hide a
// missing await in an application boundary. Uses the built production facade
// and real WASM, including its default Node asset resolution (#8042).
async function coldCommand(source: string): Promise<string> {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    async function main() {
      const diff = await import(${JSON.stringify(diffUrl)});
      assert.throws(() => diff.stableHash('cold'), /initDiff/);
      await assert.rejects(diff.initDiff({ module_or_path: Uint8Array.of(0) }));
      ${source}
      assert.match(diff.stableHash('ready'), /^[0-9a-f]{16}$/);
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `], { timeout: 60_000 });
  return stdout;
}

describe('consumer initialization with the real Rust facade (#8042)', () => {
  it('retries a failed load at the content-diff boundary before fingerprinting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-diff-init-'));
    try {
      const path = join(dir, 'base.ifc');
      await writeFile(path, BASE_MODEL);
      const stdout = await coldCommand(`
        const { contentDiffCommand } = await import(${JSON.stringify(commandUrl('diff-content'))});
        await contentDiffCommand({ basePath: ${JSON.stringify(path)}, headPath: ${JSON.stringify(path)}, json: true });
      `);
      const result = JSON.parse(stdout) as { counts: { added: number; deleted: number; modified: number; unchanged: number } };
      expect(result.counts).toMatchObject({ added: 0, deleted: 0, modified: 0 });
      expect(result.counts.unchanged).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('initializes the indirect stableHash dependency before a layer comparison', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-layer-init-'));
    try {
      const base = join(dir, 'base.ifcx'), head = join(dir, 'head.ifcx');
      const layer = (rating: string) => makeDelta([
        { path: 'wall', attributes: { [CLASS]: { code: 'IfcWall' }, [FIRE]: rating } },
      ]);
      await writeFile(base, JSON.stringify(layer('REI60')));
      await writeFile(head, JSON.stringify(layer('REI90')));
      const stdout = await coldCommand(`
        const { layerDiffCommand } = await import(${JSON.stringify(commandUrl('layer-diff'))});
        await layerDiffCommand(${JSON.stringify([head, '--against', base, '--store', join(dir, 'store'), '--json'])});
      `);
      const result = JSON.parse(stdout) as { added: string[]; deleted: string[]; modified: { path: string; components: string[] }[] };
      expect(result.added).toEqual([]);
      expect(result.deleted).toEqual([]);
      expect(result.modified).toEqual([{ path: 'wall', components: ['pset:Pset_FireSafety'] }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
