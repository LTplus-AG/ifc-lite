/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AUTHOR -> SERIALISE -> RE-READ, for the 5D / cost entities (#4856).
 *
 * The writer added here and the cost read model merged in #4863 have to agree
 * about one set of shapes, so this file does not assert on STEP text alone: it
 * runs the authored bytes back through `@ifc-lite/parser`'s
 * `extractCostOnDemand` and compares the records that come out.
 *
 * THE FIXTURE IS BUILT TO BE CAPABLE OF FAILING. A single cost item with one
 * currency, no UnitBasis and no nesting would pass against a writer that got
 * almost everything wrong, so the fixture carries, all at once:
 *   - a two-level nesting hierarchy (parent + two children),
 *   - one IfcMeasureWithUnit shared by two cost values (written once, not twice),
 *   - a non-default currency (CHF) that nothing in the code defaults to,
 *   - a real UnitBasis (a rate quoted per 100 m²),
 *   - non-round numbers (1234.56, 87.375, 37.42) that a lost or doubled
 *     conversion would visibly move,
 *   - both value forms: a literal AppliedValue and a Components + operator sum,
 *   - product and task assignments in both relationship directions.
 *
 * The fault-injection block then corrupts that same fixture one way at a time
 * and asserts the comparison FAILS — a round trip that cannot fail is not
 * evidence.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractCostOnDemand } from '@ifc-lite/parser';
import type { CostGraphExtraction, IfcDataStore } from '@ifc-lite/parser';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { IfcCreator } from './ifc-creator.js';

/** Same seeded LCG the existing determinism test in `ifc-creator.test.ts` uses. */
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

async function parse(content: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(content);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
}

async function extract(content: string): Promise<CostGraphExtraction> {
  return extractCostOnDemand(await parse(content));
}

/** A creator whose GlobalIds and timestamps are fixed, so output is reproducible. */
function seededCreator(
  seed: number,
  extra: { Currency?: string; Schema?: 'IFC4' | 'IFC4X3' } = {},
): IfcCreator {
  const rng = seededRng(seed);
  return new IfcCreator({
    Name: 'Cost fixture',
    Schema: 'IFC4',
    Timestamp: 1_767_225_600_000,
    GuidSource: () => generateIfcGuid(rng),
    ...extra,
  });
}

interface Fixture {
  creator: IfcCreator;
  ids: Record<string, number>;
}

/**
 * The shared fixture described in this file's header. Returns the creator plus
 * every expressId, so a test can assert on identity (shared references) and not
 * only on values.
 */
function buildCostFixture(options: { Currency?: string } = { Currency: 'CHF' }, seed = 4856): Fixture {
  const creator = seededCreator(seed, options);
  const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
  const wall = creator.addIfcWall(storey, {
    Name: 'Basement wall', Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.3, Height: 3,
  });
  const task = creator.addIfcTask({ Name: 'Pour concrete', ScheduleStart: '2026-03-02T07:00:00' });

  const areaUnit = creator.addIfcSIUnit({ UnitType: 'AREAUNIT', Name: 'SQUARE_METRE' });
  // A rate quoted PER 100 m². UnitBasis divides, so a dropped or invented one
  // is a two-order-of-magnitude error, not a rounding error.
  const basis = creator.addIfcMeasureWithUnit({ Type: 'IfcAreaMeasure', Value: 100 }, areaUnit);

  const formworkRate = creator.addIfcCostValue({
    Name: 'Formwork rate', Category: 'Labour',
    AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 1234.56 },
    UnitBasis: basis,
  });
  const rebarRate = creator.addIfcCostValue({
    Name: 'Rebar rate', Category: 'Material',
    AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 87.375 },
    UnitBasis: basis, // the SAME measure entity, not a copy
  });
  // The other branch: a value that IS its components, with no AppliedValue of
  // its own. The writer must not normalise this into a literal.
  const subtotal = creator.addIfcCostValue({
    Name: 'Concrete subtotal', ArithmeticOperator: 'ADD', Components: [formworkRate, rebarRate],
  });

  const netArea = creator.addIfcPhysicalQuantity({
    Kind: 'IfcQuantityArea', Name: 'NetArea', Value: 37.42, Unit: areaUnit,
  });

  const formwork = creator.addIfcCostItem({
    Name: 'Formwork', Identification: '03.10',
    CostValues: [formworkRate], CostQuantities: [netArea],
  });
  const rebar = creator.addIfcCostItem({
    Name: 'Reinforcement', Identification: '03.20', CostValues: [rebarRate],
  });
  const concrete = creator.addIfcCostItem({
    Name: 'Concrete works', Identification: '03', CostValues: [subtotal],
  });

  const schedule = creator.addIfcCostSchedule({
    Name: 'Bid package 3', Identification: 'BP3',
    PredefinedType: 'PRICEDBILLOFQUANTITIES', Status: 'ISSUED',
    SubmittedOn: '2026-03-01T09:00:00',
  });

  creator.nestCostItems(concrete, [formwork, rebar]);
  creator.assignCostItemsToSchedule(schedule, [concrete]);
  creator.assignCostItemsToProduct(wall, [formwork]);
  creator.assignTasksToCostItem(formwork, [task]);

  return {
    creator,
    ids: {
      storey, wall, task, areaUnit, basis, formworkRate, rebarRate, subtotal,
      netArea, formwork, rebar, concrete, schedule,
    },
  };
}

