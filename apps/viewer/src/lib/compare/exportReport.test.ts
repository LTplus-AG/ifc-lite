/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildCompareReport, reportToCsv, reportToJson, type CompareReport } from './exportReport.js';
import type { CompareResult } from '../../store/slices/compareSlice.js';
import type { FederatedModel } from '../../store/types.js';

const report: CompareReport = {
  baseModel: 'Project01',
  headModel: 'Project01 v2',
  scope: 'both',
  generatedAt: '2026-06-18T00:00:00.000Z',
  excludedTypes: [],
  counts: {
    added: 1,
    deleted: 1,
    modified: 1,
    matched: 0,
    needsReview: 0,
    products: { added: 1, deleted: 1, modified: 1 },
    typeObjects: { added: 0, deleted: 0, modified: 0 },
  },
  rows: [
    { globalId: '12SOM77Nv5ruUGky1rkC3a', name: 'Wall', ifcType: 'IfcWall', state: 'added', change: 'Added', movedDistance: 0, model: 'Project01 v2' },
    { globalId: '0v6FMURlDDD866oJ1s6pyr', name: 'Muro, "base"', ifcType: 'IfcWall', state: 'modified', change: 'Data changed', movedDistance: 0, model: 'Project01 v2' },
    { globalId: '0533IOvVz0FgGwyun6_3V5', name: 'Wall', ifcType: 'IfcWall', state: 'modified', change: 'Moved', movedDistance: 1.2345, model: 'Project01 v2' },
  ],
};

