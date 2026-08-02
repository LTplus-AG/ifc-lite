/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildCompareReport, reportToCsv, reportToJson, type CompareReport } from './exportReport.js';
import type { CompareResult } from '../../store/slices/compareSlice.js';

const report: CompareReport = {
  baseModel: 'Project01',
  headModel: 'Project01 v2',
  scope: 'both',
  generatedAt: '2026-06-18T00:00:00.000Z',
  excludedTypes: [],
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

  it('leads with an excluded-classes comment so the omission is not silent (#1470)', () => {
    const withBlacklist: CompareReport = { ...report, excludedTypes: ['IfcOpeningElement'] };
    const lines = reportToCsv(withBlacklist).split('\r\n');
    assert.strictEqual(lines[0], '# Excluded classes (not compared): IfcOpeningElement');
    assert.strictEqual(lines[1], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model');
    assert.strictEqual(lines.length, 2 + report.rows.length);
  });

  it('omits the comment line entirely when nothing was excluded', () => {
    const lines = reportToCsv(report).split('\r\n');
    assert.strictEqual(lines[0], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model');
  });
});

describe('reportToJson (#1202)', () => {
  it('round-trips to an object with rows + counts', () => {
    const parsed = JSON.parse(reportToJson(report));
    assert.strictEqual(parsed.rows.length, 3);
    assert.strictEqual(parsed.counts.added, 1);
    assert.strictEqual(parsed.baseModel, 'Project01');
  });

  it('records the excluded classes (blacklist) in the report (#1470)', () => {
    const withBlacklist: CompareReport = { ...report, excludedTypes: ['IfcOpeningElement'] };
    const parsed = JSON.parse(reportToJson(withBlacklist));
    assert.deepStrictEqual(parsed.excludedTypes, ['IfcOpeningElement']);
  });
});

describe('buildCompareReport excludedTypes casing (#1470)', () => {
  // Minimal result: no entries, so no rows/bounds needed.
  const result = {
    baseModelId: 'a',
    headModelId: 'b',
    baseName: 'A',
    headName: 'B',
    scope: 'both',
    geometryUnavailable: false,
    excludedHiddenIds: new Set<number>(),
    diff: {
      scope: 'both',
      excludedTypes: ['IFCOPENINGELEMENT'], // engine's uppercase-normalized form
      entries: [],
      byKey: new Map(),
      counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
    },
  } as unknown as CompareResult;

  it('prefers the display-cased blacklist when supplied', () => {
    const report = buildCompareReport(result, new Map(), ['IfcOpeningElement']);
    assert.deepStrictEqual(report.excludedTypes, ['IfcOpeningElement']);
  });

  it('falls back to the engine-normalized form when no display list is given', () => {
    const report = buildCompareReport(result, new Map());
    assert.deepStrictEqual(report.excludedTypes, ['IFCOPENINGELEMENT']);
  });
});

describe('buildCompareReport GlobalId under an identity map (#1891)', () => {
  // An aliased pair: the diff calls it by the BASE key, while the head entity
  // keeps its own key on `entry.head.key`. A head row must carry the GlobalId
  // that is actually in the head file, or it names an element no reader can
  // find there.
  const ref = (modelId: string, id: number) => ({ modelId, localId: id, globalId: id });
  const fingerprint = (modelId: string, key: string, id: number) => ({
    key,
    ifcType: 'IfcWall',
    dataHash: 'd',
    ref: ref(modelId, id),
  });

  const result = {
    baseModelId: 'a',
    headModelId: 'b',
    baseName: 'A',
    headName: 'B',
    scope: 'data',
    geometryUnavailable: true,
    excludedHiddenIds: new Set<number>(),
    diff: {
      scope: 'data',
      excludedTypes: [],
      entries: [
        {
          // Aliased: keyed by base, head entity holds its own re-GUID.
          key: 'OLD_GUID_AAAAAAAAAAAA',
          state: 'modified',
          changeKinds: ['data'],
          base: fingerprint('a', 'OLD_GUID_AAAAAAAAAAAA', 1),
          head: fingerprint('b', 'NEW_GUID_BBBBBBBBBBBB', 2),
        },
        {
          key: 'GONE_GUID_CCCCCCCCCC',
          state: 'deleted',
          changeKinds: [],
          base: fingerprint('a', 'GONE_GUID_CCCCCCCCCC', 3),
        },
        {
          key: 'ADDED_GUID_DDDDDDDDD',
          state: 'added',
          changeKinds: [],
          head: fingerprint('b', 'ADDED_GUID_DDDDDDDDD', 4),
        },
      ],
      byKey: new Map(),
      counts: { added: 1, modified: 1, deleted: 1, unchanged: 0 },
    },
  } as unknown as CompareResult;

  it('reports the head GlobalId for head rows and the base GlobalId for deletions', () => {
    const rows = buildCompareReport(result, new Map()).rows;
    // Each row's GlobalId must come from the same side as its model column, or
    // the row names an element that is not in the file it points at.
    const byState = new Map(rows.map((r) => [r.state, [r.globalId, r.model]]));
    assert.deepStrictEqual(byState.get('modified'), ['NEW_GUID_BBBBBBBBBBBB', 'B']);
    assert.deepStrictEqual(byState.get('deleted'), ['GONE_GUID_CCCCCCCCCC', 'A']);
    assert.deepStrictEqual(byState.get('added'), ['ADDED_GUID_DDDDDDDDD', 'B']);
  });

  it('still blanks a synthetic "missing:" key rather than exporting the placeholder', () => {
    const missing = {
      ...result,
      diff: {
        ...result.diff,
        entries: [
          {
            key: 'missing:9',
            state: 'added',
            changeKinds: [],
            head: fingerprint('b', 'missing:9', 9),
          },
        ],
      },
    } as unknown as CompareResult;
    assert.strictEqual(buildCompareReport(missing, new Map()).rows[0].globalId, '');
  });
});