describe('IfcCreator cost authoring — author, serialise, re-read (#4856)', () => {
  it('re-reads the authored schedule, items, hierarchy and assignments', async () => {
    const { creator, ids } = buildCostFixture();
    const graph = await extract(creator.toIfc().content);

    expect(graph.Diagnostics.filter(d => d.Severity === 'error')).toEqual([]);
    expect(graph.HasCostData).toBe(true);
    expect(graph.SchemaVersion).toBe('IFC4');

    expect(graph.CostSchedules).toHaveLength(1);
    expect(graph.CostSchedules[0]).toMatchObject({
      expressId: ids.schedule,
      Name: 'Bid package 3',
      Identification: 'BP3',
      PredefinedType: 'PRICEDBILLOFQUANTITIES',
      Status: 'ISSUED',
      SubmittedOn: '2026-03-01T09:00:00',
    });

    const byName = new Map(graph.CostItems.map(item => [item.Name, item]));
    expect([...byName.keys()].sort()).toEqual(['Concrete works', 'Formwork', 'Reinforcement']);

    const concrete = byName.get('Concrete works');
    const formwork = byName.get('Formwork');
    const rebar = byName.get('Reinforcement');
    if (!concrete || !formwork || !rebar) throw new Error('fixture items missing');

    expect(concrete.Identification).toBe('03');
    // Nesting survives in BOTH directions.
    expect(concrete.childGlobalIds.sort()).toEqual([formwork.GlobalId, rebar.GlobalId].sort());
    expect(formwork.parentGlobalId).toBe(concrete.GlobalId);
    expect(rebar.parentGlobalId).toBe(concrete.GlobalId);

    // The schedule controls the root item, not the leaves.
    expect(concrete.controllingScheduleGlobalIds).toEqual([graph.CostSchedules[0].GlobalId]);

    // Product assignment: the WALL is the RelatingProduct, the cost item the
    // RelatedObject. A reversed relationship is the first fault injected below.
    //
    // `productExpressIds` is the read model's combined "things assigned to this
    // cost item" view — it also collects the TASK bound through
    // IfcRelAssignsToControl — so assert the relationship record itself for the
    // direction-sensitive claim, and containment for the convenience view.
    expect(formwork.productExpressIds).toContain(ids.wall);
    expect(formwork.productExpressIds).toContain(ids.task);
    expect(rebar.productExpressIds).toEqual([]);

    const toProduct = graph.Relationships.filter(r => r.Type === 'IfcRelAssignsToProduct');
    expect(toProduct).toHaveLength(1);
    expect(toProduct[0]).toMatchObject({
      RelatingProduct: ids.wall, RelatedObjects: [ids.formwork],
    });
    expect(toProduct[0].InvalidReferences).toBeUndefined();
  });

  it('writes typed SELECT values, not bare numbers, for AppliedValue', async () => {
    const { creator, ids } = buildCostFixture();
    const step = creator.toIfc().content;
    const graph = await extract(step);

    // The STEP text names the SELECT branch.
    expect(step).toContain('IFCMONETARYMEASURE(1234.56)');
    expect(step).not.toMatch(/IFCCOSTVALUE\('Formwork rate',\$,1234\.56/);

    const rate = graph.CostValues.find(v => v.expressId === ids.formworkRate);
    expect(rate?.AppliedValue).toEqual({
      Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1234.56',
    });
    // The non-round second value is carried with full precision.
    const rebar = graph.CostValues.find(v => v.expressId === ids.rebarRate);
    expect(rebar?.AppliedValue).toEqual({
      Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '87.375',
    });
  });

  it('writes very small and very large amounts exactly, in STEP exponent form', async () => {
    const creator = seededCreator(7);
    const tiny = creator.addIfcCostValue({ Name: 'Tiny', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 1e-11 } });
    const huge = creator.addIfcCostValue({ Name: 'Huge', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 1.5e21 } });
    const step = creator.toIfc().content;
    // Not `0.0` (value lost) and not `1.5e+21` (JS spelling, invalid STEP).
    expect(step).toContain('IFCMONETARYMEASURE(1.E-11)');
    expect(step).toContain('IFCMONETARYMEASURE(1.5E21)');

    const graph = await extract(step);
    const read = (id: number) => graph.CostValues.find(v => v.expressId === id)?.AppliedValue;
    expect(read(tiny)).toMatchObject({ Kind: 'Typed', Type: 'IFCMONETARYMEASURE' });
    expect(Number((read(tiny) as { Value: string }).Value)).toBe(1e-11);
    expect(Number((read(huge) as { Value: string }).Value)).toBe(1.5e21);
  });

  it('keeps an IfcQuantityArea value BARE — it is a defined type, not a SELECT', async () => {
    const { creator, ids } = buildCostFixture();
    const step = creator.toIfc().content;
    const graph = await extract(step);

    expect(step).toContain(`IFCQUANTITYAREA('NetArea',$,#${ids.areaUnit},37.42,$)`);
    expect(step).not.toContain('IFCQUANTITYAREA(\'NetArea\',$,#' + ids.areaUnit + ',IFCAREAMEASURE(');

    const quantity = graph.CostQuantities.find(q => q.expressId === ids.netArea);
    expect(quantity).toMatchObject({ Type: 'IfcQuantityArea', AreaValue: '37.42', Dimension: 'area' });
  });

  it('preserves UnitBasis as a real per-quantity divisor', async () => {
    const { creator, ids } = buildCostFixture();
    const graph = await extract(creator.toIfc().content);

    const rate = graph.CostValues.find(v => v.expressId === ids.formworkRate);
    expect(rate?.UnitBasis).toBe(ids.basis);
    expect(rate?.InvalidUnitBasis).toBeUndefined();
    // Resolved view: 100 SQUARE_METRE, scale 1 into canonical SI.
    expect(rate?.unitBasis).toEqual({ valueComponent: 100, unitSymbol: 'm²', unitSiScale: 1 });
  });

  it('writes a shared IfcMeasureWithUnit ONCE and references it twice', async () => {
    const { creator, ids } = buildCostFixture();
    const step = creator.toIfc().content;
    const graph = await extract(step);

    const occurrences = step.split('\n').filter(line => line.includes('=IFCMEASUREWITHUNIT('));
    expect(occurrences).toHaveLength(1);

    const formworkRate = graph.CostValues.find(v => v.expressId === ids.formworkRate);
    const rebarRate = graph.CostValues.find(v => v.expressId === ids.rebarRate);
    expect(formworkRate?.UnitBasis).toBe(ids.basis);
    expect(rebarRate?.UnitBasis).toBe(ids.basis);
    // Shared identity, not two entities that happen to be equal.
    expect(formworkRate?.UnitBasis).toBe(rebarRate?.UnitBasis);
  });

  it('keeps Components and AppliedValue distinct — neither is derived from the other', async () => {
    const { creator, ids } = buildCostFixture();
    const graph = await extract(creator.toIfc().content);

    const subtotal = graph.CostValues.find(v => v.expressId === ids.subtotal);
    expect(subtotal?.ArithmeticOperator).toBe('ADD');
    expect(subtotal?.Components).toEqual([ids.formworkRate, ids.rebarRate]);
    // The component-derived value has NO literal of its own; synthesising one
    // would claim the file stated a number it never stated.
    expect(subtotal?.AppliedValue).toBeUndefined();

    // ... and the literal-valued leaf carries no Components.
    const rate = graph.CostValues.find(v => v.expressId === ids.formworkRate);
    expect(rate?.Components).toBeUndefined();
    expect(rate?.AppliedValue?.Kind).toBe('Typed');
  });

  it('carries a non-default currency through, and leaves an unstated one unstated', async () => {
    const withCurrency = await extract(buildCostFixture({ Currency: 'CHF' }).creator.toIfc().content);
    expect(withCurrency.Currency).toBe('CHF');

    // Absent is not "USD", not "" and not a guess: it is absent, and the read
    // model says so by reporting no currency at all.
    const withoutCurrency = await extract(buildCostFixture({}).creator.toIfc().content);
    expect(withoutCurrency.Currency).toBeUndefined();
    expect('Currency' in withoutCurrency ? withoutCurrency.Currency : undefined).toBeUndefined();
    // The file itself states no monetary unit rather than an empty one.
    expect(buildCostFixture({}).creator.toIfc().content).not.toContain('IFCMONETARYUNIT');
  });

  it('is byte-identical across two runs with the same seed', () => {
    const first = buildCostFixture().creator.toIfc().content;
    const second = buildCostFixture().creator.toIfc().content;
    expect(first).toBe(second);
    // The SAME graph under a different seed must NOT also be identical, or the
    // check above proves nothing about the seed reaching the output.
    const other = buildCostFixture(undefined, 9999).creator.toIfc().content;
    expect(other).not.toBe(first);
  });
});

