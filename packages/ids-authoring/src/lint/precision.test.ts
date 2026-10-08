/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-054: lint precision on the buildingSMART pass-/fail- corpus and the
 * internal lint corpus is at least 95 %, every finding is labelled, and the
 * internal corpus's seeded defects are all found (recall on known defects).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIDS } from '@ifc-lite/ids';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadPrecisionCases } from '../../scripts/precision-cases.mjs';
import { createLintContext } from './context.js';
import { measurePrecision, type PrecisionLabels, type PrecisionReport } from './precision.js';

const PKG = fileURLToPath(new URL('../../', import.meta.url));
const FIX = 'label the finding in test/lint-corpus/labels.json (node packages/ids-authoring/scripts/lint-precision.mjs --unlabelled), or fix the rule';

let report: PrecisionReport;
beforeAll(async () => {
  const labels = JSON.parse(readFileSync(join(PKG, 'test/lint-corpus/labels.json'), 'utf8')) as PrecisionLabels;
  const cases = loadPrecisionCases(PKG, { parseIDS, readdirSync, readFileSync, join });
  report = measurePrecision(cases, labels, await createLintContext());
});

/** Seeded defects of the internal corpus: every one must be found. */
const SEEDED: Record<string, string[]> = {
  'internal/fire-safety-draft.ids': ['IDSL-ENT-001', 'IDSL-PSET-001', 'IDSL-VAL-003', 'IDSL-VAL-005', 'IDSL-REGEX-001', 'IDSL-UNIT-001', 'IDSL-DOC-001'],
  'internal/handover-structure.ids': ['IDSL-PART-001', 'IDSL-VAL-004', 'IDSL-SPEC-001', 'IDSL-CARD-003', 'IDSL-SPEC-009'],
};

describe('lint precision', () => {
  it('covers the whole corpus', () => {
    expect(report.files).toBeGreaterThanOrEqual(300);
  });

  it('labels every finding and keeps no stale labels', () => {
    expect(report.unlabelled, FIX).toEqual([]);
    expect(report.unusedLabels, 'remove stale labels from test/lint-corpus/labels.json').toEqual([]);
  });

  it('reaches at least 95 % precision overall and on warnings and errors', () => {
    expect(report.precision).toBeGreaterThanOrEqual(0.95);
    expect(report.precisionWarnError).toBeGreaterThanOrEqual(0.95);
  });

  it('finds every seeded defect of the internal corpus', () => {
    const labels = JSON.parse(readFileSync(join(PKG, 'test/lint-corpus/labels.json'), 'utf8')) as PrecisionLabels;
    for (const [file, codes] of Object.entries(SEEDED)) {
      const found = new Set(Object.keys(labels.findings).filter((k) => k.startsWith(`${file}|`)).map((k) => k.split('|')[1]));
      for (const code of codes) expect(found.has(code), `${file} ${code}`).toBe(true);
    }
  });

  it('raises nothing above info on the clean reference', () => {
    expect(Object.keys(JSON.parse(readFileSync(join(PKG, 'test/lint-corpus/labels.json'), 'utf8')).findings).filter((k) => k.startsWith('internal/clean-reference.ids|'))).toEqual([]);
  });
});
