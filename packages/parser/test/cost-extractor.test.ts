/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { extractCostOnDemand } from '../src/cost-extractor.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

/**
 * Minimal in-memory IfcDataStore builder for tests — mirrors the helper used
 * in `schedule-extractor.test.ts` and other on-demand extractor suites. Each
 * `line` is a full STEP statement; byteOffset/byteLength are computed by
 * matching the line in the composed text.
 */
function buildStoreFromStep(
  lines: string[],
  opts?: {
    schemaVersion?: IfcDataStore['schemaVersion'];
    globalIdByExpressId?: Map<number, string>;
  },
): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let cursor = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];
      const idx = text.indexOf(line, cursor);
      const byteOffset = idx >= 0 ? idx : cursor;
      const ref: EntityRef = {
        expressId,
        type,
        byteOffset,
        byteLength: line.length,
        lineNumber: 1,
      };
      byId.set(expressId, ref);
      const typeUpper = type.toUpperCase();
      let list = byType.get(typeUpper);
      if (!list) {
        list = [];
        byType.set(typeUpper, list);
      }
      list.push(expressId);
      cursor = byteOffset + line.length + 1; // +1 for newline
    }
  }

  const gidMap = opts?.globalIdByExpressId ?? new Map<number, string>();
  const entities = {
    getGlobalId: (id: number) => gidMap.get(id) ?? '',
    getName: (id: number) => `entity${id}`,
  };

  return {
    source,
    schemaVersion: opts?.schemaVersion ?? 'IFC4',
    entityIndex: { byId, byType },
    entities,
  } as unknown as IfcDataStore;
}

