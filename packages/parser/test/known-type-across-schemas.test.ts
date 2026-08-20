/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `isKnownType` / `normalizeIfcTypeName` answer for every bundled IFC schema,
 * not just the IFC4_ADD2_TC1 codegen pin (#2003).
 *
 * These two were the last surface still reading the pin alone after #2001 and
 * #2014 fixed `diff`, `validate` and the MCP tools. `@ifc-lite/sdk` registers
 * them as the entity-type normalizer for `@ifc-lite/mutations`, so a `false`
 * here is not a degraded answer — it is `addEntity` refusing to author the
 * class at all. On main that rejected roughly 251 real classes: the IFC2X3
 * ones IFC4 dropped (`IfcMove`, `IfcScheduleTimeControl`) and the IFC4X3
 * infrastructure ones it never had (`IfcRoad`, `IfcSignal`).
 *
 * The guard still has to reject typos — that is the reason it exists — so both
 * directions are asserted here, and widening it to "accept anything" fails.
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, IFC_DATA_TYPES } from '@ifc-lite/data';
import { SCHEMA_REGISTRY, getEntityMetadata } from '../src/generated/schema-registry.js';
import { isKnownType, normalizeIfcTypeName, getInheritanceChain } from '../src/ifc-schema.js';

/**
 * The six EXPRESS TYPEs the IDS-derived `IFC_DATA_TYPES` table omits but the
 * pin's own `SCHEMA_REGISTRY.types` map carries. They ride along in the bundled
 * `ENTITIES_*` tables as if they were classes.
 */
const TYPES_ONLY_IN_THE_PIN = [
  'IfcBinary',
  'IfcArcIndex',
  'IfcLineIndex',
  'IfcComplexNumber',
  'IfcCompoundPlaneAngleMeasure',
  'IfcPropertySetDefinitionSet',
];

/** Classes that exist only in IFC2X3 — dropped by IFC4, so absent from the pin. */
const IFC2X3_ONLY = [
  'IfcMove',
  'IfcOrderAction',
  'IfcScheduleTimeControl',
  'IfcSpaceProgram',
  'IfcServiceLife',
  'IfcTimeSeriesSchedule',
  'IfcConditionCriterion',
];

/** IFC4X3 infrastructure classes the IFC4 pin never had. */
const IFC4X3_ONLY = [
  'IfcRoad',
  'IfcSignal',
  'IfcAlignment',
  'IfcRailway',
  'IfcMarineFacility',
  'IfcCourse',
  'IfcPavement',
];

const PINNED: string[] = Object.keys(SCHEMA_REGISTRY.entities);

const UNION_NAMES: string[] = [
  ...new Map(
    [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]
      .flatMap((list) => list.map((entity) => [entity.name.toUpperCase(), entity.name] as const)),
  ).values(),
];

const UNION_UPPER_LIST: string[] = UNION_NAMES.map((name) => name.toUpperCase());

const UNION_UPPER = new Set(UNION_UPPER_LIST);

/**
 * Every name the two authoritative tables classify as something other than an
 * EXPRESS ENTITY: the cross-schema IDS table plus the pin's own TYPE / ENUM /
 * SELECT maps. This is the set `getEntityInfoAcrossSchemas` subtracts.
 */
const NON_ENTITIES = new Set([
  ...IFC_DATA_TYPES.map((t) => t.name.toUpperCase()),
  ...Object.keys(SCHEMA_REGISTRY.types).map((n) => n.toUpperCase()),
  ...Object.keys(SCHEMA_REGISTRY.enums).map((n) => n.toUpperCase()),
  ...Object.keys(SCHEMA_REGISTRY.selects).map((n) => n.toUpperCase()),
]);

