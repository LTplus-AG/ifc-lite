/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcCreator`'s IFC4X3 output is schema-conformant per IfcOpenShell (#5351).
 *
 * `IfcCreator` writes IFC4X3_ADD2 (ISO 16739-1:2024) attribute layouts and
 * declares them as `FILE_SCHEMA(('IFC4X3_ADD2'))`. IfcOpenShell resolves the
 * bare `IFC4X3` token to a later development schema whose layouts differ
 * (`IfcTriangulatedIrregularNetwork` puts `Closed` before `Normals`,
 * `IfcMapConversion` has 10 attributes, not 8), so the same bytes under the
 * bare token fail. The model below carries exactly those two entities, plus
 * the project preamble and a slab, and this test checks both halves: the file
 * as written validates with 0 issues, and the identical file relabelled
 * `IFC4X3` does not. The second half is what shows the identifier is the difference,
 * so the first half cannot pass for an unrelated reason.
 *
 * Runs `tools/ifcopenshell_reference/validate_export.py`
 * (`ifcopenshell.validate`, `express_rules=True`). Needs a Python with
 * `ifcopenshell` (see `tools/ifcopenshell_reference/requirements.lock`, plus
 * `pytest`); set `IFCOPENSHELL_PYTHON` or have it on `python3`. Wired in CI by
 * `.github/workflows/export-schema-conformance.yml`. Without that environment
 * it SKIPS loudly rather than passing vacuously.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IfcCreator } from './ifc-creator.js';

const VALIDATE_SCRIPT = resolve(__dirname, '../../../tools/ifcopenshell_reference/validate_export.py');
const PYTHON = process.env.IFCOPENSHELL_PYTHON || 'python3';

const canRun =
  spawnSync(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate'], { stdio: 'ignore' }).status === 0;
if (!canRun) {
  console.warn(
    `[ifcopenshell-ifc4x3-conformance] SKIPPED: ifcopenshell not importable via "${PYTHON}" — ` +
      'set IFCOPENSHELL_PYTHON or install tools/ifcopenshell_reference/requirements.lock (+ pytest).',
  );
}

// A cold Python import of ifcopenshell.validate plus express_rules=True is
// several seconds on shared runners (see the export package's twin test).
const TIMEOUT_MS = 60_000;

function ifc4x3Model(): string {
  const creator = new IfcCreator({ Name: 'IFC4X3 conformance', Schema: 'IFC4X3', Timestamp: 0 });
  const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
  // No `addIfcWall`: its placement violates AxisAndRefDirProvision in every
  // schema (#5469), which is not what this file checks.
  creator.addIfcSlab(storey, { Position: [0, 0, 0], Width: 5, Depth: 4, Thickness: 0.25 });
  const terrain = creator.terrain();
  terrain.addSurface({
    Name: 'Existing Ground',
    Coordinates: [[0, 0, 10], [10, 0, 11], [10, 10, 12], [0, 10, 10.5]],
    Triangles: [[1, 2, 3], [1, 3, 4]],
  });
  terrain.setGeoreferencing({ Name: 'EPSG:2056', Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 });
  return creator.toIfc().content;
}

function validate(content: string, name: string): { status: number | null; stdout: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'ifc-lite-create-ifc4x3-')), name);
  writeFileSync(path, content);
  const run = spawnSync(PYTHON, [VALIDATE_SCRIPT, path], { encoding: 'utf8' });
  return { status: run.status, stdout: `${run.stdout}\n${run.stderr}` };
}

describe.skipIf(!canRun)('IfcCreator IFC4X3 output is schema-conformant per IfcOpenShell (#5351)', () => {
  it('declares IFC4X3_ADD2 and validates with 0 issues', () => {
    const content = ifc4x3Model();
    expect(content).toContain("FILE_SCHEMA(('IFC4X3_ADD2'));");
    expect(content).toContain('IFCTRIANGULATEDIRREGULARNETWORK(');
    expect(content).toContain('IFCMAPCONVERSION(');
    const run = validate(content, 'ifc4x3-add2.ifc');
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).toContain('0 issues');
  }, TIMEOUT_MS);

  it('control: the same bytes declared as bare IFC4X3 fail, so the identifier is what makes the difference', () => {
    const bare = ifc4x3Model().replace("FILE_SCHEMA(('IFC4X3_ADD2'));", "FILE_SCHEMA(('IFC4X3'));");
    expect(bare).toContain("FILE_SCHEMA(('IFC4X3'));");
    const run = validate(bare, 'ifc4x3-bare.ifc');
    expect(run.status, run.stdout).not.toBe(0);
  }, TIMEOUT_MS);
});