describe('extractCostOnDemand', () => {
  it('returns empty extraction with hasCost=false when no cost entities', () => {
    const store = buildStoreFromStep(["#1=IFCWALL('wall-gid',$,'W',$,$,$,$,$,$);"]);
    const result = extractCostOnDemand(store);
    expect(result.hasCost).toBe(false);
    expect(result.costItems).toEqual([]);
    expect(result.costSchedules).toEqual([]);
  });

  it('resolves CostQuantities via collectQuantitiesFromRefs when present', () => {
    const lines = [
      "#20=IFCQUANTITYLENGTH('NetLength',$,$,12.5,$);",
      "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,$,(#20));",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractCostOnDemand(store);
    expect(result.hasCost).toBe(true);
    expect(result.costItems).toHaveLength(1);
    const item = result.costItems[0];
    expect(item.globalId).toBe('ci-gid');
    expect(item.name).toBe('Excavation');
    expect(item.predefinedType).toBe('USERDEFINED');
    expect(item.costQuantities).toHaveLength(1);
    expect(item.costQuantities?.[0].name).toBe('NetLength');
    expect(item.costQuantities?.[0].value).toBe(12.5);
  });

  it('extracts CostValues including nested Components', () => {
    const lines = [
      "#40=IFCCOSTVALUE('Labour',$,IFCMONETARYMEASURE(150.),$,$,$,$,$,$,$);",
      "#41=IFCCOSTVALUE('Material',$,IFCMONETARYMEASURE(350.),$,$,$,$,$,$,$);",
      "#42=IFCCOSTVALUE('Total',$,IFCMONETARYMEASURE(500.),$,$,$,'General',$,.ADD.,(#40,#41));",
      "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,(#42),$);",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractCostOnDemand(store);
    const item = result.costItems[0];
    expect(item.costValues).toHaveLength(1);
    const total = item.costValues?.[0];
    expect(total?.name).toBe('Total');
    expect(total?.appliedValue).toBe(500);
    expect(total?.arithmeticOperator).toBe('ADD');
    expect(total?.components).toHaveLength(2);
    expect(total?.components?.map((c) => c.name)).toEqual(['Labour', 'Material']);
    expect(total?.components?.map((c) => c.appliedValue)).toEqual([150, 350]);
  });

  it('a cost item WITHOUT CostQuantities yields undefined and does NOT fall back to the product Qto_ set', () => {
    // The assigned product carries a real Qto_ set (Qto_WallBaseQuantities)
    // with a value that would betray a wrongful fallback if the extractor
    // ever reached for it: 999 does not appear anywhere else in this fixture.
    const lines = [
      "#1=IFCWALL('wall-gid',$,'Wall A',$,$,$,$,$,$);",
      "#2=IFCQUANTITYLENGTH('Length',$,$,999,$);",
      "#3=IFCELEMENTQUANTITY('qto-gid',$,'Qto_WallBaseQuantities',$,$,(#2));",
      "#4=IFCRELDEFINESBYPROPERTIES('reldef-gid',$,$,$,(#1),#3);",
      "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,$,$);",
      "#20=IFCRELASSIGNSTOCONTROL('rel-gid',$,$,$,(#1),$,#10);",
    ];
    const store = buildStoreFromStep(lines, {
      globalIdByExpressId: new Map([[1, 'wall-gid']]),
    });
    const result = extractCostOnDemand(store);
    const item = result.costItems[0];
    expect(item.costQuantities).toBeUndefined();
    expect(item.productExpressIds).toEqual([1]);
    // Would be [999] if the extractor wrongly fell back to the product's Qto_ set.
  });

  it('a cost item with no products assigned yields empty arrays, not undefined', () => {
    const lines = ["#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,$,$);"];
    const store = buildStoreFromStep(lines);
    const result = extractCostOnDemand(store);
    const item = result.costItems[0];
    expect(item.productExpressIds).toEqual([]);
    expect(item.productGlobalIds).toEqual([]);
    expect(item.productExpressIds).not.toBeUndefined();
  });

  it('builds parent/child cost-item hierarchy via IfcRelNests', () => {
    const lines = [
      "#10=IFCCOSTITEM('root-gid',$,'Shell','desc','obj','ID1',.USERDEFINED.,$,$);",
      "#11=IFCCOSTITEM('child-a-gid',$,'Foundation','desc','obj','ID2',.USERDEFINED.,$,$);",
      "#12=IFCCOSTITEM('child-b-gid',$,'Framing','desc','obj','ID3',.USERDEFINED.,$,$);",
      "#20=IFCRELNESTS('rel-gid',$,$,$,#10,(#11,#12));",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractCostOnDemand(store);
    const root = result.costItems.find((i) => i.globalId === 'root-gid');
    const a = result.costItems.find((i) => i.globalId === 'child-a-gid');
    const b = result.costItems.find((i) => i.globalId === 'child-b-gid');
    expect(root?.childGlobalIds).toEqual(['child-a-gid', 'child-b-gid']);
    expect(a?.parentGlobalId).toBe('root-gid');
    expect(b?.parentGlobalId).toBe('root-gid');
  });

  it('associates cost items with a cost schedule via IfcRelAssignsToControl', () => {
    const lines = [
      "#10=IFCCOSTITEM('ci-a-gid',$,'Item A','desc','obj','ID1',.USERDEFINED.,$,$);",
      "#11=IFCCOSTITEM('ci-b-gid',$,'Item B','desc','obj','ID2',.USERDEFINED.,$,$);",
      "#30=IFCCOSTSCHEDULE('sched-gid',$,'Main budget','desc','obj','S1',.BUDGET.,'Draft','2024-01-01','2024-02-01');",
      "#40=IFCRELASSIGNSTOCONTROL('rel-gid',$,$,$,(#10,#11),$,#30);",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractCostOnDemand(store);
    expect(result.costSchedules).toHaveLength(1);
    const sched = result.costSchedules[0];
    expect(sched.globalId).toBe('sched-gid');
    expect(sched.name).toBe('Main budget');
    expect(sched.predefinedType).toBe('BUDGET');
    expect(sched.costItemGlobalIds).toEqual(['ci-a-gid', 'ci-b-gid']);
    const a = result.costItems.find((i) => i.globalId === 'ci-a-gid');
    expect(a?.controllingScheduleGlobalIds).toEqual(['sched-gid']);
  });

  it('resolves products assigned to a cost item via IfcRelAssignsToControl', () => {
    const lines = [
      "#1=IFCWALL('wall-A-gid',$,'Wall A',$,$,$,$,$,$);",
      "#2=IFCWALL('wall-B-gid',$,'Wall B',$,$,$,$,$,$);",
      "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,$,$);",
      "#20=IFCRELASSIGNSTOCONTROL('rel-gid',$,$,$,(#1,#2),$,#10);",
    ];
    const store = buildStoreFromStep(lines, {
      globalIdByExpressId: new Map([[1, 'wall-A-gid'], [2, 'wall-B-gid']]),
    });
    const result = extractCostOnDemand(store);
    const item = result.costItems[0];
    expect(item.productExpressIds).toEqual([1, 2]);
    expect(item.productGlobalIds).toEqual(['wall-A-gid', 'wall-B-gid']);
  });

  describe('UnitBasis (rate vs. flat total)', () => {
    // Shared unit chain: "hour" = an IfcConversionBasedUnit whose
    // ConversionFactor (#51) is 3600 IFCSIUNIT SECONDs (#50) — same fixture
    // shape as `unit-extractor.test.ts`'s FOOT case, so this exercises the
    // real `resolveUnitByRef` chain (IFCMEASUREWITHUNIT -> IFCCONVERSIONBASEDUNIT
    // -> IFCMEASUREWITHUNIT -> IFCSIUNIT), not a stub.
    const HOUR_UNIT_LINES = [
      "#50=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);",
      "#51=IFCMEASUREWITHUNIT(IFCTIMEMEASURE(3600.),#50);",
      "#52=IFCCONVERSIONBASEDUNIT($,.TIMEUNIT.,'HOUR',#51);",
      // The UnitBasis instance itself: "per 1 hour".
      "#60=IFCMEASUREWITHUNIT(IFCTIMEMEASURE(1.),#52);",
    ];

    it('a CostValue WITH UnitBasis surfaces valueComponent + resolved unit symbol/scale', () => {
      const lines = [
        ...HOUR_UNIT_LINES,
        "#40=IFCCOSTVALUE('Labour rate',$,IFCMONETARYMEASURE(85.),#60,$,$,$,$,$,$);",
        "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,(#40),$);",
      ];
      const store = buildStoreFromStep(lines);
      const result = extractCostOnDemand(store);
      const value = result.costItems[0].costValues?.[0];
      expect(value?.appliedValue).toBe(85);
      expect(value?.unitBasis).toBeDefined();
      expect(value?.unitBasis?.valueComponent).toBe(1);
      expect(value?.unitBasis?.unitSymbol).toBe('h');
      expect(value?.unitBasis?.unitSiScale).toBeCloseTo(3600, 10);
    });

    it('a CostValue WITHOUT UnitBasis yields the absent form (undefined), not a fabricated default', () => {
      const lines = [
        "#40=IFCCOSTVALUE('Flat total',$,IFCMONETARYMEASURE(85.),$,$,$,$,$,$,$);",
        "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,(#40),$);",
      ];
      const store = buildStoreFromStep(lines);
      const result = extractCostOnDemand(store);
      const value = result.costItems[0].costValues?.[0];
      expect(value?.appliedValue).toBe(85);
      expect(value?.unitBasis).toBeUndefined();
    });

    it('DECISIVE: a rate and a flat total with numerically identical AppliedValue are distinguishable only via unitBasis', () => {
      const lines = [
        ...HOUR_UNIT_LINES,
        // Both carry AppliedValue = 85. Only #40 has a UnitBasis.
        "#40=IFCCOSTVALUE('Labour rate',$,IFCMONETARYMEASURE(85.),#60,$,$,$,$,$,$);",
        "#41=IFCCOSTVALUE('Flat total',$,IFCMONETARYMEASURE(85.),$,$,$,$,$,$,$);",
        "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,(#40,#41),$);",
      ];
      const store = buildStoreFromStep(lines);
      const result = extractCostOnDemand(store);
      const [rate, total] = result.costItems[0].costValues ?? [];

      // Identical in AppliedValue — a consumer summing on appliedValue alone
      // cannot tell them apart, which is exactly the bug this fix closes.
      expect(rate.appliedValue).toBe(total.appliedValue);
      expect(rate.appliedValue).toBe(85);

      // Distinguishable via unitBasis: rate is defined, total is undefined.
      expect(rate.unitBasis).toBeDefined();
      expect(total.unitBasis).toBeUndefined();
    });

    it('a CostValue whose UnitBasis references a non-existent entity yields undefined, not a crash', () => {
      const lines = [
        "#40=IFCCOSTVALUE('Bad ref',$,IFCMONETARYMEASURE(85.),#999,$,$,$,$,$,$);",
        "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,(#40),$);",
      ];
      const store = buildStoreFromStep(lines);
      const result = extractCostOnDemand(store);
      const value = result.costItems[0].costValues?.[0];
      expect(value?.unitBasis).toBeUndefined();
    });

    it('a CostValue whose UnitBasis points to an unresolvable unit (IfcContextDependentUnit) keeps the rate signal but loses unit details', () => {
      // This is the critical test that stops a rate collapsing into a flat total
      // when a unit cannot be resolved. The UnitBasis object is defined (rate
      // signal), but unitSymbol and unitSiScale are undefined because
      // IfcContextDependentUnit has no case in resolveUnitByRef.
      const lines = [
        "#50=IFCCONTEXTDEPENDENTUNIT($,.LENGTHUNIT.,'custom-unit');",
        "#60=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#50);",
        "#40=IFCCOSTVALUE('Labour rate',$,IFCMONETARYMEASURE(85.),#60,$,$,$,$,$,$);",
        "#10=IFCCOSTITEM('ci-gid',$,'Excavation','desc','obj','ID1',.USERDEFINED.,(#40),$);",
      ];
      const store = buildStoreFromStep(lines);
      const result = extractCostOnDemand(store);
      const value = result.costItems[0].costValues?.[0];

      // The rate signal survives: unitBasis is defined, not undefined.
      expect(value?.unitBasis).toBeDefined();
      // The valueComponent is resolved (the numeric part of IfcMeasureWithUnit).
      expect(value?.unitBasis?.valueComponent).toBe(1);
      // But the unit part is unresolvable, so symbol and scale degrade individually.
      expect(value?.unitBasis?.unitSymbol).toBeUndefined();
      expect(value?.unitBasis?.unitSiScale).toBeUndefined();
    });
  });

  describe('IFC2X3', () => {
    it('handles an IfcCostItem with no attributes explicitly, without crashing or misreading', () => {
      // IFC2X3's IfcCostItem is `SUBTYPE OF (IfcControl); END_ENTITY;` — no
      // PredefinedType, CostValues, or CostQuantities exist at all.
      const lines = ["#10=IFCCOSTITEM('ci-2x3-gid',$,'Costing','desc','obj','ID1');"];
      const store = buildStoreFromStep(lines, { schemaVersion: 'IFC2X3' });
      const result = extractCostOnDemand(store);
      expect(result.hasCost).toBe(true);
      expect(result.costItems).toHaveLength(1);
      const item = result.costItems[0];
      expect(item.globalId).toBe('ci-2x3-gid');
      expect(item.name).toBe('Costing');
      expect(item.predefinedType).toBeUndefined();
      expect(item.costValues).toBeUndefined();
      expect(item.costQuantities).toBeUndefined();
      expect(item.productExpressIds).toEqual([]);
    });

    it('ignores trailing attributes on a malformed 2X3 IfcCostItem rather than misreading them as PredefinedType/CostValues/CostQuantities', () => {
      // Not valid IFC2X3 (a conformant 2X3 IfcCostItem carries only the
      // 6-slot IfcControl base), but if a corrupt/hand-edited file's
      // IFCCOSTITEM line DID carry extra trailing tokens shaped like the
      // IFC4 extension, the schema-version gate must still refuse to read
      // them as PredefinedType/CostValues/CostQuantities for a store marked
      // IFC2X3.
      const lines = [
        "#20=IFCQUANTITYLENGTH('NetLength',$,$,12.5,$);",
        "#10=IFCCOSTITEM('ci-2x3-gid',$,'Costing','desc','obj','ID1',.USERDEFINED.,$,(#20));",
      ];
      const store = buildStoreFromStep(lines, { schemaVersion: 'IFC2X3' });
      const result = extractCostOnDemand(store);
      const item = result.costItems[0];
      expect(item.predefinedType).toBeUndefined();
      expect(item.costValues).toBeUndefined();
      expect(item.costQuantities).toBeUndefined();
    });
  });
});
