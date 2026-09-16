/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * RED/GREEN coverage for the Cost panel's presentation logic (#4858),
 * against the REAL `@ifc-lite/sdk` cost backend — not a hand-rolled mock of
 * `CostGraphData` — so a regression in either the extractor/evaluator
 * (#4863) or the SDK projection (#4867) would redden these too.
 *
 * Five states the issue requires to be individually distinguishable:
 * empty, unresolved, cyclic, mixed-currency, federated. Each gets its own
 * fixture built so the state can actually fail (a single-item,
 * single-currency, non-nested fixture would exercise none of this).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCostBackend, type CostBackendMethods } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  buildCostTree,
  classifyCostModel,
  getAssignedTargets,
  getOwningSchedules,
  isUnresolved,
} from './cost-tree.js';

/** Mirrors the helper in `packages/parser/test/cost-extractor.test.ts` —
 *  a minimal in-memory `IfcDataStore` from raw STEP lines, with no real
 *  tokenizer/parser round-trip needed for these fixtures. */
interface LocalStepRef { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }

function buildStoreFromStep(lines: string[], schemaVersion: IfcDataStore['schemaVersion'] = 'IFC4'): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);
  const byId = new Map<number, LocalStepRef>();
  const byType = new Map<string, number[]>();
  let cursor = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (!match) continue;
    const expressId = parseInt(match[1], 10);
    const type = match[2];
    const idx = text.indexOf(line, cursor);
    const byteOffset = idx >= 0 ? idx : cursor;
    const ref: LocalStepRef = { expressId, type, byteOffset, byteLength: line.length, lineNumber: 1 };
    byId.set(expressId, ref);
    const typeUpper = type.toUpperCase();
    const list = byType.get(typeUpper) ?? [];
    list.push(expressId);
    byType.set(typeUpper, list);
    cursor = byteOffset + line.length + 1;
  }
  const entities = { getGlobalId: () => '', getName: (id: number) => `entity${id}` };
  return { source, schemaVersion, entityIndex: { byId, byType }, entities } as unknown as IfcDataStore;
}

function backendFor(modelId: string, store: IfcDataStore): CostBackendMethods {
  return createCostBackend(() => ({ modelId, store }));
}

const PROJECT_GBP = [
  "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
  '#2=IFCUNITASSIGNMENT((#3,#4,#5));',
  "#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);",
  "#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);",
  "#5=IFCMONETARYUNIT('GBP');",
];

describe('empty state — genuinely no cost data', () => {
  it('HasCostData is false, never re-derived from empty arrays', () => {
    const store = buildStoreFromStep([...PROJECT_GBP, "#10=IFCWALL('w',$,'Wall',$,$,$,$,$,$);"]);
    const graph = backendFor('m1', store).data();
    assert.deepEqual(graph.CostItems, []);
    const state = classifyCostModel(graph);
    assert.equal(state.hasCostData, false);
    assert.equal(state.cyclic, false);
    assert.equal(state.mixedCurrency, false);
  });

  it('a model WITH cost items is never classified as empty (fixture can fail)', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('ci',$,'Item',$,$,$,.USERDEFINED.,$,$);",
    ]);
    const graph = backendFor('m1', store).data();
    assert.equal(classifyCostModel(graph).hasCostData, true);
  });
});

describe('unresolved state — a real cost value with no applied value', () => {
  it('evaluateValue reports no Amount and a MISSING_VALUE diagnostic', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#30=IFCCOSTVALUE('No value',$,$,$,$,$,$,$,$,$);",
      "#40=IFCCOSTITEM('ci',$,'Unpriced item',$,$,$,.USERDEFINED.,(#30),$);",
    ]);
    const backend = backendFor('m1', store);
    const evaluation = backend.evaluateValue({ modelId: 'm1', expressId: 30 });
    assert.equal(isUnresolved(evaluation), true);
    assert.equal(evaluation.Diagnostics.some((d) => d.Code === 'MISSING_VALUE'), true);
  });

  it('a fully priced value resolves (fixture can fail)', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#30=IFCCOSTVALUE('Priced',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#40=IFCCOSTITEM('ci',$,'Priced item',$,$,$,.USERDEFINED.,(#30),$);",
    ]);
    const evaluation = backendFor('m1', store).evaluateValue({ modelId: 'm1', expressId: 30 });
    assert.equal(isUnresolved(evaluation), false);
    assert.equal(evaluation.Amount, '10');
  });
});

describe('cyclic state — a real IfcRelNests cycle', () => {
  it('surfaces the evaluator-reported NESTING_CYCLE diagnostic (never invented)', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('a',$,'A',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('b',$,'B',$,$,$,.USERDEFINED.,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
      "#61=IFCRELNESTS('n2',$,$,$,#41,(#40));",
    ]);
    const graph = backendFor('m1', store).data();
    const state = classifyCostModel(graph);
    assert.equal(state.cyclic, true);
    assert.equal(state.diagnostics.some((d) => d.Code === 'NESTING_CYCLE'), true);
  });

  it('an acyclic nesting is never misclassified as cyclic (fixture can fail)', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('a',$,'Parent',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('b',$,'Child',$,$,$,.USERDEFINED.,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
    ]);
    assert.equal(classifyCostModel(backendFor('m1', store).data()).cyclic, false);
  });
});

