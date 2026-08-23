/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite export --format csv` versus spreadsheet formula injection (CWE-1236).
 *
 * The CLI had its own copy of the guard, one that anchored the trigger
 * characters at offset 0, while the SDK's `ExportNamespace` had the hardened
 * one that looks PAST leading
 * invisible characters (#1944). So `﻿=HYPERLINK(...)` in an entity name
 * was exported guarded by `bim.export.csv()` and unguarded by the CLI, and
 * deleting the CLI guard entirely left all 435 CLI tests green. Both now call
 * `escapeCsvCell` from `@ifc-lite/export`, the one canonical TS escaper
 * (`packages/export/src/csv-cell.ts`), reached via `export.ts:162`.
 *
 * `--columns Name` and `--columns Name,Pset_X.Y` are BOTH exercised on purpose:
 * `exportCommand` splits on `hasCustomColumns`, and the two branches used to
 * escape through different code (the SDK namespace vs. the CLI's own copy), so
 * a test of one branch says nothing about the other.
 *
 * The IFC payloads are written with the ISO-10303-21 `\X2\...\X0\` escape, so
 * the invisible prefix has to survive parsing to reach the escaper — exactly
 * the route a real malicious model would take.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample, so this never needs `pnpm fixtures`.
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

/** The sample's single IFCWALL, whose Name is `'Wall'`. */
const WALL_LINE = "#1222=IFCWALL('2JUHrTM_j3UxZiBnyBfByx',$,'Wall',$,$,#1235,#1230,$,$);";
/** The sample's single property, a boolean, which this swaps for text. */
const PROP_LINE = "#1248=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Write a copy of the sample whose wall Name and whose `Pset_WallCommon.Payload`
 * text property both carry `stepPayload`, and return its path.
 */
function modelCarrying(stepPayload: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-csv-injection-'));
  dirs.push(dir);
  let src = readFileSync(SAMPLE_IFC, 'utf8');
  expect(src).toContain(WALL_LINE);
  expect(src).toContain(PROP_LINE);
  src = src.replace(
    WALL_LINE,
    `#1222=IFCWALL('2JUHrTM_j3UxZiBnyBfByx',$,'${stepPayload}',$,$,#1235,#1230,$,$);`,
  );
  src = src.replace(
    PROP_LINE,
    `#1248=IFCPROPERTYSINGLEVALUE('Payload',$,IFCTEXT('${stepPayload}'),$);`,
  );
  const path = join(dir, 'payload.ifc');
  writeFileSync(path, src);
  return path;
}

/** Run the CSV export and return the data cells of the single wall row. */
async function csvCells(stepPayload: string, columns: string): Promise<string[]> {
  const model = modelCarrying(stepPayload);
  const out = join(dirname(model), 'out.csv');
  await exportCommand([model, '--format', 'csv', '--type', 'IfcWall', '--columns', columns, '--out', out]);
  const lines = readFileSync(out, 'utf8').split('\n');
  expect(lines.length).toBeGreaterThan(1);
  return lines[1].split(',');
}

describe('export --format csv guards a formula trigger hidden behind an invisible', () => {
  // `\X2\FEFF\X0\` is a BOM; the trigger sits behind it, so a guard that
  // anchors the trigger characters at offset 0 never matches, and the cell
  // reaches Excel as a formula.
  const HIDDEN = String.raw`\X2\FEFF\X0\=HYPERLINK("http://evil")`;

  it('on the native-column path (--columns Name)', async () => {
    const [name] = await csvCells(HIDDEN, 'Name');
    expect(name.replace(/^"/, '')).toMatch(/^'/);
  });

  it('on the custom-column path (--columns Name,Pset_WallCommon.Payload)', async () => {
    const cells = await csvCells(HIDDEN, 'Name,Pset_WallCommon.Payload');
    for (const cell of cells) {
      expect(cell.replace(/^"/, ''), `cell ${JSON.stringify(cell)}`).toMatch(/^'/);
    }
  });
});

describe('export --format csv guards a bare formula trigger', () => {
  it('on both column paths', async () => {
    const [name] = await csvCells('=HYPERLINK("http://evil")', 'Name');
    expect(name.replace(/^"/, '')).toMatch(/^'/);
    const cells = await csvCells('=HYPERLINK("http://evil")', 'Name,Pset_WallCommon.Payload');
    for (const cell of cells) {
      expect(cell.replace(/^"/, ''), `cell ${JSON.stringify(cell)}`).toMatch(/^'/);
    }
  });
});

describe('export --format csv leaves a benign name alone', () => {
  it('does not prefix an ordinary value on either column path', async () => {
    const [name] = await csvCells('Wall-001', 'Name');
    expect(name).toBe('Wall-001');
    const cells = await csvCells('Wall-001', 'Name,Pset_WallCommon.Payload');
    expect(cells[0]).toBe('Wall-001');
    expect(cells[1]).toBe('Wall-001');
  });
});
