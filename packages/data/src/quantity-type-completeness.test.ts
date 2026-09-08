/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `QuantityType` is a hand-written enum: its numeric values are a wire
 * contract (they land in `Uint8Array` columns, Parquet exports and cached
 * stores), so it cannot be regenerated wholesale from the schema. What it
 * *can* be is checked against the schema, which is what this file does.
 *
 * The source of truth is the generated per-version entity tables in
 * `./ifc-schema/generated/`, filtered to the concrete subtypes of
 * `IfcPhysicalSimpleQuantity`. Both directions are asserted, so the suite
 * reds when a schema regeneration introduces a subtype the enum lacks
 * (the `IfcQuantityNumber` case: IFC4X3 added it and the enum did not
 * follow) *and* when the enum grows a member no schema knows about.
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC2X3 } from './ifc-schema/generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './ifc-schema/generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './ifc-schema/generated/entities-ifc4x3.js';
import type { IfcEntityInfo } from './ifc-schema/types.js';
import { QuantityType } from './types.js';

const SCHEMAS: ReadonlyArray<readonly [string, readonly IfcEntityInfo[]]> = [
  ['IFC2X3', ENTITIES_IFC2X3],
  ['IFC4', ENTITIES_IFC4],
  ['IFC4X3', ENTITIES_IFC4X3],
];

/**
 * Concrete subtypes of `IfcPhysicalSimpleQuantity` in one generated table.
 * The schema tables are flat, and every quantity subtype names
 * `IfcPhysicalSimpleQuantity` as its direct parent, so a one-level filter
 * is exact rather than an approximation.
 */
function simpleQuantitySubtypes(entities: readonly IfcEntityInfo[]): string[] {
  return entities
    .filter((e) => e.parent === 'IfcPhysicalSimpleQuantity' && !e.abstract)
    .map((e) => e.name)
    .sort();
}

/** Every subtype named by any bundled schema version. */
function allSimpleQuantitySubtypes(): Set<string> {
  const all = new Set<string>();
  for (const [, entities] of SCHEMAS) {
    for (const name of simpleQuantitySubtypes(entities)) all.add(name);
  }
  return all;
}

/**
 * Anti-vacuity guard, as a named list rather than a count floor: a floor
 * reds on benign schema growth and stays silent exactly when a name goes
 * missing. Each entry is a concrete subtype every bundled schema shares.
 */
const REQUIRED_IN_EVERY_SCHEMA = [
  'IfcQuantityArea',
  'IfcQuantityCount',
  'IfcQuantityLength',
  'IfcQuantityTime',
  'IfcQuantityVolume',
  'IfcQuantityWeight',
] as const;

/** Subtypes added after IFC4 — present in IFC4X3 only. */
const REQUIRED_IN_IFC4X3 = ['IfcQuantityNumber'] as const;

/** `IfcQuantityArea` -> `Area`, the enum member name it must map to. */
function enumMemberName(entityName: string): string {
  return entityName.replace(/^IfcQuantity/, '');
}

describe('QuantityType covers the schema', () => {
  it('finds the quantity subtypes in every bundled schema (anti-vacuity)', () => {
    for (const [version, entities] of SCHEMAS) {
      const subtypes = simpleQuantitySubtypes(entities);
      for (const required of REQUIRED_IN_EVERY_SCHEMA) {
        expect(subtypes, `${version} must define ${required}`).toContain(required);
      }
    }

    const ifc4x3 = simpleQuantitySubtypes(ENTITIES_IFC4X3);
    for (const required of REQUIRED_IN_IFC4X3) {
      expect(ifc4x3, `IFC4X3 must define ${required}`).toContain(required);
    }
  });

  it('has a member for every IfcPhysicalSimpleQuantity subtype in any schema', () => {
    const members = new Set(
      Object.keys(QuantityType).filter((k) => Number.isNaN(Number(k))),
    );
    const missing = [...allSimpleQuantitySubtypes()]
      .filter((name) => !members.has(enumMemberName(name)))
      .sort();

    expect(missing, `QuantityType lacks a member for: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no member that is not a real quantity entity', () => {
    const subtypes = allSimpleQuantitySubtypes();
    const bogus = Object.keys(QuantityType)
      .filter((k) => Number.isNaN(Number(k)))
      .filter((member) => !subtypes.has(`IfcQuantity${member}`))
      .sort();

    expect(bogus, `QuantityType members with no schema entity: ${bogus.join(', ')}`).toEqual([]);
  });
});