describe('mixed-currency state — two IfcMonetaryUnits declared in one project', () => {
  it('surfaces MIXED_CURRENCY and leaves Currency unresolved (never picks one)', () => {
    const store = buildStoreFromStep([
      "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
      "#2=IFCUNITASSIGNMENT((#5,#6));",
      "#5=IFCMONETARYUNIT('GBP');",
      "#6=IFCMONETARYUNIT('USD');",
      "#40=IFCCOSTITEM('ci',$,'Item',$,$,$,.USERDEFINED.,$,$);",
    ]);
    const graph = backendFor('m1', store).data();
    const state = classifyCostModel(graph);
    assert.equal(state.mixedCurrency, true);
    assert.equal(graph.Currency, undefined);
  });

  it('a single declared currency is never misclassified as mixed (fixture can fail)', () => {
    const store = buildStoreFromStep([...PROJECT_GBP, "#40=IFCCOSTITEM('ci',$,'Item',$,$,$,.USERDEFINED.,$,$);"]);
    const graph = backendFor('m1', store).data();
    assert.equal(classifyCostModel(graph).mixedCurrency, false);
    assert.equal(graph.Currency, 'GBP');
  });
});

describe('federated state — same expressId, different models, never conflated', () => {
  it('buildCostTree and getAssignedTargets key strictly by modelId+expressId', () => {
    const stepA = [
      ...PROJECT_GBP,
      "#10=IFCWALL('wA',$,'Wall A',$,$,$,$,$,$);",
      "#40=IFCCOSTITEM('ciA',$,'Item A',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('csA',$,'Schedule A',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40),$,#50);",
      "#61=IFCRELASSIGNSTOPRODUCT('r2',$,$,$,(#40),$,#10);",
    ];
    const stepB = [
      ...PROJECT_GBP,
      "#10=IFCWALL('wB',$,'Wall B',$,$,$,$,$,$);", // SAME expressId 10 as model A — must not collide
      "#40=IFCCOSTITEM('ciB',$,'Item B',$,$,$,.USERDEFINED.,$,$);", // SAME expressId 40 as model A
      "#50=IFCCOSTSCHEDULE('csB',$,'Schedule B',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40),$,#50);",
      "#61=IFCRELASSIGNSTOPRODUCT('r2',$,$,$,(#40),$,#10);",
    ];
    const graphA = backendFor('modelA', buildStoreFromStep(stepA)).data();
    const graphB = backendFor('modelB', buildStoreFromStep(stepB)).data();

    const treeA = buildCostTree(graphA);
    const treeB = buildCostTree(graphB);
    assert.equal(treeA.schedules.length, 1);
    assert.equal(treeB.schedules.length, 1);
    assert.equal(treeA.schedules[0].schedule.Name, 'Schedule A');
    assert.equal(treeB.schedules[0].schedule.Name, 'Schedule B');
    assert.equal(treeA.schedules[0].items[0].item.Name, 'Item A');
    assert.equal(treeB.schedules[0].items[0].item.Name, 'Item B');

    // Same local expressId (40) in both graphs — asking model A's tree for
    // model B's item must find nothing (fixture can fail: without the
    // modelId qualifier this would wrongly resolve).
    const targetsA = getAssignedTargets(graphA, { modelId: 'modelA', expressId: 40 });
    const targetsB = getAssignedTargets(graphB, { modelId: 'modelA', expressId: 40 }); // wrong modelId on purpose
    assert.deepEqual(targetsA, [{ modelId: 'modelA', expressId: 10 }]);
    assert.deepEqual(targetsB, []); // graph B has no relationship keyed to modelA:40
  });
});

describe('buildCostTree — nesting, schedule assignment, and the unassigned bucket', () => {
  it('matches the canonical buildingSMART composition fixture shape', () => {
    // Same shape as tests/models/cost/buildingsmart-cost-composition.ifc,
    // trimmed to what the tree builder needs.
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#10=IFCWALL('w',$,'Priced wall',$,$,$,$,$,$);",
      "#40=IFCCOSTITEM('ci40',$,'Scaffolding',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('ci41',$,'Brick wall',$,$,$,.USERDEFINED.,$,$);",
      "#42=IFCCOSTITEM('ci42',$,'External wall total',$,$,$,.USERDEFINED.,$,$);",
      "#43=IFCCOSTITEM('ci43',$,'Shared rate audit',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('cs50',$,'Canonical budget',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#42,(#40,#41));",
      "#61=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#42),$,#50);",
      "#62=IFCRELASSIGNSTOPRODUCT('r2',$,$,$,(#40),$,#10);",
    ]);
    const graph = backendFor('m1', store).data();
    const tree = buildCostTree(graph);

    assert.equal(tree.schedules.length, 1);
    const root = tree.schedules[0].items;
    assert.equal(root.length, 1);
    assert.equal(root[0].item.Name, 'External wall total');
    assert.deepEqual(root[0].children.map((c) => c.item.Name).sort(), ['Brick wall', 'Scaffolding']);

    // #43 "Shared rate audit" is neither nested nor schedule-assigned —
    // it must still appear, in the unassigned bucket, never silently dropped.
    assert.deepEqual(tree.unassignedItems.map((n) => n.item.Name), ['Shared rate audit']);

    assert.deepEqual(
      getAssignedTargets(graph, { modelId: 'm1', expressId: 40 }),
      [{ modelId: 'm1', expressId: 10 }],
    );
    assert.deepEqual(
      getOwningSchedules(graph, { modelId: 'm1', expressId: 42 }).map((s) => s.Name),
      ['Canonical budget'],
    );
    // A nested child is not directly "owned" by the schedule — only its parent is.
    assert.deepEqual(getOwningSchedules(graph, { modelId: 'm1', expressId: 40 }), []);
  });
});