describe('isKnownType across the bundled schema union (#2003)', () => {
  it('accepts IFC2X3-only classes the IFC4 pin dropped', () => {
    for (const type of IFC2X3_ONLY) {
      // Guard the premise: if the pin ever grows these, this test stops
      // measuring what it claims to measure.
      expect(getEntityMetadata(type), `${type} unexpectedly in the pin`).toBeUndefined();
      expect(isKnownType(type), type).toBe(true);
    }
  });

  it('accepts IFC4X3-only classes the IFC4 pin never had', () => {
    for (const type of IFC4X3_ONLY) {
      expect(getEntityMetadata(type), `${type} unexpectedly in the pin`).toBeUndefined();
      expect(isKnownType(type), type).toBe(true);
    }
  });

  it('accepts every class in the pin (no IFC4 regression)', () => {
    const rejected = PINNED.filter((type) => !isKnownType(type));
    expect(rejected).toEqual([]);
  });

  it('resolves the whole pin from the union alone, so the pin fallback stays unreachable', () => {
    // The assertion above cannot tell which source answered: `isKnownType`
    // falls back to the pin, so every pinned class comes back `true` even if
    // the union lost it. Read the tables directly, the same way
    // `inheritance-chain-equivalence.test.ts` does, or the "no IFC4
    // regression" claim is true by construction.
    //
    // The fallback is not dead weight even so: it is what keeps a pinned class
    // accepted if a future regenerated non-entity table ever named one, which
    // is exactly the case the subtraction above would otherwise break.
    const unresolvable = PINNED.filter(
      (type) => !UNION_UPPER.has(type.toUpperCase()) || NON_ENTITIES.has(type.toUpperCase()),
    );
    expect(unresolvable).toEqual([]);
  });

  it('still rejects typos, near-misses and vendor extensions', () => {
    // The whole reason the guard exists. A one-character slip off a real class
    // in each of the three schemas, plus a plausible-looking invention.
    const typos = [
      'IfcWal',
      'IfcWalll',
      'IfcRoadd',
      'IfcRoa',
      'IfcMov',
      'IfcMovee',
      'IfcSpaceProgramm',
      'IfcAcmeVendorExtension',
      'IfcBuildingElementWidget',
      'Wall',
      'IFC',
      '',
    ];
    for (const type of typos) {
      expect(isKnownType(type), type).toBe(false);
    }
  });

  it('rejects EXPRESS defined types that ride along in the bundled entity tables', () => {
    // The `ENTITIES_*` tables carry `IfcLengthMeasure`, `IfcBoolean` and 130
    // other defined types as rows. They are not instantiable, the pin has
    // always answered `false` for them, and widening the union lookup without
    // subtracting them would flip that.
    for (const type of ['IfcLengthMeasure', 'IfcBoolean', 'IfcCountMeasure', 'IfcTextAlignment', 'IfcPositiveLengthMeasure']) {
      expect(NON_ENTITIES.has(type.toUpperCase()), `${type} should be a non-entity`).toBe(true);
      expect(isKnownType(type), type).toBe(false);
    }
  });

  it('rejects the six EXPRESS TYPEs only the pin knows about', () => {
    // The IDS-derived `IFC_DATA_TYPES` omits these six; `SCHEMA_REGISTRY.types`
    // carries them. Subtracting only the first table left them accepted.
    for (const type of TYPES_ONLY_IN_THE_PIN) {
      expect(
        IFC_DATA_TYPES.some((t) => t.name.toUpperCase() === type.toUpperCase()),
        `${type} should be absent from IFC_DATA_TYPES`,
      ).toBe(false);
      expect(Object.keys(SCHEMA_REGISTRY.types)).toContain(type);
      expect(isKnownType(type), type).toBe(false);
    }
  });

  it('needs both tables and only those two, measured against the union', () => {
    // Pins the contribution of each source, so dropping one is visible and
    // adding a third that changes nothing is visible too.
    const idsTable = new Set(IFC_DATA_TYPES.map((t) => t.name.toUpperCase()));
    const contributes = (names: string[]) => UNION_UPPER_LIST.filter(
      (upper) => !idsTable.has(upper) && names.includes(upper),
    ).length;
    const upperKeys = (o: Record<string, unknown>) => Object.keys(o).map((n) => n.toUpperCase());

    expect(UNION_UPPER_LIST.filter((upper) => idsTable.has(upper))).toHaveLength(132);
    expect(contributes(upperKeys(SCHEMA_REGISTRY.types))).toBe(6);
    // Folded in for consistency, not for effect — asserted so the comment in
    // `ifc-schema.ts` saying they subtract nothing stays true.
    expect(contributes(upperKeys(SCHEMA_REGISTRY.enums))).toBe(0);
    expect(contributes(upperKeys(SCHEMA_REGISTRY.selects))).toBe(0);
  });

  it('answers known-ness, not instantiability: abstract classes stay accepted (#2035)', () => {
    // Pre-existing and deliberately unchanged here. `main` accepts 123 abstract
    // classes through the pin; the union adds 19 more. Rejecting them is a
    // different predicate, belongs at the authoring boundary rather than in a
    // name-registry check, and is tracked separately — this test exists so the
    // split is a recorded decision rather than an oversight, and it fails the
    // day someone changes it without changing the contract.
    for (const type of ['IfcProduct', 'IfcRoot', 'IfcRelationship', 'IfcObjectDefinition']) {
      expect(getEntityMetadata(type)?.isAbstract, type).toBe(true);
      expect(isKnownType(type), type).toBe(true);
    }
    for (const type of ['IfcPositioningElement', 'IfcFacilityPart', 'IfcSegment']) {
      expect(getEntityMetadata(type), `${type} unexpectedly in the pin`).toBeUndefined();
      expect(isKnownType(type), type).toBe(true);
    }
  });

  it('is case-insensitive in both directions', () => {
    for (const type of [...IFC2X3_ONLY, ...IFC4X3_ONLY, 'IfcWall']) {
      expect(isKnownType(type.toUpperCase()), type).toBe(true);
      expect(isKnownType(type.toLowerCase()), type).toBe(true);
    }
  });

  it('accepts every union class except the non-entity declarations', () => {
    const wrong = UNION_NAMES.filter(
      (name) => isKnownType(name) === NON_ENTITIES.has(name.toUpperCase()),
    );
    expect(wrong).toEqual([]);
  });
});

