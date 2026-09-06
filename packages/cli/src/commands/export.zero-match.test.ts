/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4047 added a `fatal()` when an entity-isolating filter (`--type`/`--where`/
 * `--storey`/`--limit`) matches ZERO entities, for every isolating export
 * format — fixing a prior bug where a zero-match `--type` on `--format ifc`
 * silently exported the WHOLE model instead of failing (the isolation set
 * was empty, and an empty isolation set means "export everything" to both
 * `bim.export.ifc()` and the Rust wasm exporters). No test in the repo
 * exercised that guard: it was verified once by hand during review (mutating
 * `if (filterRequested && refs.length === 0)` to `if (false && ...)`, seeing
 * the corresponding test go from a rejection to a resolved promise) and never
 * captured, so a future refactor could remove the guard and nothing would
 * notice.
 *
 * Covers the `ifc` format (export.ts) AND the Rust-backed formats
 * (export-rust-formats.ts, split out of export.ts by this same PR) with the
 * same parametrised case, since both paths carry an equivalent guard and
 * emit the same message — see `export-rust-formats.ts`'s `exportRustFormat`.
 * `ifcx`/`usd` are intentionally excluded: those are whole-model formats that
 * never isolate, so a filter is ignored for them (covered instead by
 * `export.whole-model-filters.test.ts`). `hbjson`/`dfjson` are also
 * whole-model formats, covered there too.
 *
 * The companion controls (a real filter still narrows; no filter still
 * exports the whole model) prevent the guard from being satisfiable by
 * simply failing every export. The "no filter → whole model" case for
 * `--format ifc` is already covered by `export.ifc-no-filter.test.ts` and is
 * not duplicated here.
 *
 * These call `exportCommand` directly (as the sibling filter tests do) so
 * the assertions can see stderr and `process.exit` without a build step.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample, so this never needs `pnpm fixtures`. It has
// exactly one IfcWall among its other entities, so `--type IfcWall` both
// matches something (the control) and narrows (isn't every entity).
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');
/** A type that can never appear in a real IFC file. */
const NO_SUCH_TYPE = 'IfcNonExistentType';

class ProcessExited extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Run `exportCommand`, capturing stderr and turning `fatal()` into a throw. */
async function run(args: string[]): Promise<{ stderr: string; exited: boolean }> {
  let stderr = '';
  const writeSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExited(code);
  }) as never);
  try {
    await exportCommand(args);
    return { stderr, exited: false };
  } catch (err) {
    if (err instanceof ProcessExited) return { stderr, exited: true };
    throw err;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

const dirs: string[] = [];
function outFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ifclite-export-zero-match-'));
  dirs.push(d);
  return join(d, name);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Count STEP entity lines (`#123=...`) — one per line in the `ifc` writer's output. */
function countStepEntities(text: string): number {
  return (text.match(/^#\d+=/gm) ?? []).length;
}

// Every isolating export format: the `ifc` writer's own guard (export.ts) and
// the Rust-backed writers' shared guard (export-rust-formats.ts).
const ISOLATING_FORMATS = ['ifc', 'obj', 'gltf', 'glb', 'jsonld', 'step'] as const;

describe('export fails loudly when a filter matches 0 entities (#4047)', () => {
  it.each(ISOLATING_FORMATS)(
    '--format %s with --type matching nothing rejects instead of exporting the whole model',
    async (format) => {
      const out = outFile(`m.${format}`);
      const { stderr, exited } = await run([
        SAMPLE_IFC, '--format', format, '--type', NO_SUCH_TYPE, '--out', out,
      ]);
      // RED before #4047: an empty isolation set meant "export everything" to
      // both the `ifc` writer and the Rust wasm exporters, so `exited` was
      // false and `out` held a full-model export the user never asked for.
      expect(exited).toBe(true);
      expect(stderr).toContain('Filter matched 0 entities');
      expect(stderr).toContain('--type');
      // Confirms failure for the RIGHT reason (the filter matched nothing),
      // not a broken fixture or CLI wiring: nothing was ever written.
      expect(existsSync(out)).toBe(false);
    },
    60_000,
  );

  it.each(ISOLATING_FORMATS)(
    '--format %s with --type matching something still succeeds and narrows (control)',
    async (format) => {
      const filtered = outFile(`filtered.${format}`);
      const { exited: filteredExited } = await run([
        SAMPLE_IFC, '--format', format, '--type', 'IfcWall', '--out', filtered,
      ]);
      // The guard must not be satisfiable by simply failing every export.
      expect(filteredExited).toBe(false);
      expect(existsSync(filtered)).toBe(true);
      const filteredSize = statSync(filtered).size;
      expect(filteredSize).toBeGreaterThan(0);

      // Narrowing must actually have happened, not merely "some nonempty
      // file got written" — that alone is satisfied by silently exporting
      // the WHOLE model too (the exact escape this guard exists to close;
      // see the module doc). obj/gltf/glb/jsonld/step are binary or
      // structured formats with no shared entity-counting signal across
      // the family, so compare against an unfiltered export of the same
      // model instead: on hello-wall.ifc (1 wall among ~20 other element
      // types) a real subset export is reliably, deterministically smaller
      // than the whole-model export in every one of these formats.
      const whole = outFile(`whole.${format}`);
      const { exited: wholeExited } = await run([SAMPLE_IFC, '--format', format, '--out', whole]);
      expect(wholeExited).toBe(false);
      expect(filteredSize).toBeLessThan(statSync(whole).size);
    },
    60_000,
  );

  it('the ifc control narrows to fewer entities than the whole model, and contains an IFCWALL', async () => {
    const inputCount = countStepEntities(readFileSync(SAMPLE_IFC, 'utf-8'));
    const out = outFile('m.ifc');

    await exportCommand([SAMPLE_IFC, '--format', 'ifc', '--type', 'IfcWall', '--out', out]);

    const outputText = readFileSync(out, 'utf-8');
    const outputCount = countStepEntities(outputText);
    expect(outputCount).toBeGreaterThan(0);
    expect(outputCount).toBeLessThan(inputCount);
    expect(outputText).toMatch(/=IFCWALL\(/);
  }, 60_000);
});
