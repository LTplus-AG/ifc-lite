/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { reportToCsv, reportToJson, type CompareReport } from './exportReport.js';

const report: CompareReport = {
  baseModel: 'Project01',
  headModel: 'Project01 v2',
  scope: 'both',
  generatedAt: '2026-06-18T00:00:00.000Z',
  counts: { added: 1, deleted: 1, modified: 1 },
  rows: [
    { globalId: '12SOM77Nv5ruUGky1rkC3a', name: 'Wall', ifcType: 'IfcWall', state: 'added', change: 'Added', movedDistance: 0, model: 'Project01 v2' },
    { globalId: '0v6FMURlDDD866oJ1s6pyr', name: 'Muro, "base"', ifcType: 'IfcWall', state: 'modified', change: 'Data changed', movedDistance: 0, model: 'Project01 v2' },
    { globalId: '0533IOvVz0FgGwyun6_3V5', name: 'Wall', ifcType: 'IfcWall', state: 'modified', change: 'Moved', movedDistance: 1.2345, model: 'Project01 v2' },
  ],
};

describe('reportToCsv (#1202)', () => {
  it('emits a header and one row per change', () => {
    const lines = reportToCsv(report).split('\r\n');
    assert.strictEqual(lines[0], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model');
    assert.strictEqual(lines.length, 1 + report.rows.length);
  });

  it('quotes fields containing commas and quotes (RFC 4180)', () => {
    const csv = reportToCsv(report);
    // "Muro, "base"" → wrapped + interior quotes doubled.
    assert.ok(csv.includes('"Muro, ""base"""'), 'comma/quote field must be escaped');
  });

  it('formats the moved distance and leaves it blank when zero', () => {
    const lines = reportToCsv(report).split('\r\n');
    assert.ok(lines[3].endsWith('Moved,1.2345,Project01 v2'));
    assert.ok(lines[1].includes(',Added,,'), 'zero move distance is blank');
  });

  it('neutralises spreadsheet formula injection in names', () => {
    const danger: CompareReport = {
      ...report,
      rows: [{ globalId: 'g1', name: '=HYPERLINK("http://x")', ifcType: 'IfcWall', state: 'added', change: 'Added', movedDistance: 0, model: 'm' }],
    };
    const csv = reportToCsv(danger);
    // The cell must be wrapped (it contains a quote) and start with a leading
    // apostrophe so Excel/Sheets treat it as text, not a formula.
    assert.ok(csv.includes('"\'=HYPERLINK('), `formula not neutralised: ${csv}`);
  });
});

describe('reportToJson (#1202)', () => {
  it('round-trips to an object with rows + counts', () => {
    const parsed = JSON.parse(reportToJson(report));
    assert.strictEqual(parsed.rows.length, 3);
    assert.strictEqual(parsed.counts.added, 1);
    assert.strictEqual(parsed.baseModel, 'Project01');
  });
});
