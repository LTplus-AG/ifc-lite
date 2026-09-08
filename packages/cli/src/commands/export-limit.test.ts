/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--limit` used to reach `Array.prototype.slice(0, parseInt(limit, 10))`
 * unvalidated. A non-numeric or negative value (a typo, or a value forwarded
 * from a script) parses to `NaN`, and `slice(0, NaN)` silently returns an
 * empty array — the export "succeeds" (exit 0) with zero rows, even though
 * matching entities exist. Reproduced live against the committed
 * `hello-wall.ifc` sample before this test was added; `validateLimit()` in
 * `output.ts` now rejects it loudly instead.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

describe('export --limit validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a non-numeric --limit instead of silently exporting zero rows (CSV)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      exportCommand([SAMPLE_IFC, '--format', 'csv', '--type', 'IfcWall', '--limit', 'abc']),
    ).rejects.toThrow();
  });

  it('rejects a negative --limit', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      exportCommand([SAMPLE_IFC, '--format', 'csv', '--type', 'IfcWall', '--limit', '-1']),
    ).rejects.toThrow();
  });

  it('rejects a fractional --limit', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      exportCommand([SAMPLE_IFC, '--format', 'csv', '--type', 'IfcWall', '--limit', '1.5']),
    ).rejects.toThrow();
  });

  it('still exports the matched rows for a valid --limit', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write);

    await exportCommand([SAMPLE_IFC, '--format', 'csv', '--type', 'IfcWall', '--limit', '1']);

    const dataLines = out.trim().split('\n').slice(1); // drop header
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain('IfcWall');
  });

  it('--limit 0 is a deliberate empty result, not an error', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write);

    await exportCommand([SAMPLE_IFC, '--format', 'csv', '--type', 'IfcWall', '--limit', '0']);

    expect(out.trim().split('\n')).toHaveLength(1); // header only, no data rows, no throw
  });
});
