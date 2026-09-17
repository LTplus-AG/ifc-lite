/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bim.create.*` cost (5D) write surface — registration shape plus one
 * real sandbox round trip that authors a nested cost breakdown through the
 * bridge and reads the STEP back out of `bim.create.toIfc` (#4856).
 *
 * Registration alone proves nothing: a name can sit in
 * `COST_SPECIAL_METHOD_NAMES` while `buildCostMethods()` never emits a schema
 * for it, and a schema can exist while `call` throws. The eval exercises the
 * whole path, including the typed SELECT value and the shared UnitBasis.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { NAMESPACE_SCHEMAS } from './bridge-schema.js';
import { buildCostMethods, COST_SPECIAL_METHOD_NAMES } from './bridge-create-cost.js';
import { createSandbox } from './sandbox.js';

const CREATE_ONLY_PERMISSIONS = {
  query: false,
  mutate: false,
  viewer: false,
  export: true,
  model: false,
  lens: false,
  files: false,
} as const;

describe('bim.create cost method registration (#4856)', () => {
  it('registers every COST_SPECIAL_METHOD_NAMES entry as a real create-namespace method', () => {
    const createNamespace = NAMESPACE_SCHEMAS.find(schema => schema.name === 'create');
    expect(createNamespace).toBeDefined();
    const registered = new Set(createNamespace!.methods.map(m => m.name));
    for (const name of COST_SPECIAL_METHOD_NAMES) {
      expect(registered.has(name), `${name} is named but not registered`).toBe(true);
    }
    const emitted = new Set(buildCostMethods().map(m => m.name));
    for (const name of COST_SPECIAL_METHOD_NAMES) {
      expect(emitted.has(name), `${name} has no schema`).toBe(true);
    }
    // And nothing is emitted that the names list does not claim.
    for (const name of emitted) {
      expect(COST_SPECIAL_METHOD_NAMES as readonly string[]).toContain(name);
    }
  });

  it('surfaces the typed SELECT branches in addIfcCostValue params, not a bare number', () => {
    const createNamespace = NAMESPACE_SCHEMAS.find(schema => schema.name === 'create')!;
    const value = createNamespace.methods.find(m => m.name === 'addIfcCostValue');
    expect(value).toBeDefined();
    expect(value!.args).toEqual(['number', 'dump']);
    expect(value!.paramNames).toEqual(['handle', 'params']);
    const paramsType = value!.tsParamTypes![1]!;
    // Script authors must see that AppliedValue is a typed measure, not a number.
    expect(paramsType).toContain("Type: 'IfcMonetaryMeasure'");
    expect(paramsType).toContain('AppliedValue?:');
    expect(paramsType).toContain('UnitBasis?: number');
    expect(paramsType).toContain('Components?: number[]');
    expect(paramsType).not.toMatch(/AppliedValue\?: number/);
    // The two traps this API can fall into are stated, not left implicit.
    const cautions = value!.llmSemantics?.cautions?.join(' ') ?? '';
    expect(cautions).toMatch(/two branches of one SELECT/);
    expect(cautions).toMatch(/UnitBasis/);
  });

  it('shapes the cost relationship aliases like their scheduling siblings', () => {
    const createNamespace = NAMESPACE_SCHEMAS.find(schema => schema.name === 'create')!;
    for (const [name, params] of [
      ['assignCostItemsToSchedule', ['handle', 'scheduleId', 'costItemIds']],
      ['assignCostItemsToProduct', ['handle', 'productId', 'costItemIds']],
      ['assignTasksToCostItem', ['handle', 'costItemId', 'taskIds']],
      ['nestCostItems', ['handle', 'parentCostItemId', 'childCostItemIds']],
    ] as const) {
      const method = createNamespace.methods.find(m => m.name === name);
      expect(method, `${name} missing`).toBeDefined();
      expect(method!.args).toEqual(['number', 'number', 'dump']);
      expect(method!.paramNames).toEqual([...params]);
      expect(method!.tsParamTypes).toEqual([undefined, undefined, 'number[]']);
      expect(method!.tsReturn).toBe('number');
    }
  });

  it('takes the currency as a string and never documents a default', () => {
    const createNamespace = NAMESPACE_SCHEMAS.find(schema => schema.name === 'create')!;
    const unit = createNamespace.methods.find(m => m.name === 'addIfcMonetaryUnit')!;
    expect(unit.args).toEqual(['number', 'string']);
    expect(unit.paramNames).toEqual(['handle', 'currency']);
    expect(unit.llmSemantics?.cautions?.join(' ')).toMatch(/no default currency/i);
  });
});

describe('bim.create cost authoring end-to-end through the sandbox (#4856)', () => {
  it('authors a nested breakdown with a typed value, a shared basis and a product link', async () => {
    const sandbox = await createSandbox({} as BimContext, {
      permissions: CREATE_ONLY_PERMISSIONS,
    });
    try {
      const script = `
        const h = bim.create.project({ Name: "Cost test", Currency: "CHF" });
        const storey = bim.create.addIfcBuildingStorey(h, { Name: "L0", Elevation: 0 });
        const wall = bim.create.addIfcWall(h, storey, {
          Name: "Wall", Start: [0,0,0], End: [4,0,0], Thickness: 0.3, Height: 3
        });
        const areaUnit = bim.create.addIfcSIUnit(h, { UnitType: "AREAUNIT", Name: "SQUARE_METRE" });
        const basis = bim.create.addIfcMeasureWithUnit(h, { Type: "IfcAreaMeasure", Value: 100 }, areaUnit);
        const rateA = bim.create.addIfcCostValue(h, {
          Name: "Rate A", AppliedValue: { Type: "IfcMonetaryMeasure", Value: 1234.56 }, UnitBasis: basis
        });
        const rateB = bim.create.addIfcCostValue(h, {
          Name: "Rate B", AppliedValue: { Type: "IfcMonetaryMeasure", Value: 87.375 }, UnitBasis: basis
        });
        const sum = bim.create.addIfcCostValue(h, {
          Name: "Sum", ArithmeticOperator: "ADD", Components: [rateA, rateB]
        });
        const qty = bim.create.addIfcPhysicalQuantity(h, {
          Kind: "IfcQuantityArea", Name: "NetArea", Value: 37.42, Unit: areaUnit
        });
        const child = bim.create.addIfcCostItem(h, {
          Name: "Formwork", CostValues: [rateA], CostQuantities: [qty]
        });
        const parent = bim.create.addIfcCostItem(h, { Name: "Concrete", CostValues: [sum] });
        const schedule = bim.create.addIfcCostSchedule(h, {
          Name: "BP3", PredefinedType: "PRICEDBILLOFQUANTITIES"
        });
        bim.create.nestCostItems(h, parent, [child]);
        bim.create.assignCostItemsToSchedule(h, schedule, [parent]);
        bim.create.assignCostItemsToProduct(h, wall, [child]);
        JSON.stringify({ content: bim.create.toIfc(h).content, wall: wall, child: child, basis: basis });
      `;
      const result = await sandbox.eval(script, { typescript: false });
      const { content, wall, child, basis } = JSON.parse(result.value as string) as {
        content: string; wall: number; child: number; basis: number;
      };

      expect(content).toContain('IFCCOSTSCHEDULE');
      expect(content).toContain('.PRICEDBILLOFQUANTITIES.');
      expect(content).toContain("'Formwork'");
      // The typed SELECT branch survives the bridge's marshalling.
      expect(content).toContain('IFCMONETARYMEASURE(1234.56)');
      expect(content).toContain('IFCMONETARYMEASURE(87.375)');
      expect(content).toContain("IFCMONETARYUNIT('CHF')");
      // The quantity value stays bare — it is a defined type, not a SELECT.
      expect(content).toContain(',37.42,$)');
      // One shared IfcMeasureWithUnit, referenced by both rates.
      const measures = content.split('\n').filter(l => l.includes('=IFCMEASUREWITHUNIT('));
      expect(measures).toHaveLength(1);
      expect(measures[0]).toContain(`#${basis}=IFCMEASUREWITHUNIT(IFCAREAMEASURE(100.),`);
      // The product link points the declared way round.
      expect(content).toMatch(new RegExp(
        `=IFCRELASSIGNSTOPRODUCT\\([^\\n]*\\(#${child}\\),\\$,#${wall}\\);`,
      ));
    } finally {
      await sandbox.dispose();
    }
  });

  it('surfaces the IFC2X3 refusal to the script author instead of writing nothing', async () => {
    const sandbox = await createSandbox({} as BimContext, {
      permissions: CREATE_ONLY_PERMISSIONS,
    });
    try {
      const result = await sandbox.eval(`
        const h = bim.create.project({ Name: "Legacy", Schema: "IFC2X3" });
        try {
          bim.create.addIfcCostItem(h, { Name: "Item" });
          "NO ERROR";
        } catch (e) { String(e && e.message || e); }
      `, { typescript: false });
      expect(String(result.value)).toMatch(/not supported for IFC2X3/);
    } finally {
      await sandbox.dispose();
    }
  });
});