describe('normalizeIfcTypeName across the bundled schema union (#2003)', () => {
  it('canonicalizes cross-schema classes from any casing', () => {
    for (const type of [...IFC2X3_ONLY, ...IFC4X3_ONLY]) {
      expect(normalizeIfcTypeName(type.toUpperCase()), type).toBe(type);
      expect(normalizeIfcTypeName(type.toLowerCase()), type).toBe(type);
      expect(normalizeIfcTypeName(type), type).toBe(type);
    }
  });

  it('gives the pin the same answer it gave before, for every pinned class', () => {
    // Union-first ordering may only fill the pin's gaps. If the two tables ever
    // disagreed on a class's canonical spelling this would catch it.
    const drifted = PINNED.filter(
      (type) => normalizeIfcTypeName(type.toUpperCase()) !== getEntityMetadata(type)?.name,
    );
    expect(drifted).toEqual([]);
  });

  it('leaves unknown names untouched', () => {
    for (const type of ['IfcWal', 'IfcAcmeVendorExtension', 'ifcacmevendorextension']) {
      expect(normalizeIfcTypeName(type), type).toBe(type);
    }
  });

  it('never renames a class to its supertype through the alias table', () => {
    // `ENTITY_NAME_ALIASES` maps IFC4.3 stratum leaves to the abstract
    // `IfcGeotechnicalStratum` the bundled schema does carry. That is the right
    // answer for an inheritance walk and the wrong one for a name-canonicalizer:
    // resolving it here would hand the caller back a different class.
    for (const type of ['IfcSolidStratum', 'IfcVoidStratum', 'IfcWaterStratum']) {
      expect(normalizeIfcTypeName(type), type).toBe(type);
    }
  });

  it('resolves the IFC2X3 leaves rust/core/src/legacy_entities.rs maps but no bundled TS schema carries', () => {
    // `IfcElectricalDistributionPoint` is real, deprecated IFC2X3 syntax with
    // no IFC4x3 equivalent in ENTITIES_IFC2X3/IFC4/IFC4X3. The Rust core's
    // `legacy_entities.rs` resolves it to `IfcDistributionElement` (comment:
    // "IFC2x3 names that have no IFC4x3 enum variant"). The TS
    // `ENTITY_NAME_ALIASES` table in `ifc-schema.ts` claims to mirror that
    // file "so the two sides stay in lockstep", but only carries the three
    // IFC4.3 stratum leaves -- this class is silently unknown here while the
    // Rust parser resolves it with geometry.
    expect(getInheritanceChain('IfcElectricalDistributionPoint')).toContain('IfcDistributionElement');
  });
});
