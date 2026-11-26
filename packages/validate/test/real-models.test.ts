/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Third-party models through @ifc-lite/parser's data store: agreement with the
 * cached ifcopenshell.validate findings, and the time budget for a 2.5 MB model.
 * Skips when the fixture is absent: run `pnpm fixtures`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IfcParser } from '@ifc-lite/parser';
import { describe, expect, it } from 'vitest';
import { validateDataStore } from '../src/index.js';
import { compareFile } from '../parity/compare.js';
import type { OracleFinding } from '../parity/normalize.js';

const repoRoot = join(__dirname, '..', '..', '..');
const FZK = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const oracle: { files: Record<string, { findings: OracleFinding[] }> } = JSON.parse(
  readFileSync(join(__dirname, '..', 'parity', 'oracle-cache.json'), 'utf8'),
);

async function parse(path: string) {
  const bytes = readFileSync(join(repoRoot, path));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe.skipIf(!existsSync(join(repoRoot, FZK)))(`${FZK} (pnpm fixtures)`, () => {
  it('agrees with ifcopenshell.validate finding for finding', async () => {
    const report = await validateDataStore(await parse(FZK));
    const cmp = compareFile(FZK, 'real', report.schema, report.findings, oracle.files[FZK].findings, 0);
    expect({ fn: cmp.fn, fp: cmp.fp }).toEqual({ fn: [], fp: [] });
    expect(cmp.tp.length).toBeGreaterThan(100);
  }, 60_000);

  it('validates the 2.5 MB model in under a second', async () => {
    const store = await parse(FZK);
    const started = performance.now();
    await validateDataStore(store);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 60_000);
});
