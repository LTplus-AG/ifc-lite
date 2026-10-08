/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCostBackend } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import { computeDeviationStatistics } from '@ifc-lite/renderer';
import { buildCostCsvReport, buildDeviationCsvReport } from './export-csv.js';

interface StepRef { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }

/** Source-backed cost data, so the export sees the real evaluator's amounts. */
function costStore(globalId: string, name: string, amount: number): IfcDataStore {
  const lines = [
    "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
    '#2=IFCUNITASSIGNMENT((#5));',
    "#5=IFCMONETARYUNIT('GBP');",
    `#30=IFCCOSTVALUE('Price',$,IFCMONETARYMEASURE(${amount}.),$,$,$,$,$,$,$);`,
    `#40=IFCCOSTITEM('${globalId}',$,'${name}',$,$,$,.USERDEFINED.,(#30),$);`,
  ];
  const source = new TextEncoder().encode(lines.join('\n'));
  const byId = new Map<number, StepRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  for (const line of lines) {
    const match = /^#(\d+)=(\w+)\(/.exec(line);
    if (match) {
      const expressId = Number(match[1]);
      const type = match[2];
      byId.set(expressId, { expressId, type, byteOffset: offset, byteLength: line.length, lineNumber: 1 });
      byType.set(type, [...(byType.get(type) ?? []), expressId]);
    }
    offset += line.length + 1;
  }
  const entities = { getGlobalId: () => '', getName: (id: number) => `entity${id}` };
  return { source, schemaVersion: 'IFC4', entityIndex: { byId, byType }, entities } as unknown as IfcDataStore;
}

describe('analysis CSV exports (#5832)', () => {
  it('exports real evaluated cost items with EXPRESS names and no Model column for one model', () => {
    const store = costStore('ci-A', 'Item, A', 12);
    const backend = createCostBackend(() => ({ modelId: 'a', store }));
    const report = buildCostCsvReport([{ modelName: 'Building.ifc', graph: backend.data() }], backend.evaluateItem);
    assert.ok(report);
    assert.equal(report.filename, 'Building-cost.csv');
    assert.equal(report.rows, 1);
    assert.equal(report.content,
      'GlobalId,Name,IfcClass,Identification,Amount,Currency,QuantityApplied,Diagnostics\n' +
      'ci-A,"Item, A",IfcCostItem,,12,GBP,,\n');
  });

  it('keeps same local express ids in distinct models and names the source model for each row', () => {
    const stores = new Map([
      ['a', costStore('ci-A', 'Item A', 12)],
      ['b', costStore('ci-B', 'Item B', 34)],
    ]);
    const backend = createCostBackend((modelId) => ({ modelId: modelId ?? 'a', store: stores.get(modelId ?? 'a')! }));
    const report = buildCostCsvReport([
      { modelName: 'A.ifc', graph: backend.data('a') },
      { modelName: 'B.ifc', graph: backend.data('b') },
    ], backend.evaluateItem);
    assert.ok(report);
    assert.equal(report.filename, 'federation-cost.csv');
    assert.equal(report.rows, 2);
    assert.equal(report.content,
      'Model,GlobalId,Name,IfcClass,Identification,Amount,Currency,QuantityApplied,Diagnostics\n' +
      'A.ifc,ci-A,Item A,IfcCostItem,,12,GBP,,\n' +
      'B.ifc,ci-B,Item B,IfcCostItem,,34,GBP,,\n');
  });

  it('does not offer a cost download when no cost item exists', () => {
    assert.equal(buildCostCsvReport([{ modelName: 'Empty.ifc', graph: null }], () => {
      throw new Error('no item may be evaluated');
    }), null);
  });

  it('#6872 exports per-asset deviation statistics, with an all-assets summary row in a federation', () => {
    const tolerance = 0.25;
    const options = { tolerance, clipRange: 1 };
    const a = new Float32Array([-0.125, 0.25, 0.25, -0.5]);
    const b = new Float32Array([1, -0.5, Number.NaN]);
    const assetA = {
      Model: 'Scan A.las', GlobalId: 'pointcloud-7', Name: 'Scan A', IfcClass: 'IfcGeographicElement',
      statistics: computeDeviationStatistics(a, options),
    };
    const header = 'GlobalId,Name,IfcClass,PointsProcessed,FinitePoints,MinimumDeviationM,MaximumDeviationM,' +
      'MeanDeviationM,MeanAbsoluteDeviationM,RmsDeviationM,StandardDeviationM,P50AbsoluteDeviationM,' +
      'P95AbsoluteDeviationM,P99AbsoluteDeviationM,MaxAbsoluteDeviationM,ToleranceM,WithinTolerancePoints,' +
      'WithinToleranceShare,ClippedPoints\n';
    const single = buildDeviationCsvReport({ assets: [assetA], overall: null }, ['Scan A.las']);
    assert.ok(single);
    assert.equal(single.filename, 'Scan A-deviation.csv');
    assert.equal(single.rows, 1);
    // |d| = [0.125, 0.25, 0.25, 0.5]: mean −0.03125, mean|d| 0.28125,
    // Σd² = 0.390625, nearest-rank P50 0.25, P95 = P99 = max 0.5.
    const [head, row] = single.content.trimEnd().split('\n');
    assert.equal(`${head}\n`, header);
    const cells = row.split(',');
    assert.deepEqual(cells.slice(0, 9), ['pointcloud-7', 'Scan A', 'IfcGeographicElement', '4', '4', '-0.5', '0.25', '-0.03125', '0.28125']);
    assert.ok(Math.abs(Number(cells[9]) - Math.sqrt(0.390625 / 4)) < 1e-12, `RMS ${cells[9]}`);
    assert.ok(Math.abs(Number(cells[10]) - Math.sqrt(0.390625 / 4 - 0.03125 ** 2)) < 1e-12, `σ ${cells[10]}`);
    assert.deepEqual(cells.slice(11), ['0.25', '0.5', '0.5', '0.5', '0.25', '3', '0.75', '0']);

    const federation = buildDeviationCsvReport({
      assets: [assetA, {
        Model: 'Scan B.las', GlobalId: 'pointcloud-8', Name: '=HYPERLINK("x")', IfcClass: 'IfcGeographicElement',
        statistics: computeDeviationStatistics(b, options),
      }],
      overall: { name: 'All scan assets', statistics: computeDeviationStatistics(new Float32Array([...a, ...b]), options) },
    }, ['Building.ifc', 'Scan A.las', 'Scan B.las']);
    assert.ok(federation);
    assert.equal(federation.filename, 'federation-deviation.csv');
    assert.equal(federation.rows, 3);
    const lines = federation.content.trimEnd().split('\n');
    assert.equal(lines[0], `Model,${header.trimEnd()}`);
    // A scan name is user-derived: the shared escaper neutralises formulas.
    assert.ok(lines[2].startsWith(`Scan B.las,pointcloud-8,"'=HYPERLINK(""x"")",IfcGeographicElement,3,2,-0.5,1,0.25,`));
    assert.ok(lines[2].endsWith(',0.25,0,0,1'), lines[2]);
    // The summary row pools every asset's points; it is not a mean of means.
    assert.ok(lines[3].startsWith(',,All scan assets,,7,6,-0.5,1,'), lines[3]);
    assert.ok(lines[3].endsWith(',0.25,3,0.5,1'), lines[3]);
  });
});