describe('reportToCsv (#1202)', () => {
  /**
   * Element names come from the compared IFC files, so they are
   * attacker-influenced. A leading BOM is treated as file metadata by
   * spreadsheet importers, so a formula trigger hidden behind one still
   * executes -- and the apostrophe guard, applied without stripping the BOM,
   * lands in front of the BOM rather than the `=`.
   *
   * The Lists exporter (lib/lists/export/model.ts) already strips it and its
   * comment explains why; this writer and lib/search/result-export.ts did not,
   * so the same crafted name was neutralised in one CSV and live in the other
   * two.
   */
  for (const [label, invisible] of [
    ['BOM', '\uFEFF'],
    ['zero-width space', '\u200B'],
    ['left-to-right mark', '\u200E'],
    ['non-breaking space', '\u00A0'],
    // Zl / Zp -- NOT covered by `\p{Zs}`, so these two survived a guard that
    // had already widened past the BOM.
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ] as const) {
    it(`neutralises a formula trigger hidden behind a leading ${label} in a name`, () => {
      const hostile: CompareReport = {
        ...report,
        rows: [{ ...report.rows[0], name: `${invisible}=cmd|'/c calc'!A1` }],
      };
      const line = reportToCsv(hostile).split('\r\n')[1];
      assert.ok(!line.includes(invisible), 'the invisible must not survive into the cell');
      assert.ok(
        line.includes("'=cmd"),
        `expected the guard in front of the trigger, got ${JSON.stringify(line)}`,
      );
    });
  }

  it('emits a header and one row per change', () => {
    const lines = reportToCsv(report).split('\r\n');
    assert.strictEqual(lines[0], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model,Match,MatchedGlobalId');
    assert.strictEqual(lines.length, 1 + report.rows.length);
  });

  it('quotes fields containing commas and quotes (RFC 4180)', () => {
    const csv = reportToCsv(report);
    // "Muro, "base"" → wrapped + interior quotes doubled.
    assert.ok(csv.includes('"Muro, ""base"""'), 'comma/quote field must be escaped');
  });

  it('formats the moved distance and leaves it blank when zero', () => {
    const lines = reportToCsv(report).split('\r\n');
    assert.ok(lines[3].endsWith('Moved,1.2345,Project01 v2,,'));
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
    assert.strictEqual(lines[1], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model,Match,MatchedGlobalId');
    assert.strictEqual(lines.length, 2 + report.rows.length);
  });

  it('omits the comment line entirely when nothing was excluded', () => {
    const lines = reportToCsv(report).split('\r\n');
    assert.strictEqual(lines[0], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model,Match,MatchedGlobalId');
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

describe('buildCompareReport content matches (#1891)', () => {
  const ref = (modelId: string, id: number) => ({ modelId, localId: id, globalId: id });
  const fingerprint = (modelId: string, key: string, id: number, ifcType = 'IfcWall') => ({
    key,
    ifcType,
    dataHash: 'd',
    ref: ref(modelId, id),
  });

  /** A result whose key pass found nothing and whose content pass found
   *  `matches` - i.e. exactly the retired-pair case that used to vanish. */
  const resultWith = (
    matches: unknown[],
    entries: unknown[] = [],
    counts = { added: 0, modified: 0, deleted: 0, unchanged: 0 },
  ) =>
    ({
      baseModelId: 'a',
      headModelId: 'b',
      baseName: 'A',
      headName: 'B',
      scope: 'both',
      geometryUnavailable: false,
      excludedHiddenIds: new Set<number>(),
      diff: {
        scope: 'both',
        excludedTypes: [],
        entries,
        byKey: new Map(),
        counts,
        contentMatches: matches,
      },
    }) as unknown as CompareResult;

  it('emits a row for a retired 1:1 rename, with the counterpart GlobalId', () => {
    const report = buildCompareReport(
      resultWith([
        {
          kind: 'renamed',
          dataHash: 'd',
          base: [fingerprint('a', 'OLD_GUID_AAAAAAAAAAAA', 1)],
          head: [fingerprint('b', 'NEW_GUID_BBBBBBBBBBBB', 2)],
        },
      ]),
      new Map(),
    );
    assert.strictEqual(report.rows.length, 1);
    assert.deepStrictEqual(
      [report.rows[0].globalId, report.rows[0].state, report.rows[0].change, report.rows[0].match],
      ['NEW_GUID_BBBBBBBBBBBB', 'matched', 'Renamed', 'renamed'],
    );
    assert.strictEqual(report.rows[0].matchedGlobalId, 'OLD_GUID_AAAAAAAAAAAA');
    assert.strictEqual(report.rows[0].model, 'B');
  });

  it('carries a moved match distance into the row', () => {
    const report = buildCompareReport(
      resultWith([
        {
          kind: 'moved',
          dataHash: 'd',
          base: [fingerprint('a', 'OLD_GUID_AAAAAAAAAAAA', 1)],
          head: [fingerprint('b', 'NEW_GUID_BBBBBBBBBBBB', 2)],
          distance: 2.5,
        },
      ]),
      new Map(),
    );
    assert.strictEqual(report.rows[0].change, 'Moved');
    assert.strictEqual(report.rows[0].movedDistance, 2.5);
  });

  it('emits one row per head entity of an N:N rename and blanks the counterpart', () => {
    const report = buildCompareReport(
      resultWith([
        {
          kind: 'renamed',
          dataHash: 'd',
          base: [fingerprint('a', 'OLD1AAAAAAAAAAAAAAAAAA', 1), fingerprint('a', 'OLD2AAAAAAAAAAAAAAAAAA', 2)],
          head: [fingerprint('b', 'NEW1BBBBBBBBBBBBBBBBBB', 3), fingerprint('b', 'NEW2BBBBBBBBBBBBBBBBBB', 4)],
        },
      ]),
      new Map(),
    );
    assert.strictEqual(report.rows.length, 2);
    assert.deepStrictEqual(
      report.rows.map((r) => r.globalId).sort(),
      ['NEW1BBBBBBBBBBBBBBBBBB', 'NEW2BBBBBBBBBBBBBBBBBB'],
    );
    // No bijection is known, so claiming one would be a fabrication.
    assert.deepStrictEqual(report.rows.map((r) => r.matchedGlobalId), ['', '']);
  });

  it('counts retired elements and review candidates separately', () => {
    const report = buildCompareReport(
      resultWith(
        [
          {
            kind: 'reshaped',
            dataHash: 'd',
            base: [fingerprint('a', 'OLD_GUID_AAAAAAAAAAAA', 1)],
            head: [fingerprint('b', 'NEW_GUID_BBBBBBBBBBBB', 2)],
          },
          {
            kind: 'ambiguous',
            dataHash: 'e',
            base: [fingerprint('a', 'AMB1AAAAAAAAAAAAAAAAAA', 3), fingerprint('a', 'AMB2AAAAAAAAAAAAAAAAAA', 4)],
            head: [fingerprint('b', 'AMB3BBBBBBBBBBBBBBBBBB', 5), fingerprint('b', 'AMB4BBBBBBBBBBBBBBBBBB', 6)],
          },
        ],
        [],
        { added: 2, modified: 0, deleted: 2, unchanged: 0 },
      ),
      new Map(),
    );
    assert.strictEqual(report.counts.matched, 1);
    assert.strictEqual(report.counts.needsReview, 4);
  });

  it('annotates an unresolved group onto its existing add/delete rows instead of duplicating them', () => {
    const report = buildCompareReport(
      resultWith(
        [
          {
            kind: 'duplicated',
            dataHash: 'e',
            base: [fingerprint('a', 'SRC_GUID_AAAAAAAAAAAA', 3)],
            head: [fingerprint('b', 'CPY1BBBBBBBBBBBBBBBBBB', 5), fingerprint('b', 'CPY2BBBBBBBBBBBBBBBBBB', 6)],
          },
        ],
        [
          { key: 'SRC_GUID_AAAAAAAAAAAA', state: 'deleted', changeKinds: [], base: fingerprint('a', 'SRC_GUID_AAAAAAAAAAAA', 3) },
          { key: 'CPY1BBBBBBBBBBBBBBBBBB', state: 'added', changeKinds: [], head: fingerprint('b', 'CPY1BBBBBBBBBBBBBBBBBB', 5) },
          { key: 'CPY2BBBBBBBBBBBBBBBBBB', state: 'added', changeKinds: [], head: fingerprint('b', 'CPY2BBBBBBBBBBBBBBBBBB', 6) },
        ],
        { added: 2, modified: 0, deleted: 1, unchanged: 0 },
      ),
      new Map(),
    );
    // No extra rows: an unresolved group retires nothing, so its entities are
    // already reported once each.
    assert.strictEqual(report.rows.length, 3);
    assert.deepStrictEqual(report.rows.map((r) => r.match), ['duplicated', 'duplicated', 'duplicated']);
    assert.deepStrictEqual(report.rows.map((r) => r.state).sort(), ['added', 'added', 'deleted']);
  });

  it('leaves the report untouched when the content pass did not run', () => {
    const noPass = {
      baseModelId: 'a',
      headModelId: 'b',
      baseName: 'A',
      headName: 'B',
      scope: 'both',
      geometryUnavailable: false,
      excludedHiddenIds: new Set<number>(),
      diff: {
        scope: 'both',
        excludedTypes: [],
        entries: [
          { key: 'ADDED_GUID_DDDDDDDDD', state: 'added', changeKinds: [], head: fingerprint('b', 'ADDED_GUID_DDDDDDDDD', 4) },
        ],
        byKey: new Map(),
        counts: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      },
    } as unknown as CompareResult;
    const report = buildCompareReport(noPass, new Map());
    assert.strictEqual(report.rows.length, 1);
    assert.strictEqual(report.rows[0].match, undefined);
    assert.deepStrictEqual([report.counts.matched, report.counts.needsReview], [0, 0]);
  });

  it('serializes the match columns into the CSV', () => {
    const report = buildCompareReport(
      resultWith([
        {
          kind: 'renamed',
          dataHash: 'd',
          base: [fingerprint('a', 'OLD_GUID_AAAAAAAAAAAA', 1)],
          head: [fingerprint('b', 'NEW_GUID_BBBBBBBBBBBB', 2)],
        },
      ]),
      new Map(),
    );
    const lines = reportToCsv(report).split('\r\n');
    assert.strictEqual(
      lines[1],
      'NEW_GUID_BBBBBBBBBBBB,,IfcWall,Renamed,,B,renamed,OLD_GUID_AAAAAAAAAAAA',
    );
  });
});

describe('buildCompareReport - a geometry-less product that moved', () => {
  /** A site under a two-link placement chain, Representation `$`; same fixture
   *  family as describeChange.test.ts. */
  function sited(parentY: number, childY: number): string {
    return [
      "#1=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'environment - site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);",
      `#10=IFCCARTESIANPOINT((0.,${parentY.toFixed(1)},0.));`,
      `#11=IFCCARTESIANPOINT((0.,${childY.toFixed(1)},0.));`,
      '#20=IFCAXIS2PLACEMENT3D(#10,$,$);',
      '#21=IFCAXIS2PLACEMENT3D(#11,$,$);',
      '#22=IFCLOCALPLACEMENT($,#20);',
      '#23=IFCLOCALPLACEMENT(#22,#21);',
    ].join('\n');
  }

  function ifc4(body: string): string {
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      body,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
  }

  async function store(body: string) {
    const { IfcParser } = await import('@ifc-lite/parser');
    const bytes = new TextEncoder().encode(ifc4(body));
    return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  }

  it('writes Moved with the composed distance, not a phantom Reshaped', async () => {
    // The report-side twin of the describeChange fix: with no mesh on either
    // side, `classifyModified` fell through to `summarizeGeometryChange(null,
    // null)` and printed "Reshaped" for a site that was re-georeferenced — the
    // exact string the field report flagged as false, next to a MovedDistance_m
    // column sitting empty on the one row it was made for.
    const aStore = await store(sited(40, 0));
    const bStore = await store(sited(0, 0));
    const ref = (modelId: string) => ({ modelId, localId: 1, globalId: 1, meshed: false });
    const fingerprint = (modelId: string) => ({
      key: '23sFQGRy90RxVbRHD9iSE2',
      ifcType: 'IfcSite',
      dataHash: 'd',
      ref: ref(modelId),
    });
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
        excludedTypes: [],
        entries: [
          {
            key: '23sFQGRy90RxVbRHD9iSE2',
            state: 'modified',
            changeKinds: ['geometry'],
            base: fingerprint('a'),
            head: fingerprint('b'),
          },
        ],
        byKey: new Map(),
        counts: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      },
    } as unknown as CompareResult;
    const models = new Map([
      ['a', { ifcDataStore: aStore, geometryResult: null } as unknown as FederatedModel],
      ['b', { ifcDataStore: bStore, geometryResult: null } as unknown as FederatedModel],
    ]);
    const report = buildCompareReport(result, models);
    assert.strictEqual(report.rows.length, 1);
    assert.strictEqual(report.rows[0].change, 'Moved');
    assert.ok(
      Math.abs(report.rows[0].movedDistance - 40) < 1e-6,
      `expected 40 m in MovedDistance_m, got ${report.rows[0].movedDistance}`,
    );
  });
});

describe('buildCompareReport products vs type objects (headline split)', () => {
  const ref = (modelId: string, id: number) => ({ modelId, localId: id, globalId: id });
  const fingerprint = (modelId: string, key: string, id: number, ifcType: string) => ({
    key,
    ifcType,
    dataHash: 'd',
    ref: ref(modelId, id),
  });

  // Mixed result mirroring the reported confusion's shape: product changes
  // AND type-object changes in the same comparison.
  const mixedResult = {
    baseModelId: 'a',
    headModelId: 'b',
    baseName: 'A',
    headName: 'B',
    scope: 'both',
    geometryUnavailable: false,
    excludedHiddenIds: new Set<number>(),
    diff: {
      scope: 'both',
      excludedTypes: [],
      entries: [
        { key: 'k1', state: 'added', changeKinds: [], head: fingerprint('b', 'k1', 1, 'IfcWall') },
        { key: 'k2', state: 'modified', changeKinds: ['data'], base: fingerprint('a', 'k2', 2, 'IfcDoor'), head: fingerprint('b', 'k2', 2, 'IfcDoor') },
        { key: 'k3', state: 'deleted', changeKinds: [], base: fingerprint('a', 'k3', 3, 'IfcWindow') },
        {
          key: 'k4',
          state: 'modified',
          changeKinds: ['data'],
          base: fingerprint('a', 'k4', 4, 'IfcBuildingElementProxyType'),
          head: fingerprint('b', 'k4', 4, 'IfcBuildingElementProxyType'),
        },
      ],
      byKey: new Map(),
      counts: { added: 1, modified: 2, deleted: 1, unchanged: 0 },
    },
  } as unknown as CompareResult;

  it('splits counts.products from counts.typeObjects in the JSON report', () => {
    const report = buildCompareReport(mixedResult, new Map());
    assert.deepStrictEqual(report.counts.products, { added: 1, modified: 1, deleted: 1 });
    assert.deepStrictEqual(report.counts.typeObjects, { added: 0, modified: 1, deleted: 0 });
    // The combined engine-wide totals stay intact for readers of the old fields.
    assert.strictEqual(report.counts.added, 1);
    assert.strictEqual(report.counts.modified, 2);
    assert.strictEqual(report.counts.deleted, 1);
  });

  it('leads the CSV with a products/type-objects summary comment when both exist', () => {
    const report = buildCompareReport(mixedResult, new Map());
    const lines = reportToCsv(report).split('\r\n');
    assert.strictEqual(
      lines[0],
      '"# Products: 1 added, 1 modified, 1 deleted | Type objects: 0 added, 1 modified, 0 deleted"',
    );
    assert.strictEqual(lines[1], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model,Match,MatchedGlobalId');
  });

  it('the empty case: omits the summary comment line when there are no type-object changes', () => {
    // Bounding case: a comparison with only product changes must render
    // exactly as it did before this split existed - no "+0 type objects" or
    // "0 added, 0 modified, 0 deleted" noise anywhere in the CSV.
    const productOnly = {
      ...mixedResult,
      diff: {
        ...mixedResult.diff,
        entries: mixedResult.diff.entries.filter((e: { key: string }) => e.key !== 'k4'),
      },
    } as unknown as CompareResult;
    const report = buildCompareReport(productOnly, new Map());
    assert.deepStrictEqual(report.counts.typeObjects, { added: 0, modified: 0, deleted: 0 });
    const lines = reportToCsv(report).split('\r\n');
    assert.strictEqual(lines[0], 'GlobalId,Name,IfcType,Change,MovedDistance_m,Model,Match,MatchedGlobalId');
  });
});
