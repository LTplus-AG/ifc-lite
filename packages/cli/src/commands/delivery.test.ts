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
const idsCorpus = resolve(here, '../../../ids/src/__corpus__/buildingsmart-ids/ids');
const PROHIBITED_PASS_IFC = resolve(idsCorpus, 'pass-prohibited_specifications_passes_if_the_applicability_does_not_matches.ifc');
const PROHIBITED_PASS_IDS = resolve(idsCorpus, 'pass-prohibited_specifications_passes_if_the_applicability_does_not_matches.ids');

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

// A spec whose applicability matches ZERO entities in CLEAN_IFC (which
// declares no IfcFurnishingElement at all) with minOccurs="0" — the spec is
// declared optional, so nothing being present is not a violation, but
// nothing was ever evaluated either. Regression for the adversarial review
// on #3934: this used to report `pass` by falling through the raw
// validator's passed/failed cardinality bucketing, never reaching `error`.
const VACUOUS_IDS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">',
  '  <specifications>',
  '    <specification name="Furnishing elements must have a Tag" ifcVersion="IFC4">',
  '      <applicability minOccurs="0" maxOccurs="unbounded">',
  '        <entity><name><simpleValue>IFCFURNISHINGELEMENT</simpleValue></name></entity>',
  '      </applicability>',
  '      <requirements>',
  '        <attribute><name><simpleValue>Tag</simpleValue></name></attribute>',
  '      </requirements>',
  '    </specification>',
  '  </specifications>',
  '</ids>',
  '',
].join('\n');

// Same applicability, but at the DEFAULT (required, minOccurs=1) cardinality:
// matching zero entities is a genuine cardinality failure, not a vacuous
// check, so this must report `fail` (not `error`, not `pass`).
const REQUIRED_BUT_ABSENT_IDS = VACUOUS_IDS.replace('minOccurs="0"', '');

// An IDS document declaring zero <specification> elements at all.
const ZERO_SPEC_IDS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">',
  '  <specifications>',
  '  </specifications>',
  '</ids>',
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

  it('an IDS spec whose applicability matches nothing (minOccurs="0") reports error, never pass (#3934)', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    writeFileSync(join(dir, 'vacuous.ids'), VACUOUS_IDS);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], ids: ['vacuous.ids'] });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { verdict: string; checks: Array<{ status: string; type: string }> };
    expect(report.checks[0].type).toBe('ids');
    expect(report.checks[0].status).toBe('error'); // nothing was ever evaluated
    expect(report.verdict).toBe('fail');
    process.exitCode = 0;
  });

  it('the same applicability at default (required) cardinality reports fail, not error or pass (#3934)', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    writeFileSync(join(dir, 'required.ids'), REQUIRED_BUT_ABSENT_IDS);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], ids: ['required.ids'] });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { verdict: string; checks: Array<{ status: string }> };
    expect(report.checks[0].status).toBe('fail'); // a required spec matching zero entities is a real failure
    process.exitCode = 0;
  });

  it('a maxOccurs="0" prohibition satisfied by zero matches still reports pass, not error (#3934)', async () => {
    // Distinct from VACUOUS_IDS above: a `maxOccurs="0"` bound COULD have
    // been violated by a nonzero applicable count, so finding zero is real
    // evidence, not a vacuous result. Real buildingSMART corpus fixture.
    const recipePath = writeRecipe(tmpDir(), { models: [PROHIBITED_PASS_IFC], ids: [PROHIBITED_PASS_IDS] });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { verdict: string; checks: Array<{ status: string }> };
    expect(report.checks[0].status).toBe('pass');
    expect(report.verdict).toBe('pass');
    process.exitCode = 0;
  });

  it('an IDS document declaring zero specifications still reports error', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    writeFileSync(join(dir, 'empty.ids'), ZERO_SPEC_IDS);
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], ids: ['empty.ids'] });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as { checks: Array<{ status: string }> };
    expect(report.checks[0].status).toBe('error');
    process.exitCode = 0;
  });

  it('entity-level evidence (totalEntities/passedEntities/failedEntities) actually renders for a real failing IDS check (#3934)', async () => {
    const dir = tmpDir();
    const recipePath = writeRecipe(dir, { models: [FAIL_IFC], ids: [FAIL_IDS] });
    const write = silenceOutput();
    await deliveryCommand([recipePath, '--json']);
    const report = jsonWritten(write) as {
      checks: Array<{ status: string; totalEntities?: number; passedEntities?: number; failedEntities?: number }>;
    };
    const check = report.checks[0];
    expect(check.status).toBe('fail');
    // These fields must actually be present with the validator's real field
    // names, not silently undefined behind a hand-built interface that
    // never matched the runtime shape.
    expect(check.totalEntities).toBeGreaterThan(0);
    expect(check.failedEntities).toBeGreaterThan(0);
    expect(check.totalEntities).toBe((check.passedEntities ?? 0) + (check.failedEntities ?? 0));
    process.exitCode = 0;
  });

  it('the failing check\'s HTML report actually renders the "X/Y entities failed" line (#3934)', async () => {
    const dir = tmpDir();
    const recipePath = writeRecipe(dir, { models: [FAIL_IFC], ids: [FAIL_IDS] });
    const htmlPath = join(dir, 'report.html');
    silenceOutput();
    await deliveryCommand([recipePath, '--json', '--html', htmlPath]);
    const html = await readFile(htmlPath, 'utf-8');
    expect(html).toMatch(/\d+\/\d+ entities failed/);
    process.exitCode = 0;
  });

  it('a model path containing a literal <script> tag is HTML-escaped, not injected', async () => {
    const dir = tmpDir();
    // A literal "/" would be a real path separator on disk, so this uses an
    // HTML-injection payload that stays within a single filename component.
    const modelName = '<img src=x onerror=alert(1)>.ifc';
    writeFileSync(join(dir, modelName), CLEAN_IFC);
    const recipePath = writeRecipe(dir, { models: [modelName], structural: true });
    const htmlPath = join(dir, 'report.html');
    silenceOutput();
    await deliveryCommand([recipePath, '--json', '--html', htmlPath]);
    const html = await readFile(htmlPath, 'utf-8');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    process.exitCode = 0;
  });

  it('an IDS parse-error message containing model/IDS-derived markup is escaped in the HTML evidence column', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'model.ifc'), CLEAN_IFC);
    // Not well-formed XML, so `ids.parse` throws with a message that may
    // echo back a fragment of the offending content -- that message ends
    // up as `check.error`, rendered into the HTML "Evidence" column.
    writeFileSync(join(dir, 'bad.ids'), '<ids><specification name="<script>alert(1)</script>"></ids>');
    const recipePath = writeRecipe(dir, { models: ['model.ifc'], ids: ['bad.ids'] });
    const htmlPath = join(dir, 'report.html');
    silenceOutput();
    await deliveryCommand([recipePath, '--json', '--html', htmlPath]);
    const html = await readFile(htmlPath, 'utf-8');
    expect(html).not.toMatch(/<script>alert\(1\)/);
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
