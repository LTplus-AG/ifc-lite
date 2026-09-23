/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML→IFC4X3 output, checked by an engine this repo does not control.
 *
 * Every other test of this converter reads its output back through
 * `@ifc-lite/parser` — our own code grading our own work. That is how v1
 * shipped with two schema defects no test here could see:
 *
 * - `IfcTriangulatedIrregularNetwork` wrote `Normals` before `Closed`, so the
 *   mandatory `.F.` landed in `Normals`;
 * - `IfcMapConversion` had 8 attributes where final IFC4X3 has 10.
 *
 * Both came from `packages/codegen/schemas/IFC4X3.exp`, which is a pre-release
 * DEV draft (`IFC4X3_DEV_923b0514`), not ISO 16739-1:2024. Our parser uses the
 * same draft, so parse(write(x)) agreed with itself and was wrong. Only an
 * external schema catches that class of defect, which is why this file exists.
 *
 * Runs `tools/ifcopenshell_reference/validate_export.py` —
 * `ifcopenshell.validate(file, logger, express_rules=True)` — over a converted
 * terrain + survey + georeferenced source. Requires `ifcopenshell` (pinned in
 * `tools/ifcopenshell_reference/requirements.lock`, plus `pytest`); set
 * `IFCOPENSHELL_PYTHON` or have it on `python3`. Wired in CI by
 * `.github/workflows/export-schema-conformance.yml`. Without that environment
 * it SKIPS loudly — reported as skipped, never as passed.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { landXmlToIfc } from './landxml-to-ifc.js';
import { TRANSVERSE_MERCATOR_BOUNDS } from './coordinate-plausibility.js';
import type { LandXmlIfcSource } from './source-types.js';

const VALIDATE_SCRIPT = resolve(__dirname, '../../../../tools/ifcopenshell_reference/validate_export.py');
const PYTHON = process.env.IFCOPENSHELL_PYTHON || 'python3';

function ifcopenshellAvailable(): boolean {
  return spawnSync(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate'], { stdio: 'ignore' }).status === 0;
}

const canRun = ifcopenshellAvailable();
if (!canRun) {
  console.warn(
    `[landxml ifcopenshell-conformance] SKIPPED: ifcopenshell not importable via "${PYTHON}" — set `
    + 'IFCOPENSHELL_PYTHON or install tools/ifcopenshell_reference/requirements.lock (+ pytest).',
  );
}

/** Same cold-import cost as the export package's check: 3-4 s locally, ~7.5 s on CI. */
const IFCOPENSHELL_TEST_TIMEOUT_MS = 20_000;

/** Every entity family v1 writes: TIN, survey point + pset, georeferencing, provenance. */
const SOURCE: LandXmlIfcSource = {
  schema: 'LandXML-1.2',
  version: '1.2',
  units: {
    linearUnit: 'meter', elevationUnit: 'meter',
    linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
  },
  coordinateSystem: { horizontalDatum: 'SWEREF99 TM', verticalDatum: 'RH2000' },
  surfaces: [{
    sourceId: 'landxml:surface:1', name: 'Existing Ground', kind: 'tin', renderState: 'rendered',
    points: [
      { sourceId: 'p1', id: '1', northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
      { sourceId: 'p2', id: '2', northing: 6406990.12, easting: 157903.44, elevation: 21.03 },
      { sourceId: 'p3', id: '3', northing: 6407001.55, easting: 157888.02, elevation: 19.88 },
    ],
    faces: [['1', '2', '3']],
  }],
  plan: {
    cogoPoints: [{
      sourceId: 'landxml:cgpoint:994', name: 'Point 994', code: 'VAG_VM', description: 'Offset startpoint',
      point: { northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
    }],
  },
};

function convertToFile(): string {
  const result = landXmlToIfc(SOURCE, {
    sourceFileName: 'conformance.xml',
    timestampMs: 0,
    crs: { Name: 'SWEREF99 TM', VerticalDatum: 'RH2000', Bounds: TRANSVERSE_MERCATOR_BOUNDS },
  });
  expect(result.status, 'the conformance fixture must export').toBe('exported');
  const path = join(mkdtempSync(join(tmpdir(), 'ifc-lite-landxml-conformance-')), 'converted.ifc');
  writeFileSync(path, result.status === 'exported' ? result.content : '');
  return path;
}

describe.skipIf(!canRun)('LandXML→IFC4X3 output is schema-conformant per IfcOpenShell', () => {
  it(
    'passes ifcopenshell.validate with express_rules over TIN, survey point, georeferencing and provenance',
    () => {
      const path = convertToFile();
      let stdout = '';
      try {
        stdout = execFileSync(PYTHON, [VALIDATE_SCRIPT, path], { encoding: 'utf8' });
      } catch (error) {
        // The script's own stdout names the offending entity and rule; a bare
        // non-zero exit would not.
        const detail = (error as { stdout?: string }).stdout ?? String(error);
        expect.fail(`validate_export.py rejected the LandXML→IFC output:\n${detail}`);
      }
      expect(stdout).toContain('0 issues');
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );
});
