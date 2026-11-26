/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The crafted corpus: a valid IFC4 building plus one broken copy per rule of
 * the authoring subset. Every defect must be found, and nothing
 * ifcopenshell.validate reports on these files may be missed (its findings are
 * cached in parity/oracle-cache.json; `pnpm --filter @ifc-lite/validate parity --oracle` refreshes them).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStepText } from '../src/index.js';
import { compareFile } from '../parity/compare.js';
import { hitsTarget, keyString, ourKey, type OracleFinding } from '../parity/normalize.js';

const corpusDir = join(__dirname, '..', 'parity', 'corpus');
const manifest: Array<{ file: string; schema: string; targets: string | null }> = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8'));
const targeted = manifest.filter((m): m is { file: string; schema: string; targets: string } => m.targets !== null);
const oracle: { files: Record<string, { findings: OracleFinding[] }> } = JSON.parse(
  readFileSync(join(__dirname, '..', 'parity', 'oracle-cache.json'), 'utf8'),
);
const read = (file: string) => readFileSync(join(corpusDir, file), 'utf8');
const oracleFor = (file: string) => oracle.files[`packages/validate/parity/corpus/${file}`]?.findings;

describe('crafted parity corpus', () => {
  it.each(['base-ifc4.ifc', 'ifc4x3/base.ifc'])('accepts the base model %s', async (file) => {
    const report = await validateStepText(read(file));
    expect(report.findings).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it.each(targeted)('$file: reports $targets', async ({ file, targets }) => {
    const report = await validateStepText(read(file));
    const matches = report.findings.filter(f => hitsTarget(keyString(ourKey(f)), targets));
    expect(matches.length).toBeGreaterThan(0);
    if (file.endsWith('/shape-shared-by-two-products.ifc')) expect(matches.some(f => f.instance === 36)).toBe(true);
  });

  it('cannot satisfy an oracle enum diagnostic with a different attribute on the same instance', async () => {
    const file = 'broken/wall-enum-unknown-item.ifc';
    const report = await validateStepText(read(file));
    const misattributed = report.findings.map(f => f.rule === 'invalid-type' ? { ...f, attribute: 'IfcWall.Name' } : f);
    const result = compareFile(file, 'crafted', report.schema, misattributed, oracleFor(file)!, 0);
    expect(result.fn).toContain('invalid-type:predefinedtype|42');
    expect(result.fp).toContain('invalid-type:name|42');
  });

  it.each(manifest)('$file: misses nothing ifcopenshell.validate reports', async ({ file }) => {
    const reference = oracleFor(file);
    expect(reference, 'oracle cache entry').toBeDefined();
    const report = await validateStepText(read(file));
    expect(compareFile(file, 'crafted', report.schema, report.findings, reference ?? [], 0).fn).toEqual([]);
  });
});
