/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5209 finding 3 ("read `ids.ts`'s trap, check `rekey.ts` for the same
 * naive form, and fix it too if the same helper applies cleanly"):
 * `rekeyCommand` filtered positionals with
 * `args.filter((a) => !a.startsWith('-'))`, same shape as `ids.ts` before its
 * fix. `--lineage`/`--out`/`--key-column`/`--policy`/`--orphans` all take a
 * value, so `rekey --lineage l.json table.csv --out out.json` had the value
 * `l.json` become `positional[0]` (`tablePath`) and silently drop the real
 * table path -- `table.csv` was never read.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { rekeyCommand } from './rekey.js';

describe('rekeyCommand — value-taking flag ordering (#5209 finding 3)', () => {
  let dir: string;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  const lineage = {
    format: 'ifc-lite/lineage',
    version: 1,
    base: { hash: 'sha256:a' },
    head: { hash: 'sha256:b' },
    entries: [
      { base: ['w'], head: ['p0'], relation: 'replaced', reason: 'successor:footprint' },
    ],
    deleted: [],
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-rekey-flag-order-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => stdoutSpy.mockRestore());

  it('reads the real table when --lineage precedes the positional table path', async () => {
    const lineagePath = join(dir, 'l.json');
    const tablePath = join(dir, 'costs.csv');
    const outPath = join(dir, 'costs-v2.csv');
    await writeFile(lineagePath, JSON.stringify(lineage), 'utf-8');
    await writeFile(tablePath, 'GlobalId,Cost\nw,100\n', 'utf-8');

    // RED before the fix: `l.json` (the flag's value) was read as `tablePath`,
    // and it has no `GlobalId` column, so this used to reject with
    // `l.json has no "GlobalId" column`.
    await rekeyCommand(['--lineage', lineagePath, tablePath, '--out', outPath, '--json']);

    expect(await readFile(outPath, 'utf-8')).toBe('GlobalId,Cost,lineage_relation,lineage_from\np0,100,replaced,w\n');
  });

  it('pin: --lineage/--out after the positional table path still works (no regression)', async () => {
    const lineagePath = join(dir, 'l.json');
    const tablePath = join(dir, 'costs.csv');
    const outPath = join(dir, 'costs-v2.csv');
    await writeFile(lineagePath, JSON.stringify(lineage), 'utf-8');
    await writeFile(tablePath, 'GlobalId,Cost\nw,100\n', 'utf-8');

    await rekeyCommand([tablePath, '--lineage', lineagePath, '--out', outPath, '--json']);

    expect(await readFile(outPath, 'utf-8')).toBe('GlobalId,Cost,lineage_relation,lineage_from\np0,100,replaced,w\n');
  });
});