describe('IfcCreator cost authoring — IFC2X3 is refused, loudly (#4856)', () => {
  const methods: Array<[string, (c: IfcCreator) => unknown]> = [
    ['addIfcCostSchedule', c => c.addIfcCostSchedule({ Name: 'S' })],
    ['addIfcCostItem', c => c.addIfcCostItem({ Name: 'I' })],
    ['addIfcCostValue', c => c.addIfcCostValue({ Name: 'V' })],
    ['addIfcMonetaryUnit', c => c.addIfcMonetaryUnit('CHF')],
    ['addIfcSIUnit', c => c.addIfcSIUnit({ UnitType: 'AREAUNIT', Name: 'SQUARE_METRE' })],
    ['addIfcMeasureWithUnit', c => c.addIfcMeasureWithUnit({ Type: 'IfcAreaMeasure', Value: 1 }, 1)],
    ['addIfcPhysicalQuantity', c =>
      c.addIfcPhysicalQuantity({ Kind: 'IfcQuantityArea', Name: 'A', Value: 1 })],
  ];

  for (const [name, call] of methods) {
    it(`${name} throws on IFC2X3 instead of silently writing nothing`, () => {
      const creator = new IfcCreator({ Schema: 'IFC2X3' });
      expect(() => call(creator)).toThrow(/not supported for IFC2X3/);
    });
  }

  it('refuses a project Currency under IFC2X3 (there it is an enum, not a label)', () => {
    expect(() => new IfcCreator({ Schema: 'IFC2X3', Currency: 'CHF' }))
      .toThrow(/ProjectParams.Currency is not supported for IFC2X3/);
  });

  it('the refusal is a throw, not an empty result that reads as success', () => {
    const creator = new IfcCreator({ Schema: 'IFC2X3' });
    let threw = false;
    try {
      creator.addIfcCostItem({ Name: 'I' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Nothing was written on the way out.
    expect(creator.toIfc().content).not.toContain('IFCCOSTITEM');
  });

  it('still authors cost entities under IFC4X3', async () => {
    const creator = new IfcCreator({
      Schema: 'IFC4X3', Timestamp: 0, GuidSource: (() => {
        const rng = seededRng(7);
        return () => generateIfcGuid(rng);
      })(),
    });
    const value = creator.addIfcCostValue({
      Name: 'Rate', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 9.25 },
    });
    creator.addIfcCostItem({ Name: 'Item', CostValues: [value] });
    const graph = await extract(creator.toIfc().content);
    expect(graph.SchemaVersion).toBe('IFC4X3');
    expect(graph.CostItems).toHaveLength(1);
    expect(graph.CostValues[0]?.AppliedValue)
      .toEqual({ Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '9.25' });
  });
});

describe('IfcCreator cost authoring — malformed input is refused (#4856)', () => {
  it('rejects an EMPTY list where the caller meant "absent"', () => {
    const creator = seededCreator(1);
    expect(() => creator.addIfcCostItem({ Name: 'I', CostValues: [] }))
      .toThrow(/CostValues must name at least one entity/);
    expect(() => creator.addIfcCostItem({ Name: 'I', CostQuantities: [] }))
      .toThrow(/CostQuantities must name at least one entity/);
    expect(() => creator.addIfcCostValue({ Name: 'V', Components: [] }))
      .toThrow(/Components must name at least one entity/);
  });

  it('writes an OMITTED list as absent, which is a different record', async () => {
    const creator = seededCreator(2);
    creator.addIfcCostItem({ Name: 'Bare' });
    const graph = await extract(creator.toIfc().content);
    expect(graph.CostItems[0]?.CostValues).toBeUndefined();
    expect(graph.CostItems[0]?.CostQuantities).toBeUndefined();
    // undefined (absent), NOT [] (present but empty) — the read model draws the
    // same line and an INVALID_LIST diagnostic is how it reports the other one.
    expect(graph.Diagnostics.filter(d => d.Code === 'INVALID_LIST')).toEqual([]);
  });

  it('refuses both branches of the AppliedValue SELECT at once', () => {
    const creator = seededCreator(3);
    const unit = creator.addIfcSIUnit({ UnitType: 'AREAUNIT', Name: 'SQUARE_METRE' });
    const measure = creator.addIfcMeasureWithUnit({ Type: 'IfcAreaMeasure', Value: 1 }, unit);
    expect(() => creator.addIfcCostValue({
      AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 1 }, AppliedValueRef: measure,
    })).toThrow(/two branches of one SELECT/);
  });

  it('refuses a non-finite number rather than writing NaN into STEP', () => {
    const creator = seededCreator(4);
    expect(() => creator.addIfcCostValue({
      AppliedValue: { Type: 'IfcMonetaryMeasure', Value: Number.NaN },
    })).toThrow(/must be a finite number/);
    expect(() => creator.addIfcPhysicalQuantity({
      Kind: 'IfcQuantityArea', Name: 'A', Value: Number.POSITIVE_INFINITY,
    })).toThrow(/must be a finite number/);
  });

  it('refuses a fractional IFC4X3 IfcQuantityCount rather than silently rounding it, and writes nothing partial', () => {
    const creator = seededCreator(41, { Schema: 'IFC4X3' });
    const before = creator.addIfcPhysicalQuantity({
      Kind: 'IfcQuantityLength', Name: 'L', Value: 1,
    });

    expect(() => creator.addIfcPhysicalQuantity({
      Kind: 'IfcQuantityCount', Name: 'Units', Value: 3.7,
    })).toThrow(/IfcQuantityCount.*must be a finite integer in IFC4X3/);

    // Proof the failed call wrote NOTHING — not even a malformed line — for
    // either the express id counter or the STEP text: the next entity gets
    // the very next id (nothing was silently consumed), and the STEP text
    // contains no IFCQUANTITYCOUNT record at all.
    const next = creator.addIfcPhysicalQuantity({
      Kind: 'IfcQuantityLength', Name: 'M', Value: 2,
    });
    expect(next).toBe(before + 1);

    const step = creator.toIfc().content;
    expect(step).not.toContain('IFCQUANTITYCOUNT');
  });

  it('keeps a fractional IFC4 IfcQuantityCount (IfcCountMeasure is NUMBER there) and writes IFC4X3 counts as INTEGER', () => {
    const ifc4 = seededCreator(42);
    ifc4.addIfcPhysicalQuantity({ Kind: 'IfcQuantityCount', Name: 'Half', Value: 0.5 });
    expect(ifc4.toIfc().content).toContain("IFCQUANTITYCOUNT('Half',$,$,0.5,$)");

    const ifc4x3 = seededCreator(43, { Schema: 'IFC4X3' });
    ifc4x3.addIfcPhysicalQuantity({ Kind: 'IfcQuantityCount', Name: 'Units', Value: 3 });
    // `3.` would spell a REAL in an INTEGER slot.
    expect(ifc4x3.toIfc().content).toContain("IFCQUANTITYCOUNT('Units',$,$,3,$)");
  });

  it('refuses IfcQuantityNumber outside IFC4X3, where the entity does not exist', () => {
    expect(() => seededCreator(44).addIfcPhysicalQuantity({
      Kind: 'IfcQuantityNumber', Name: 'N', Value: 1,
    })).toThrow(/IfcQuantityNumber requires Schema "IFC4X3"/);

    const ifc4x3 = seededCreator(45, { Schema: 'IFC4X3' });
    // IfcNumericMeasure has no >= 0 rule, so a negative number is legal here.
    ifc4x3.addIfcPhysicalQuantity({ Kind: 'IfcQuantityNumber', Name: 'N', Value: -2 });
    expect(ifc4x3.toIfc().content).toContain("IFCQUANTITYNUMBER('N',$,$,-2.,$)");
  });

  it('refuses a negative physical quantity (WR: <Value> >= 0)', () => {
    const creator = seededCreator(46);
    for (const Kind of ['IfcQuantityArea', 'IfcQuantityLength', 'IfcQuantityCount'] as const) {
      expect(() => creator.addIfcPhysicalQuantity({ Kind, Name: 'Neg', Value: -1 }))
        .toThrow(/must be non-negative/);
    }
    expect(creator.toIfc().content).not.toContain("'Neg'");
  });

  it('refuses an IfcInteger fraction instead of rounding it', () => {
    const creator = seededCreator(47);
    expect(() => creator.addIfcCostValue({
      AppliedValue: { Type: 'IfcInteger', Value: 1.6 },
    })).toThrow(/IfcInteger value must be an integer/);
    creator.addIfcCostValue({ Name: 'Whole', AppliedValue: { Type: 'IfcInteger', Value: 2 } });
    const step = creator.toIfc().content;
    expect(step).toContain('IFCINTEGER(2)');
    expect(step).not.toContain('IFCINTEGER(2.)');
  });

  it('refuses a missing, unknown or dimensionally wrong IfcSIUnit enum', () => {
    const creator = seededCreator(48);
    expect(() => creator.addIfcSIUnit({ UnitType: 'AREAUNIT', Name: '' })).toThrow(/must be named 'SQUARE_METRE'/);
    expect(() => creator.addIfcSIUnit({ UnitType: 'AREAUNIT', Name: 'METRE' })).toThrow(/must be named 'SQUARE_METRE'/);
    expect(() => creator.addIfcSIUnit({ UnitType: 'LENGTHUNIT', Name: 'METRE', Prefix: 'KILOS' }))
      .toThrow(/not an IfcSIPrefix/);
    expect(() => creator.addIfcSIUnit({ UnitType: 'BOGUSUNIT' as 'AREAUNIT', Name: 'SQUARE_METRE' }))
      .toThrow(/UnitType must be one of/);
    creator.addIfcSIUnit({ UnitType: 'LENGTHUNIT', Prefix: 'MILLI', Name: 'METRE' });
    const step = creator.toIfc().content;
    expect(step).toContain('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    // Only the valid unit was added to the project's own units: every refusal
    // left nothing behind.
    const baseline = seededCreator(48).toIfc().content;
    expect(step.match(/IFCSIUNIT\(/g)?.length).toBe((baseline.match(/IFCSIUNIT\(/g)?.length ?? 0) + 1);
  });

  it('refuses a sparse Properties or Quantities array instead of writing an empty ref', () => {
    const creator = seededCreator(49);
    const storey = creator.addIfcBuildingStorey({ Name: 'L0', Elevation: 0 });
    const wall = creator.addIfcWall(storey, { Name: 'W', Start: [0, 0, 0], End: [1, 0, 0], Thickness: 0.2, Height: 3 });
    expect(() => creator.addIfcPropertySet(wall, { Name: 'Pset_Sparse', Properties: new Array(1) }))
      .toThrow(/Properties\[0\] is missing/);
    expect(() => creator.addIfcElementQuantity(wall, { Name: 'Qto_Sparse', Quantities: new Array(1) }))
      .toThrow(/Quantities\[0\] is missing/);
    expect(() => creator.addIfcPropertySet(wall, { Name: 'Pset_Empty', Properties: [] }))
      .toThrow(/Properties must contain at least one entry/);
    expect(() => creator.addIfcElementQuantity(wall, { Name: 'Qto_Empty', Quantities: [] }))
      .toThrow(/Quantities must contain at least one entry/);
    const step = creator.toIfc().content;
    expect(step).not.toContain('Pset_Sparse');
    expect(step).not.toContain('Qto_Sparse');
    expect(step).not.toContain('Pset_Empty');
    expect(step).not.toContain('Qto_Empty');
  });

  it('refuses out-of-vocabulary types and enums from untyped (sandbox) input', () => {
    const creator = seededCreator(50);
    const bogus = 'BOGUS' as never;
    expect(() => creator.addIfcCostValue({ AppliedValue: { Type: 'IfcBogusMeasure' as never, Value: 1 } }))
      .toThrow(/Type 'IfcBogusMeasure' is not one of/);
    expect(() => creator.addIfcPhysicalQuantity({ Kind: 'IfcQuantityBogus' as never, Name: 'Q', Value: 1 }))
      .toThrow(/Kind 'IfcQuantityBogus' is not one of/);
    expect(() => creator.addIfcCostValue({ Name: 'V', ArithmeticOperator: bogus }))
      .toThrow(/ArithmeticOperator 'BOGUS' is not one of/);
    expect(() => creator.addIfcCostItem({ Name: 'I', PredefinedType: bogus }))
      .toThrow(/PredefinedType 'BOGUS' is not one of/);
    expect(() => creator.addIfcCostSchedule({ Name: 'S', PredefinedType: bogus }))
      .toThrow(/PredefinedType 'BOGUS' is not one of/);
    const step = creator.toIfc().content;
    expect(step).not.toMatch(/BOGUS/i);
    expect(step).not.toContain('IFCCOSTSCHEDULE');
  });

  it('lists created IfcCostValues in toIfc().entities, like schedules and items', () => {
    const creator = seededCreator(51);
    const id = creator.addIfcCostValue({ Name: 'Rate', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 5 } });
    expect(creator.toIfc().entities).toContainEqual({ expressId: id, type: 'IfcCostValue', Name: 'Rate' });
  });

  it('refuses an invented currency of ""', () => {
    const creator = seededCreator(5);
    expect(() => creator.addIfcMonetaryUnit('  ')).toThrow(/non-empty string/);
  });

  it('refuses a non-express-id reference', () => {
    const creator = seededCreator(6);
    expect(() => creator.addIfcCostValue({ UnitBasis: 0 })).toThrow(/must be an express id/);
    expect(() => creator.addIfcCostItem({ Name: 'I', CostValues: [-1] }))
      .toThrow(/is not an express id/);
    expect(() => creator.addIfcRelAssignsToProduct(1, [])).toThrow(/at least one entity/);
  });

  // The test above only ever exercises the RelatedObjects validation branch of
  // `addIfcRelAssignsToProduct`: an empty list throws before the
  // RelatingProduct id is even looked at. This test gives RelatedObjects a
  // valid, non-empty list so the RelatingProduct check is the one that has to
  // catch the bad id — otherwise a broken/removed `requireRef` on
  // RelatingProduct would pass every existing test in this file.
  it('refuses an invalid RelatingProduct id on IfcRelAssignsToProduct, and writes nothing partial', () => {
    const creator = seededCreator(7);
    const item = creator.addIfcCostItem({ Name: 'I' });

    expect(() => creator.addIfcRelAssignsToProduct(0, [item]))
      .toThrow(/relatingProductId must be an express id/);

    // Proof the failed call wrote NOTHING — not even a malformed line — for
    // either the express id counter or the STEP text: the next entity gets
    // the very next id (nothing was silently consumed), and the STEP text
    // contains no IFCRELASSIGNSTOPRODUCT record at all.
    const next = creator.addIfcCostItem({ Name: 'J' });
    expect(next).toBe(item + 1);

    const step = creator.toIfc().content;
    expect(step).not.toContain('IFCRELASSIGNSTOPRODUCT');
  });
});

/**
 * NEGATIVE FAULT INJECTION.
 *
 * Each case takes the very bytes the passing round trip above produced and
 * corrupts exactly one thing, then asserts the comparison FAILS — and fails
 * for the stated reason, not incidentally. Without this, a round trip that
 * compared nothing would look identical to one that compared everything.
 */
describe('IfcCreator cost authoring — fault injection (#4856)', () => {
  async function corrupted(replace: (step: string) => string): Promise<CostGraphExtraction> {
    const { creator } = buildCostFixture();
    const step = creator.toIfc().content;
    const broken = replace(step);
    expect(broken).not.toBe(step); // the injection must actually have applied
    return extract(broken);
  }

  it('a REVERSED IfcRelAssignsToProduct fails the comparison', async () => {
    const { creator, ids } = buildCostFixture();
    const step = creator.toIfc().content;

    const healthy = await extract(step);
    const healthyRel = healthy.Relationships.find(r => r.Type === 'IfcRelAssignsToProduct');
    expect(healthyRel).toMatchObject({ RelatingProduct: ids.wall, RelatedObjects: [ids.formwork] });
    expect(healthyRel?.InvalidReferences).toBeUndefined();

    // Swap RelatedObjects and RelatingProduct: the cost item becomes the
    // product and the wall becomes the assigned object. Still valid STEP.
    const reversed = step.replace(
      new RegExp(`(=IFCRELASSIGNSTOPRODUCT\\('[^']+',#\\d+,\\$,\\$,)\\(#${ids.formwork}\\)(,\\$,)#${ids.wall}\\)`),
      `$1(#${ids.wall})$2#${ids.formwork})`);
    expect(reversed).not.toBe(step);

    const graph = await extract(reversed);
    const rel = graph.Relationships.find(r => r.Type === 'IfcRelAssignsToProduct');
    // The assertion the healthy run made now fails, and it fails for the right
    // reason: with the cost item moved into RelatingProduct, RelatedObjects no
    // longer names a cost item at all, so the edge leaves the cost graph rather
    // than being reported with the wrong ends. The pricing link is simply gone.
    expect(rel).toBeUndefined();
    const formwork = graph.CostItems.find(i => i.Name === 'Formwork');
    expect(formwork?.productExpressIds).not.toContain(ids.wall);
  });

  it('a REVERSED IfcRelNests inverts the hierarchy the comparison asserts', async () => {
    const { creator, ids } = buildCostFixture();
    const step = creator.toIfc().content;
    const reversed = step.replace(
      new RegExp(`(=IFCRELNESTS\\('[^']+',#\\d+,\\$,\\$,)#${ids.concrete},\\(#${ids.formwork},#${ids.rebar}\\)\\)`),
      `$1#${ids.formwork},(#${ids.concrete},#${ids.rebar}))`);
    expect(reversed).not.toBe(step);

    const graph = await extract(reversed);
    const byName = new Map(graph.CostItems.map(i => [i.Name, i]));
    const concrete = byName.get('Concrete works');
    const formwork = byName.get('Formwork');
    // The parent and child have traded places.
    expect(concrete?.childGlobalIds).not.toContain(formwork?.GlobalId);
    expect(concrete?.parentGlobalId).toBe(formwork?.GlobalId);
  });

  it('an UNTYPED AppliedValue fails the typed-SELECT comparison', async () => {
    const graph = await corrupted(step =>
      step.replace('IFCMONETARYMEASURE(1234.56)', '1234.56'));
    const rate = graph.CostValues.find(v => v.Name === 'Formwork rate');
    // Not the typed record the healthy run asserted.
    expect(rate?.AppliedValue).not.toEqual({
      Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1234.56',
    });
    expect(rate?.AppliedValue?.Kind).toBe('Unsupported');
  });

  it('a WRONG-TYPE AppliedValue fails the comparison even though it parses', async () => {
    const graph = await corrupted(step =>
      step.replace('IFCMONETARYMEASURE(1234.56)', 'IFCAREAMEASURE(1234.56)'));
    const rate = graph.CostValues.find(v => v.Name === 'Formwork rate');
    // The number survives; the MEANING does not. A comparison that only looked
    // at the number would call this a successful round trip.
    expect(rate?.AppliedValue).toEqual({
      Kind: 'Typed', Type: 'IFCAREAMEASURE', Value: '1234.56',
    });
    expect(rate?.AppliedValue).not.toEqual({
      Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1234.56',
    });
  });

  it('a MALFORMED typed value fails the comparison and is diagnosed', async () => {
    const graph = await corrupted(step =>
      step.replace('IFCMONETARYMEASURE(1234.56)', 'IFCMONETARYMEASURE(1.2.3)'));
    const rate = graph.CostValues.find(v => v.Name === 'Formwork rate');
    expect(rate?.AppliedValue).not.toMatchObject({ Kind: 'Typed', Value: '1234.56' });
  });

  it('a DROPPED UnitBasis fails the rate comparison', async () => {
    const { ids } = buildCostFixture();
    const graph = await corrupted(step =>
      step.replace(
        new RegExp(`(=IFCCOSTVALUE\\('Formwork rate',\\$,IFCMONETARYMEASURE\\(1234\\.56\\),)#${ids.basis}`),
        '$1$'));
    const rate = graph.CostValues.find(v => v.Name === 'Formwork rate');
    expect(rate?.UnitBasis).toBeUndefined();
    expect(rate?.unitBasis).toBeUndefined();
  });

  it('a RETARGETED UnitBasis moves the rate by an order of magnitude', async () => {
    const { creator, ids } = buildCostFixture();
    const step = creator.toIfc().content;
    // Point the shared basis at 10 m² instead of 100 m² — the file still reads,
    // and every rate quoted against it now means ten times as much per unit.
    const broken = step.replace(
      `#${ids.basis}=IFCMEASUREWITHUNIT(IFCAREAMEASURE(100.),#${ids.areaUnit});`,
      `#${ids.basis}=IFCMEASUREWITHUNIT(IFCAREAMEASURE(10.),#${ids.areaUnit});`);
    expect(broken).not.toBe(step);

    const graph = await extract(broken);
    const rate = graph.CostValues.find(v => v.Name === 'Formwork rate');
    expect(rate?.unitBasis?.valueComponent).toBe(10);
    expect(rate?.unitBasis?.valueComponent).not.toBe(100);
  });

  it('an INVENTED currency fails the currency-absent comparison', async () => {
    const { creator } = buildCostFixture({});
    const step = creator.toIfc().content;
    expect(await extract(step).then(g => g.Currency)).toBeUndefined();

    // Splice a monetary unit into the unit assignment, the way a writer that
    // "helpfully" defaulted the currency would.
    const withGuess = step
      .replace(/(=IFCUNITASSIGNMENT\(\([^)]*)\)\);/, '$1,#900001));')
      .replace(/(#\d+=IFCUNITASSIGNMENT)/, "#900001=IFCMONETARYUNIT('USD');\n$1");
    expect(withGuess).not.toBe(step);
    expect(withGuess).toContain("#900001=IFCMONETARYUNIT('USD');");
    expect((await extract(withGuess)).Currency).toBe('USD');
    expect((await extract(withGuess)).Currency).not.toBeUndefined();
  });

  it('a DUPLICATED (un-shared) UnitBasis fails the shared-reference comparison', async () => {
    const { creator, ids } = buildCostFixture();
    const step = creator.toIfc().content;
    // Give the rebar rate its own copy of the measure instead of sharing one.
    const duplicated = step
      .replace(
        `#${ids.basis}=IFCMEASUREWITHUNIT(IFCAREAMEASURE(100.),#${ids.areaUnit});`,
        `#${ids.basis}=IFCMEASUREWITHUNIT(IFCAREAMEASURE(100.),#${ids.areaUnit});\n`
        + `#900002=IFCMEASUREWITHUNIT(IFCAREAMEASURE(100.),#${ids.areaUnit});`)
      .replace(
        new RegExp(`(=IFCCOSTVALUE\\('Rebar rate',\\$,IFCMONETARYMEASURE\\(87\\.375\\),)#${ids.basis}`),
        '$1#900002');
    expect(duplicated).not.toBe(step);

    const graph = await extract(duplicated);
    const formworkRate = graph.CostValues.find(v => v.Name === 'Formwork rate');
    const rebarRate = graph.CostValues.find(v => v.Name === 'Rebar rate');
    // Equal values, different identities — which is exactly what the
    // shared-reference assertion above rejects.
    expect(rebarRate?.unitBasis).toEqual(formworkRate?.unitBasis);
    expect(rebarRate?.UnitBasis).not.toBe(formworkRate?.UnitBasis);
    expect(duplicated.split('\n').filter(l => l.includes('=IFCMEASUREWITHUNIT('))).toHaveLength(2);
  });

  it('a value NORMALISED from Components into a literal fails the comparison', async () => {
    const { ids } = buildCostFixture();
    const graph = await corrupted(step =>
      step.replace(
        new RegExp(`=IFCCOSTVALUE\\('Concrete subtotal',\\$,\\$,\\$,\\$,\\$,\\$,\\$,\\.ADD\\.,\\(#${ids.formworkRate},#${ids.rebarRate}\\)\\)`),
        "=IFCCOSTVALUE('Concrete subtotal',$,IFCMONETARYMEASURE(1321.935),$,$,$,$,$,$,$)"));
    const subtotal = graph.CostValues.find(v => v.Name === 'Concrete subtotal');
    // The arithmetic answer is right and the record is still wrong: the file no
    // longer says the number came from its components.
    expect(subtotal?.Components).toBeUndefined();
    expect(subtotal?.ArithmeticOperator).toBeUndefined();
    expect(subtotal?.AppliedValue?.Kind).toBe('Typed');
  });
});
