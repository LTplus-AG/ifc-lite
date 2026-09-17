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
  treeHasMixedCurrencyEvaluation,
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

describe('buildCostTree — IfcRelNests may legally nest a non-cost-item child', () => {
  it('drops the non-cost-item child but keeps the real sibling, and never throws', () => {
    // #10 is an IfcWall, not an IfcCostItem — schema-valid RelatedObjects
    // member of IfcRelNests (it may decompose any IfcObjectDefinition).
    // Without the `itemsByKey.has(childKey)` guard at cost-tree.ts:123,
    // buildNode(#10) is reached and throws "item ... vanished mid-build",
    // crashing the whole Cost panel for this model.
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#10=IFCWALL('w',$,'Not a cost item',$,$,$,$,$,$);",
      "#40=IFCCOSTITEM('ciA',$,'Parent item',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('ciB',$,'Real child',$,$,$,.USERDEFINED.,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#10,#41));",
    ]);
    const graph = backendFor('m1', store).data();

    // Fixture can fail: without the guard, this call throws synchronously.
    const tree = buildCostTree(graph);

    assert.equal(tree.unassignedItems.length, 1);
    assert.equal(tree.unassignedItems[0].item.Name, 'Parent item');
    // The real cost-item child still surfaces — and ONLY it, the wall never
    // masquerades as a nested cost-tree node.
    assert.deepEqual(tree.unassignedItems[0].children.map((c) => c.item.Name), ['Real child']);
  });
});

describe('buildCostTree — a cost item as RelatingControl (alternate nesting idiom)', () => {
  it('surfaces items assigned to a non-schedule control in the unassigned bucket, never silently dropped', () => {
    // `IfcCostItem` is an `IfcControl`, so #40 legally sits as the
    // `RelatingControl` of an `IfcRelAssignsToControl` naming #41 — schema
    // -valid but NOT a schedule assignment. Without the
    // `schedulesByKey.has(controlKey)` guard at cost-tree.ts:153, #41 gets
    // marked "assigned" against a bogus schedule key that matches no real
    // `IfcCostSchedule` node, so it vanishes from both the schedule tree
    // and the unassigned bucket — contradicting cost-tree.ts's own stated
    // goal that nothing a real model declares is silently dropped.
    //
    // Decision: both #40 (the control) and #41 (its related item) belong
    // in the unassigned bucket. Neither is nested (no IfcRelNests) and
    // neither is assigned to a real IfcCostSchedule, so under the tree's
    // existing "not assigned AND not nested" rule they surface there —
    // the same place a cost item with no relationships at all would land.
    //
    // A real schedule assignment (#42 -> #50) is included alongside so the
    // fixture can fail: without the guard, #41 disappears from BOTH
    // buckets while #42 still resolves correctly under its real schedule,
    // proving the bug is specific to the bogus-control path.
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('ciX',$,'Not a schedule control',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('ciY',$,'Related item',$,$,$,.USERDEFINED.,$,$);",
      "#42=IFCCOSTITEM('ciZ',$,'Scheduled item',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('cs1',$,'Real schedule',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#41),$,#40);",
      "#61=IFCRELASSIGNSTOCONTROL('r2',$,$,$,(#42),$,#50);",
    ]);
    const graph = backendFor('m1', store).data();
    const tree = buildCostTree(graph);

    assert.equal(tree.schedules.length, 1);
    assert.deepEqual(tree.schedules[0].items.map((n) => n.item.Name), ['Scheduled item']);
    assert.deepEqual(
      tree.unassignedItems.map((n) => n.item.Name).sort(),
      ['Not a schedule control', 'Related item'],
    );
  });
});

