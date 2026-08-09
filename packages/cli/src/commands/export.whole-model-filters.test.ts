/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity-isolation filters (`--type` / `--where` / `--storey` / `--limit`) versus
 * the WHOLE-MODEL export formats.
 *
 * IFCX, USD, HBJSON and DFJSON all re-read the entire model from bytes and never
 * receive the isolated entity set, so a filter can only ever be ignored for them.
 * Two things must hold, and the energy formats used to get both wrong:
 *
 *  1. The export must still run. `--storey` used to be resolved before the switch
 *     for HBJSON/DFJSON, so a storey name that matched nothing called `fatal()` and
 *     aborted an export the filter had no bearing on.
 *  2. The user must be told. A `--type`/`--where`/`--limit` that the format cannot
 *     honour was accepted in complete silence, so the output looked like a filtered
 *     export and was the whole model.
 *
 * These call `exportCommand` directly rather than spawning the CLI so the assertions
 * can see stderr and `process.exit` without a build step. `fatal()` exits the
 * process, which would take the test runner with it, so `process.exit` is stubbed to
 * throw — that turns "aborted" into a catchable outcome instead of a dead worker.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample, so this never needs `pnpm fixtures`.
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');
/** A storey name that is deliberately not in the sample. */
const NO_SUCH_STOREY = '__no_such_storey__';

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
  const d = mkdtempSync(join(tmpdir(), 'ifclite-export-filters-'));
  dirs.push(d);
  return join(d, name);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('whole-model formats ignore entity filters instead of aborting', () => {
  it('DFJSON still exports when --storey matches nothing', async () => {
    const out = outFile('m.dfjson');
    const { exited } = await run([
      SAMPLE_IFC, '--format', 'dfjson', '--storey', NO_SUCH_STOREY, '--out', out,
    ]);
    // RED before the fix: --storey was resolved for dfjson, found no match, and
    // called fatal() — so `exited` was true and no file was written.
    expect(exited).toBe(false);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf-8')).type).toBe('Model');
  }, 60_000);

  it('HBJSON still exports when --storey matches nothing', async () => {
    const out = outFile('m.hbjson');
    const { exited } = await run([
      SAMPLE_IFC, '--format', 'hbjson', '--storey', NO_SUCH_STOREY, '--out', out,
    ]);
    expect(exited).toBe(false);
    expect(existsSync(out)).toBe(true);
  }, 60_000);

  it('reports the ignored filter on stderr rather than accepting it silently', async () => {
    const { stderr, exited } = await run([
      SAMPLE_IFC, '--format', 'dfjson', '--type', 'IfcWall', '--out', outFile('m.dfjson'),
    ]);
    expect(exited).toBe(false);
    expect(stderr).toContain('do not apply to DFJSON');
  }, 60_000);

  it('says nothing when no filter was requested', async () => {
    const { stderr } = await run([SAMPLE_IFC, '--format', 'dfjson', '--out', outFile('m.dfjson')]);
    expect(stderr).not.toContain('do not apply to');
  }, 60_000);

  /**
   * Bounding control. Without this, deleting the `!wholeModelFormat` guards
   * entirely — making EVERY format ignore its filters — would leave the three
   * cases above green while silently breaking `--storey` for CSV.
   */
  it('an ISOLATING format still fails loudly on a storey that matches nothing', async () => {
    const { exited } = await run([
      SAMPLE_IFC, '--format', 'csv', '--storey', NO_SUCH_STOREY, '--out', outFile('m.csv'),
    ]);
    expect(exited).toBe(true);
  }, 60_000);
});
