/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite delivery` — runs a saved recipe's structural + IDS checks and
 * distinguishes pass/fail/error. Regression suite for issue #3931.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deliveryCommand } from './delivery.js';
import { loadDeliveryRecipe } from './delivery-recipe.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, '../../../ids/src/__corpus__/buildingsmart-ids/classification');
const PASS_IFC = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ifc');
const PASS_IDS = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ids');
const FAIL_IFC = resolve(corpus, 'fail-systems_should_match_exactly_2_5.ifc');
const FAIL_IDS = resolve(corpus, 'fail-systems_should_match_exactly_2_5.ids');

function silenceOutput() {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return write;
}

function jsonWritten(write: ReturnType<typeof silenceOutput>): unknown {
  const calls = write.mock.calls.map(c => String(c[0]));
  return JSON.parse(calls.join(''));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ifc-lite-delivery-'));
}

function writeRecipe(dir: string, recipe: unknown, name = 'recipe.json'): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(recipe));
  return path;
}

const CLEAN_IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,$,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,$,$,$,$);",
  "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

// A model missing IfcSite/IfcBuilding (the "required-entity" structural rule) -> structural fail.
const BROKEN_IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

describe('loadDeliveryRecipe', () => {
  it('fatals on a recipe that declares neither structural nor ids checks', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'] });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('__fatal__'); }) as unknown as (code?: string | number | null) => never);
    silenceOutput();
    await expect(loadDeliveryRecipe(recipePath)).rejects.toThrow('__fatal__');
    exitSpy.mockRestore();
  });

  it('fatals on an unrecognised field', async () => {
    const dir = tmpDir();
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], structural: true, groupBy: 'oops' });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('__fatal__'); }) as unknown as (code?: string | number | null) => never);
    silenceOutput();
    await expect(loadDeliveryRecipe(recipePath)).rejects.toThrow('__fatal__');
  });

  it('resolves models/ids paths relative to the recipe file, not the cwd', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], structural: true });
    const recipe = await loadDeliveryRecipe(recipePath);
    expect(recipe.resolvedModels[0]).toBe(join(dir, 'model.ifc'));
  });

  it('fatals on a duplicate model path', async () => {
    const dir = tmpDir();
    const recipePath = writeRecipe(dir, { models: ['a.ifc', 'a.ifc'], structural: true });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('__fatal__'); }) as unknown as (code?: string | number | null) => never);
    silenceOutput();
    await expect(loadDeliveryRecipe(recipePath)).rejects.toThrow('__fatal__');
  });
});

describe('deliveryCommand', () => {
  it('reports a clean model as an overall PASS verdict', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], structural: true });
    const write = silenceOutput();
    process.exitCode = 0;
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { verdict: string; checks: Array<{ status: string }> };
    expect(report.verdict).toBe('pass');
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0].status).toBe('pass');
    expect(process.exitCode).toBe(0);
    process.exitCode = 0;
  });

  it('reports a structurally broken model as FAIL, not error', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), BROKEN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], structural: true });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { verdict: string; checks: Array<{ status: string; errorCount: number }> };
    expect(report.verdict).toBe('fail');
    expect(report.checks[0].status).toBe('fail');
    expect(report.checks[0].errorCount).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('reports an unreadable model as ERROR (not pass, not silently dropped)', async () => {
    const dir = tmpDir();
    // model.ifc is declared but never written to disk.
    const recipePath = writeRecipe(dir, { models: ['missing.ifc'], structural: true });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as {
      verdict: string;
      models: Array<{ loadError?: string }>;
      checks: Array<{ status: string }>;
    };
    expect(report.verdict).toBe('fail');
    expect(report.models[0].loadError).toBeTruthy();
    expect(report.checks).toHaveLength(1); // NOT dropped/omitted
    expect(report.checks[0].status).toBe('error');
    process.exitCode = 0;
  });

  it('an unreadable IDS file reports error, not a silent pass', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], ids: ['missing.ids'] });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { verdict: string; checks: Array<{ status: string; type: string }> };
    expect(report.verdict).toBe('fail');
    expect(report.checks[0].type).toBe('ids');
    expect(report.checks[0].status).toBe('error');
    process.exitCode = 0;
  });

  it('running the same recipe twice produces byte-identical JSON output', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], structural: true });

    const write1 = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const out1 = write1.mock.calls.map(c => String(c[0])).join('');
    vi.restoreAllMocks();

    const write2 = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const out2 = write2.mock.calls.map(c => String(c[0])).join('');

    expect(out1).toBe(out2);
    process.exitCode = 0;
  });

  it('a targeted property change (removing IfcBuildingStorey) changes only the affected report entries', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], structural: true });

    const write1 = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const before = jsonWritten(write1) as { checks: Array<{ warningCount: number; issues: Array<{ rule: string }> }> };
    vi.restoreAllMocks();

    // Remove the storey line -> the "has-storeys" warning appears; nothing
    // else about the report shape should move.
    const noStoreyIfc = CLEAN_IFC.split('\n').filter(l => !l.includes('IFCBUILDINGSTOREY')).join('\n');
    writeFileSync(join(dir, 'model.ifc'), noStoreyIfc);
    const write2 = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const after = jsonWritten(write2) as { checks: Array<{ warningCount: number; issues: Array<{ rule: string }> }> };

    expect(before.checks[0].warningCount).toBe(0);
    expect(after.checks[0].warningCount).toBe(1);
    expect(after.checks[0].issues.some(i => i.rule === 'has-storeys')).toBe(true);
    process.exitCode = 0;
  });

  it('two models sharing the "model" report field never collide: each keeps its own entry', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'a.ifc'), CLEAN_IFC);
    writeFileSync(join(dir, 'b.ifc'), BROKEN_IFC);
    const recipePath = writeRecipe(dir, { models: ['a.ifc', 'b.ifc'], structural: true });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { checks: Array<{ model: string; status: string }> };
    expect(report.checks).toHaveLength(2);
    expect(report.checks.find(c => c.model === 'a.ifc')?.status).toBe('pass');
    expect(report.checks.find(c => c.model === 'b.ifc')?.status).toBe('fail');
    process.exitCode = 0;
  });

  it('IDS end-to-end: a passing IDS corpus fixture reports pass; a failing one reports fail', async () => {
    const dir = tmpDir();
    const passRecipe = writeRecipe(dir, { models: [PASS_IFC], ids: [PASS_IDS] }, 'pass.json');
    const failRecipe = writeRecipe(dir, { models: [FAIL_IFC], ids: [FAIL_IDS] }, 'fail.json');

    const w1 = silenceOutput();
    await deliveryCommand([passRecipe, '--json']);
    const passReport = jsonWritten(w1) as { verdict: string };
    expect(passReport.verdict).toBe('pass');
    vi.restoreAllMocks();
    process.exitCode = 0;

    const w2 = silenceOutput();
    await deliveryCommand([failRecipe, '--json']);
    const failReport = jsonWritten(w2) as { verdict: string; checks: Array<{ status: string }> };
    expect(failReport.verdict).toBe('fail');
    expect(failReport.checks[0].status).toBe('fail');
    process.exitCode = 0;
  });

  it('--html writes a standalone HTML report alongside the JSON', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], structural: true });
    const htmlPath = join(dir, 'report.html');
    silenceOutput();
    await deliveryCommand([recipePath, '--json', '--html', htmlPath]);
    const html = await readFile(htmlPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Verdict: PASS');
    process.exitCode = 0;
  });
});