describe('buildCostTree — review findings on PR #4875', () => {
  it('keeps an unscheduled IfcRelNests cycle visible via one representative root', () => {
    // A -> B -> A with no schedule assignment: every item is a nested child,
    // so the plain "not assigned AND not nested" rule surfaces nothing and
    // the panel would claim the model has no cost items.
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#39=IFCCOSTITEM('x',$,'Hangs off cycle',$,$,$,.USERDEFINED.,$,$);",
      "#40=IFCCOSTITEM('a',$,'A',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('b',$,'B',$,$,$,.USERDEFINED.,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
      "#61=IFCRELNESTS('n2',$,$,$,#41,(#40,#39));",
    ]);
    const tree = buildCostTree(backendFor('m1', store).data());
    // The representative is a cycle member (reached by climbing parents
    // from #39), never the item hanging off the cycle, even though #39
    // comes first in CostItems order.
    assert.deepEqual(tree.unassignedItems.map((n) => n.item.Name), ['B']);
    const [b] = tree.unassignedItems;
    assert.deepEqual(b.children.map((c) => c.item.Name), ['A', 'Hangs off cycle']);
    const a = b.children[0];
    assert.deepEqual(a.children.map((c) => c.item.Name), ['B']);
    assert.deepEqual(a.children[0].children, [], 'the cycle guard stops at the repeated B');
  });

  it('does not render a nested child that is also schedule-assigned as a schedule root', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('p',$,'Parent',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('c',$,'Child',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('cs',$,'Budget',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
      "#61=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40,#41),$,#50);",
    ]);
    const tree = buildCostTree(backendFor('m1', store).data());
    assert.deepEqual(tree.schedules[0].items.map((n) => n.item.Name), ['Parent']);
    assert.deepEqual(tree.schedules[0].items[0].children.map((n) => n.item.Name), ['Child']);
    assert.deepEqual(tree.unassignedItems, []);
  });

  it('treats IFC2X3 IfcRelSchedulesCostItems as a schedule assignment', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('ci',$,'Scheduled 2x3 item',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('cs',$,'2x3 budget',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELSCHEDULESCOSTITEMS('r1',$,$,$,(#40),$,#50);",
    ], 'IFC2X3');
    const graph = backendFor('m1', store).data();
    assert.ok(graph.Relationships.some((r) => r.Type === 'IfcRelSchedulesCostItems'), 'read model emits the IFC2X3 relationship');
    const tree = buildCostTree(graph);
    assert.deepEqual(tree.schedules[0].items.map((n) => n.item.Name), ['Scheduled 2x3 item']);
    assert.deepEqual(tree.unassignedItems, []);
    assert.deepEqual(
      getOwningSchedules(graph, { modelId: 'm1', expressId: 40 }).map((s) => s.Name),
      ['2x3 budget'],
    );
  });

  it('dedupes duplicate relationship entities naming the same pair', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('p',$,'Parent',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('c',$,'Child',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('cs',$,'Budget',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
      "#61=IFCRELNESTS('n2',$,$,$,#40,(#41));",
      "#62=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40),$,#50);",
      "#63=IFCRELASSIGNSTOCONTROL('r2',$,$,$,(#40),$,#50);",
    ]);
    const tree = buildCostTree(backendFor('m1', store).data());
    assert.equal(tree.schedules[0].items.length, 1);
    assert.equal(tree.schedules[0].items[0].children.length, 1);
  });

  it('builds a very deep acyclic nesting chain without exhausting the call stack', () => {
    const depth = 20000;
    const lines = [...PROJECT_GBP];
    for (let i = 0; i < depth; i++) {
      lines.push(`#${1000 + i}=IFCCOSTITEM('c${i}',$,'Item ${i}',$,$,$,.USERDEFINED.,$,$);`);
    }
    for (let i = 0; i < depth - 1; i++) {
      lines.push(`#${100000 + i}=IFCRELNESTS('n${i}',$,$,$,#${1000 + i},(#${1001 + i}));`);
    }
    const tree = buildCostTree(backendFor('m1', buildStoreFromStep(lines)).data());
    assert.equal(tree.unassignedItems.length, 1);
    let node = tree.unassignedItems[0];
    let levels = 1;
    while (node.children.length > 0) {
      node = node.children[0];
      levels++;
    }
    assert.equal(levels, depth);
  });
});

