/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shipped script templates are example code a user runs to learn `bim.*`,
 * so their NUMBERS have to be right. Two were not (#5539):
 *
 *  - `quantity-takeoff` listed both `IfcWall` and `IfcWallStandardCase` and
 *    queried each, but `byType` already expands to subtypes, so every standard
 *    wall was counted twice and reported as two classes. Its summary then
 *    summed every quantity whose NAME contained "volume" -- GrossVolume,
 *    NetVolume and each exporter's localised duplicates -- overstating a real
 *    model's wall volume ~3x (196 m3 against a GrossVolume of 64.75).
 *  - `space-validation` looked for `LongName` in property sets. It is an
 *    EXPRESS attribute of IfcSpace, so it was never found: every room of every
 *    model was flagged "Missing LongName" and the schedule named rooms by number.
 *
 * These RUN the shipped template in the real QuickJS sandbox against a model
 * built for the purpose, rather than reading the template text: the defects
 * were in what the scripts computed, which only a run can see.
 *
 * The model is generated with `@ifc-lite/create` so it carries exactly the
 * shapes that triggered each defect -- an IfcWallStandardCase, a wall with a
 * standard GrossVolume plus a localised duplicate, and a space whose LongName
 * is set -- and needs no `pnpm fixtures`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { IfcCreator } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { createSandbox } from '@ifc-lite/sandbox';
import { HeadlessLikeBackend } from '@ifc-lite/mcp';
import { SCRIPT_TEMPLATES } from './templates.js';

/** GrossVolume of the one wall, and a localised duplicate the old sum added in. */
const WALL_GROSS_VOLUME = 5;
// Distinct from GrossVolume, so picking the wrong quantity (7) and summing both
// (12) each fail differently from the right answer.
const WALL_LOCALISED_VOLUME = 7;
/** The wall's standard side area; its footprint GrossArea (1) must not win or be added. */
const WALL_GROSS_SIDE_AREA = 15;

function buildModel(): ArrayBuffer {
  const creator = new IfcCreator({ Name: 'Template behaviour' });
  const storey = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
  const wall = creator.addIfcWall(storey, {
    Start: [0, 0, 0], End: [5, 0, 0], Height: 3, Thickness: 0.2, Name: 'W1',
  });
  creator.addIfcElementQuantity(wall, {
    Name: 'Qto_WallBaseQuantities',
    Quantities: [
      { Name: 'GrossVolume', Value: WALL_GROSS_VOLUME, Kind: 'IfcQuantityVolume' },
      // Lower-priority siblings with distinct values: preferring or adding
      // either one shows up in the reported figure.
      { Name: 'NetVolume', Value: 4, Kind: 'IfcQuantityVolume' },
      { Name: 'GrossSideArea', Value: WALL_GROSS_SIDE_AREA, Kind: 'IfcQuantityArea' },
      { Name: 'GrossArea', Value: 1, Kind: 'IfcQuantityArea' },
    ],
  });
  // The exporter-specific duplicate every real authoring tool adds.
  creator.addIfcElementQuantity(wall, {
    Name: 'ArchiCADQuantities',
    Quantities: [{ Name: 'Brutto-Volumen der Wand', Value: WALL_LOCALISED_VOLUME, Kind: 'IfcQuantityVolume' }],
  });
  creator.addIfcSpace(storey, {
    Position: [0, 0, 0], Width: 4, Depth: 4, Height: 2.5, Name: '1', LongName: 'Kitchen',
  });

  // `IfcWallStandardCase` shares IfcWall's attribute layout in IFC4, and it is
  // the class the double count needs: it is returned by BOTH queries.
  const content = creator.toIfc().content.replace(/=IFCWALL\(/g, '=IFCWALLSTANDARDCASE(');
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}

/** Run a shipped template; return everything it logged, one string per line. */
async function runTemplate(name: string): Promise<string[]> {
  const template = SCRIPT_TEMPLATES.find((t) => t.name === name);
  assert.ok(template, `template "${name}" is not registered`);

  const store = await new IfcParser().parseColumnar(buildModel());
  const bim = createBimContext({ backend: new HeadlessLikeBackend(store, 'model.ifc', 'm1') });
  const sandbox = await createSandbox(bim, {
    permissions: { query: true, export: true, viewer: true, mutate: true, model: true },
  });
  // Transpile here rather than inside the sandbox: its esbuild-wasm path is
  // browser-only, and its regex fallback is not what users run.
  const js = ts.transpileModule(template.code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

  try {
    // Already transpiled above: skip the sandbox's own pass, whose esbuild-wasm
    // probe cannot resolve in Node and logs a spurious ERR_MODULE_NOT_FOUND.
    const result = await sandbox.eval(js, { typescript: false });
    return (result.logs ?? []).map((l) => (l.args ?? []).map(String).join(' '));
  } finally {
    sandbox.dispose();
  }
}

/** The numeric cells of the summary-table row for `className`. */
function summaryRow(lines: string[], className: string): string[] {
  const row = lines.find((l) => l.startsWith(className + ' ') && l.includes('|'));
  assert.ok(row, `no summary row for ${className}:\n${lines.join('\n')}`);
  return row.split('|').map((c) => c.trim());
}

describe('quantity-takeoff', () => {
  it('counts a standard wall once, under its concrete class', async () => {
    const lines = await runTemplate('Quantity takeoff');
    const wallRows = lines.filter((l) => /^(IfcWall|IfcWallStandardCase) /.test(l) && l.includes('|'));
    assert.deepEqual(
      wallRows.map((r) => r.split('|')[0].trim()),
      ['IfcWallStandardCase'],
      'the wall was reported under more than one class',
    );
    assert.equal(summaryRow(lines, 'IfcWallStandardCase')[1], '1');
  });

  it("reports the wall's GrossVolume, not every volume-ish quantity summed", async () => {
    const lines = await runTemplate('Quantity takeoff');
    const volume = Number(summaryRow(lines, 'IfcWallStandardCase')[3]);
    assert.equal(volume, WALL_GROSS_VOLUME);
  });

  it("reports the wall's GrossSideArea, not its footprint area or a sum", async () => {
    const lines = await runTemplate('Quantity takeoff');
    const area = Number(summaryRow(lines, 'IfcWallStandardCase')[2]);
    assert.equal(area, WALL_GROSS_SIDE_AREA);
  });
});

describe('space-validation', () => {
  it("reads IfcSpace.LongName, which is an attribute, not a property", async () => {
    const lines = await runTemplate('Space & room validation');
    assert.ok(!lines.some((l) => l.includes('Missing LongName')), 'LongName was reported missing');
    assert.ok(lines.some((l) => l.includes('Kitchen')), 'the room name never reached the schedule');
  });
});

describe('the module-boundary line users see is stripped', () => {
  // `stripModuleLine`'s regex anchored `^` without the `m` flag, and every
  // template opens with the three-line MPL header -- so it never matched, and
  // `export {} // module boundary (stripped by transpiler)` sat on line five of
  // every template the user opened.
  it('no shipped template still carries its `export {}` line', () => {
    const leaking = SCRIPT_TEMPLATES.filter((t) => /^export \{\}/m.test(t.code)).map((t) => t.name);
    assert.deepEqual(leaking, []);
  });
});
