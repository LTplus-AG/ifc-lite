/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCostBackend } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
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

  it('exports signed-distance rows per scan asset, with model attribution in a federation', () => {
    const scans = [{
      Model: 'Scan A.las', GlobalId: 'pointcloud-7', Name: 'Scan A', IfcClass: 'IfcGeographicElement',
      PointsProcessed: 250, FinitePoints: 250,
      MinimumDeviationM: -0.125, MaximumDeviationM: 0.25, MeanDeviationM: 0.05,
    }];
    const single = buildDeviationCsvReport(scans, ['Scan A.las']);
    assert.ok(single);
    assert.equal(single.filename, 'Scan A-deviation.csv');
    assert.equal(single.content,
      'GlobalId,Name,IfcClass,PointsProcessed,FinitePoints,MinimumDeviationM,MaximumDeviationM,MeanDeviationM\n' +
      'pointcloud-7,Scan A,IfcGeographicElement,250,250,-0.125,0.25,0.05\n');

    const federation = buildDeviationCsvReport([...scans, {
      Model: 'Scan B.las', GlobalId: 'pointcloud-8', Name: 'Scan B', IfcClass: 'IfcGeographicElement',
      PointsProcessed: 100, FinitePoints: 99,
      MinimumDeviationM: -0.5, MaximumDeviationM: 0.4, MeanDeviationM: 0,
    }], ['Building.ifc', 'Scan A.las', 'Scan B.las']);
    assert.ok(federation);
    assert.equal(federation.filename, 'federation-deviation.csv');
    assert.equal(federation.content,
      'Model,GlobalId,Name,IfcClass,PointsProcessed,FinitePoints,MinimumDeviationM,MaximumDeviationM,MeanDeviationM\n' +
      'Scan A.las,pointcloud-7,Scan A,IfcGeographicElement,250,250,-0.125,0.25,0.05\n' +
      'Scan B.las,pointcloud-8,Scan B,IfcGeographicElement,100,99,-0.5,0.4,0\n');
  });
});
