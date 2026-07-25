/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite clash --json` must emit exactly one JSON document on stdout.
 *
 * Regression test: the geometry/opening pipeline (including wasm print
 * bindings) used to write "[IFC-LITE] ..." diagnostic lines to stdout via
 * console.log/info, interleaving with the JSON payload and forcing consumers
 * to scrape the trailing JSON. Diagnostics now go to stderr.
 *
 * Runs the real built CLI as a subprocess on a synthetic wall+door model.
 * The hosted door guarantees the opening pipeline emits its "[IFC-LITE]"
 * classifier/rect_fast diagnostics, so the test proves they land on stderr
 * rather than proving nothing on a silent model.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IfcCreator } from '@ifc-lite/create';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '../../dist/index.js');
const WASM_RUNTIME = join(__dirname, '../../../wasm/pkg/ifc-lite_bg.wasm');

// Meshing needs the built CLI plus the wasm runtime (gitignored, rebuilt per
// host). Skip cleanly when either is absent: build with
// `pnpm turbo run build --filter=@ifc-lite/cli` and `scripts/build-wasm.sh`.
const canRun = existsSync(CLI_ENTRY) && existsSync(WASM_RUNTIME);

function buildClashModel(): string {
  const creator = new IfcCreator({ Name: 'ClashJsonTest' });
  const storey = creator.addIfcBuildingStorey({ Name: 'L1', Elevation: 0 });
  // Wall with a hosted door: triggers the opening/void pipeline and its
  // "[IFC-LITE]" console diagnostics during meshing.
  const wall = creator.addIfcWall(storey, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  creator.addIfcWallDoor(wall, { Width: 0.9, Height: 2.1, Position: [1.5, 0, 0] });
  // Second wall crossing the first so the run reports at least one clash.
  creator.addIfcWall(storey, { Start: [2, -2, 0], End: [2, 2, 0], Height: 3, Thickness: 0.2 });
  return creator.toIfc().content;
}

describe('clash --json stdout hygiene', () => {
  it.skipIf(!canRun)(
    'stdout is exactly one parseable JSON document; diagnostics go to stderr',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-json-'));
      const modelPath = join(dir, 'model.ifc');
      try {
        await writeFile(modelPath, buildClashModel());

        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [CLI_ENTRY, 'clash', modelPath, '--json'],
          { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
        );

        // The whole of stdout must parse directly - no extractTrailingJson
        // style scraping allowed.
        const payload = JSON.parse(stdout) as {
          summary: { total: number };
          clashes: unknown[];
        };
        expect(stdout.trimStart().startsWith('{')).toBe(true);
        expect(payload.summary.total).toBeGreaterThan(0);
        expect(Array.isArray(payload.clashes)).toBe(true);
        expect(stdout).not.toContain('[IFC-LITE]');

        // The diagnostics are not swallowed - they moved to stderr. This also
        // proves the model actually exercised the noisy opening pipeline.
        expect(stderr).toContain('[IFC-LITE]');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
