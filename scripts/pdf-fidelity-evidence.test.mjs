/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_TOOL = join(ROOT, 'tools/texture-authoring/pdf-fidelity-evidence.mjs');
const ORACLE_TOOL = join(ROOT, 'tools/texture-authoring/pdf-fidelity-oracle.py');
const FIXTURE_DIR = join(ROOT, 'docs/architecture/evidence/pdf-closed-dash-annotations');

function runEvidence(control, output) {
  return spawnSync(process.execPath, [
    '--import', 'tsx',
    '--import', './apps/viewer/src/test/vite-module-hooks.mjs',
    EVIDENCE_TOOL, `control:${control}`, '1', output,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TSX_TSCONFIG_PATH: 'apps/viewer/tsconfig.json' },
  });
}

function pythonHasOracleDependencies() {
  const probe = spawnSync('python3', ['-c', 'import fitz, ifcopenshell, numpy, scipy, PIL'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return probe.status === 0;
}

test('PDF fidelity evidence binds the effective source version to closed-dash topology (#4583)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-fidelity-version-'));
  try {
    const cases = [
      { control: 'closedDashes', version: '1.7', closure: 'capped' },
      { control: 'closedDashesV2', version: '2.0', closure: 'joined' },
    ];
    for (const expected of cases) {
      const output = join(dir, `${expected.control}.json`);
      const run = runEvidence(expected.control, output);
      assert.equal(run.status, 0, run.stderr || run.stdout);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(report.pdfFormatVersion, expected.version);
      assert.deepEqual(report.preparation.dashClosures, [expected.closure, expected.closure, expected.closure]);
      assert.equal(report.fidelity.exact, true);
      assert.equal(report.fidelity.convertiblePaths, 3);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PDF 2.0 reader divergence remains explicit while native and reopened IFC agree (#4583)', {
  skip: !pythonHasOracleDependencies() && 'requires the evidence oracle Python dependencies',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-fidelity-oracle-'));
  try {
    const output = join(dir, 'closed-dashes-v2-oracle.json');
    const run = spawnSync('python3', [
      ORACLE_TOOL,
      join(FIXTURE_DIR, 'closed-dashes-v2.ifc'),
      output,
      join(FIXTURE_DIR, 'closed-dashes-v2-plan.json'),
      join(FIXTURE_DIR, 'closed-dashes-v2.pdf'),
      '--pdf2-closed-dash-reader-divergence',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.raster.native3dVersusReader2dPixels, 0);
    assert.equal(
      report.raster.expectedReaderDivergence,
      'ISO 32000-2 joins first/last on-dash pieces; MuPDF 1.26.5 caps them',
    );
    assert.ok(report.raster.comparisons.native3d.unexplained > 0);
    assert.ok(report.raster.comparisons.reader2d.unexplained > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
