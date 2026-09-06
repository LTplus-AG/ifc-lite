/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite export <model> --format ifc` with no `--type`/`--storey`/`--where`/
 * `--limit` must export the WHOLE model, byte-for-byte entity count.
 *
 * `bim.export.ifc(refs, options)` (packages/cli/src/headless-backend.ts) treats
 * a non-empty `refs` array as an isolation request — it sets `visibleOnly` /
 * `isolatedEntityIds` and re-derives the exported set as the reference closure
 * of `refs`, which is not the same set as "every entity in the file" (it drops
 * entities the query layer doesn't surface directly, e.g. solids owned by
 * non-product entities). `refs` from an UNFILTERED query is every queryable
 * entity — non-empty — so passing it unconditionally silently narrowed a plain
 * `export --format ifc` (#4044). The fix: only isolate when a filter was
 * actually requested; pass an empty array (this backend's existing "whole
 * model" signal — see headless-test-helpers.ts and mutate.ts) otherwise.
 *
 * These call `exportCommand` directly (as export.whole-model-filters.test.ts
 * does) so the assertions can read the written file and stderr without a
 * separate CLI process.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample, so this never needs `pnpm fixtures`.
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

const dirs: string[] = [];
function outFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ifclite-export-ifc-no-filter-'));
  dirs.push(d);
  return join(d, name);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Count STEP entity lines (`#123=...`) — one per line in this writer's output. */
function countStepEntities(text: string): number {
  return (text.match(/^#\d+=/gm) ?? []).length;
}

describe('export --format ifc with no filter exports the whole model', () => {
  it('preserves the input entity count exactly with no filter flags', async () => {
    const inputCount = countStepEntities(readFileSync(SAMPLE_IFC, 'utf-8'));
    const out = outFile('m.ifc');

    await exportCommand([SAMPLE_IFC, '--format', 'ifc', '--out', out]);

    const outputCount = countStepEntities(readFileSync(out, 'utf-8'));
    // RED before the fix: the unfiltered query's non-empty `refs` triggered the
    // isolation path, so `outputCount` was strictly less than `inputCount`.
    expect(outputCount).toBe(inputCount);
  }, 60_000);

  it('still narrows correctly when a real filter is given (control)', async () => {
    const inputCount = countStepEntities(readFileSync(SAMPLE_IFC, 'utf-8'));
    const out = outFile('m.ifc');

    await exportCommand([SAMPLE_IFC, '--format', 'ifc', '--type', 'IFCWALL', '--out', out]);

    const outputCount = countStepEntities(readFileSync(out, 'utf-8'));
    // A genuine filter must still narrow — a wall-only export of a model with
    // other product types cannot equal the full entity count.
    expect(outputCount).toBeGreaterThan(0);
    expect(outputCount).toBeLessThan(inputCount);
    expect(readFileSync(out, 'utf-8')).toMatch(/=IFCWALL\(/);
  }, 60_000);
});
