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
import { compareFile, ruleTable } from '../parity/compare.js';
import { hitsTarget, keyString, oracleKey, ourKey, type OracleFinding } from '../parity/normalize.js';

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

  it('requires a decided WR11 violation for the crafted target (#11561)', () => {
    const target = 'IfcShapeModel.WR11';
    const actual = { category: 'evaluation_error' as const, rule: target, instance: 36, message: 'Attribute not set' };
    const oracle = { type: 'entity_rule', instance: 36, attribute: target, instanceText: null, message: '\nViolated by:\n    Attribute not set\n' };
    expect(hitsTarget(keyString(ourKey(actual)), target)).toBe(false);
    expect(hitsTarget(keyString(oracleKey(oracle)), target)).toBe(false);
    expect(hitsTarget(keyString(ourKey({ ...actual, category: 'entity_rule' })), target)).toBe(true);
  });

  it('matches a UNIQUE collision in either order and keeps different pairs distinct', () => {
    const finding = { category: 'unique_rule' as const, rule: 'IfcRoot.UR1', instance: 60, message: 'GlobalId must be unique; also used by #42' };
    const reference = { type: 'schema', instance: 42, attribute: null, message: 'Rule IfcRoot.UR1:\nViolated by:\n  #60=IfcWall()' };
    expect(keyString(ourKey(finding))).toBe(keyString(oracleKey(reference)));
    expect(keyString(ourKey({ ...finding, instance: 61 }))).not.toBe(keyString(oracleKey(reference)));
  });

  it('cannot satisfy an oracle enum diagnostic with a different attribute on the same instance', async () => {
    const file = 'broken/wall-enum-unknown-item.ifc';
    const report = await validateStepText(read(file));
    const misattributed = report.findings.map(f => f.rule === 'invalid-type' ? { ...f, attribute: 'IfcWall.Name' } : f);
    const result = compareFile(file, 'crafted', report.schema, misattributed, oracleFor(file)!, 0);
    expect(result.fn).toContain('invalid-type:predefinedtype|42');
    expect(result.fp).toContain('invalid-type:name|42');
  });

  it('keeps true negatives unknown when a release omits IfcGrid.HasPlacement (#11648)', async () => {
    const paths = ['broken/grid-without-placement.ifc', 'ifc4x3/broken/grid-without-placement.ifc'];
    const files = await Promise.all(paths.map(async path => {
      const report = await validateStepText(read(path));
      return compareFile(path, 'crafted', report.schema, report.findings, oracleFor(path)!, 0);
    }));
    expect(ruleTable(files, []).find(r => r.rule === 'ifcgrid.hasplacement')).toMatchObject({ tp: 1, fp: 0, fn: 0, tnFiles: null });
  });

  it.each(manifest)('$file: misses nothing ifcopenshell.validate reports', async ({ file }) => {
    const reference = oracleFor(file);
    expect(reference, 'oracle cache entry').toBeDefined();
    const report = await validateStepText(read(file));
    expect(compareFile(file, 'crafted', report.schema, report.findings, reference ?? [], 0).fn).toEqual([]);
  });
});