describe('buildCostTree — follow-up review findings on PR #4875', () => {
  it('keeps a directly assigned child as a schedule root when its nesting parent is outside the schedule', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('a',$,'Unassigned parent',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('b',$,'Scheduled child',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('cs',$,'Budget',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
      "#61=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#41),$,#50);",
    ]);
    const tree = buildCostTree(backendFor('m1', store).data());
    assert.deepEqual(tree.schedules[0].items.map((n) => n.item.Name), ['Scheduled child']);
    assert.deepEqual(tree.unassignedItems.map((n) => n.item.Name), ['Unassigned parent']);
    assert.deepEqual(tree.unassignedItems[0].children.map((n) => n.item.Name), ['Scheduled child']);
  });

  it('keeps schedule-assigned items that nest each other in a cycle visible under the schedule', () => {
    const store = buildStoreFromStep([
      ...PROJECT_GBP,
      "#40=IFCCOSTITEM('a',$,'A',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('b',$,'B',$,$,$,.USERDEFINED.,$,$);",
      "#50=IFCCOSTSCHEDULE('cs',$,'Budget',$,$,$,.BUDGET.,$,$,$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
      "#61=IFCRELNESTS('n2',$,$,$,#41,(#40));",
      "#62=IFCRELASSIGNSTOCONTROL('r1',$,$,$,(#40,#41),$,#50);",
    ]);
    const tree = buildCostTree(backendFor('m1', store).data());
    assert.deepEqual(tree.schedules[0].items.map((n) => n.item.Name), ['A']);
    assert.deepEqual(tree.schedules[0].items[0].children.map((n) => n.item.Name), ['B']);
    assert.deepEqual(tree.unassignedItems, []);
  });

  it('detects MIXED_CURRENCY that only item evaluation reports, including in a nested item', () => {
    const lines = (secondCurrency: string) => [
      "#1=IFCPROJECT('proj',$,'P',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#5));',
      "#5=IFCMONETARYUNIT('GBP');",
      `#6=IFCMONETARYUNIT('${secondCurrency}');`,
      '#20=IFCMEASUREWITHUNIT(IFCMONETARYMEASURE(5.),#5);',
      '#21=IFCMEASUREWITHUNIT(IFCMONETARYMEASURE(1.),#6);',
      "#30=IFCCOSTVALUE('Pounds',$,#20,$,$,$,$,$,$,$);",
      "#31=IFCCOSTVALUE('Other',$,#21,$,$,$,$,$,$,$);",
      "#32=IFCCOSTVALUE('Sum',$,$,$,$,$,$,$,.ADD.,(#30,#31));",
      "#40=IFCCOSTITEM('p',$,'Parent',$,$,$,.USERDEFINED.,$,$);",
      "#41=IFCCOSTITEM('c',$,'Mixed child',$,$,$,.USERDEFINED.,(#32),$);",
      "#60=IFCRELNESTS('n1',$,$,$,#40,(#41));",
    ];
    const mixedBackend = backendFor('m1', buildStoreFromStep(lines('USD')));
    const mixedGraph = mixedBackend.data();
    assert.equal(classifyCostModel(mixedGraph).mixedCurrency, false, 'extraction alone does not report it');
    assert.equal(treeHasMixedCurrencyEvaluation(buildCostTree(mixedGraph), (ref) => mixedBackend.evaluateItem(ref)), true);

    // Control: same currency on both operands is not mixed (fixture can fail).
    const sameBackend = backendFor('m1', buildStoreFromStep(lines('GBP')));
    const sameGraph = sameBackend.data();
    assert.equal(treeHasMixedCurrencyEvaluation(buildCostTree(sameGraph), (ref) => sameBackend.evaluateItem(ref)), false);
  });
});

describe('buildCostTree — bounded expansion of multiply-parented nesting (PR #4875)', () => {
  it('expands a 30-level diamond chain once per item, not once per path (2^30)', () => {
    // Level i has items L_i and R_i; each nests BOTH L_{i+1} and R_{i+1}.
    // A top item nests L_0 and R_0. Path-by-path expansion would build ~2^31
    // nodes; the once-per-tree rule keeps it linear in items + edges.
    const levels = 30;
    const lines = [...PROJECT_GBP, "#1000=IFCCOSTITEM('top',$,'Top',$,$,$,.USERDEFINED.,$,$);"];
    const left = (i: number) => 2000 + i;
    const right = (i: number) => 3000 + i;
    for (let i = 0; i < levels; i++) {
      lines.push(`#${left(i)}=IFCCOSTITEM('l${i}',$,'L${i}',$,$,$,.USERDEFINED.,$,$);`);
      lines.push(`#${right(i)}=IFCCOSTITEM('r${i}',$,'R${i}',$,$,$,.USERDEFINED.,$,$);`);
    }
    let relId = 5000;
    lines.push(`#${relId++}=IFCRELNESTS('top',$,$,$,#1000,(#${left(0)},#${right(0)}));`);
    for (let i = 0; i < levels - 1; i++) {
      for (const parent of [left(i), right(i)]) {
        lines.push(`#${relId++}=IFCRELNESTS('n${relId}',$,$,$,#${parent},(#${left(i + 1)},#${right(i + 1)}));`);
      }
    }
    const itemCount = 1 + 2 * levels;
    const edgeCount = 2 + 4 * (levels - 1);

    const started = Date.now();
    const tree = buildCostTree(backendFor('m1', buildStoreFromStep(lines)).data());
    const elapsedMs = Date.now() - started;

    let nodes = 0;
    let repeated = 0;
    const expandedKeys = new Set<string>();
    const pending = [...tree.unassignedItems];
    while (pending.length > 0) {
      const node = pending.pop()!;
      nodes++;
      const key = `${node.ref.modelId}:${node.ref.expressId}`;
      if (node.repeated) {
        repeated++;
        assert.deepEqual(node.children, [], 'a repeated occurrence is a leaf reference');
      } else {
        assert.equal(expandedKeys.has(key), false, `item ${key} expanded more than once`);
        expandedKeys.add(key);
      }
      pending.push(...node.children);
    }
    assert.deepEqual(tree.unassignedItems.map((n) => n.item.Name), ['Top']);
    assert.equal(expandedKeys.size, itemCount, 'every item is expanded exactly once');
    assert.equal(nodes, 1 + edgeCount, 'one node per root plus one per nesting edge');
    assert.equal(repeated, nodes - itemCount);
    assert.ok(elapsedMs < 5000, `built in ${elapsedMs}ms`);
  });
});
