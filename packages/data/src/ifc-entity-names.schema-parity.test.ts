/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IFC_ENTITY_NAMES` used to be a hand-maintained literal, and the only thing
 * pinning it was `ifc-entity-names.test.ts`, which compares it against
 * `IfcTypeEnum` — a 128-member subset of the schema. Everything outside that
 * subset could go missing unnoticed, and 282 entries had.
 *
 * `scripts/emit-entity-names.ts` now writes it from the same
 * `ifc-schema/generated/entities-*.ts` tables that `generate:ifc-schema`
 * produces, so the transcription that drifted is gone. What replaces it is a
 * committed artefact, and its failure mode is staleness: a schema bump that
 * regenerates `entities-*.ts` while `entity-names.ts` is left behind, or an
 * emit that starts dropping entities (an `abstract` filter, a version left out
 * of the loop) or inventing them. This file re-derives the expectation from
 * `entities-*.ts` — the same source, read independently of the emitter — and
 * checks it in BOTH directions, so any of those fails here rather than
 * degrading display names silently. The named list below is what keeps that
 * honest when both sides move together.
 */

import { describe, it, expect } from 'vitest';
import { IFC_ENTITY_NAMES } from './ifc-entity-names.js';
import { ENTITIES_IFC2X3 } from './ifc-schema/generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './ifc-schema/generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './ifc-schema/generated/entities-ifc4x3.js';

/** UPPERCASE STEP keyword → PascalCase name, unioned over the three schemas. */
const SCHEMA_NAMES = new Map<string, string>();
for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
  for (const e of list) SCHEMA_NAMES.set(e.name.toUpperCase(), e.name);
}

/**
 * Map keys with no entity of that name in any generated schema. These three
 * are reachable through `IfcTypeEnum` / `IfcTypeEnumToString` (see
 * `ifc-entity-names.test.ts`) but are absent from the buildingSMART schema
 * dumps the generator reads, so they cannot be derived — `ENUM_ONLY_NAMES` in
 * `scripts/emit-entity-names.ts` adds them to the emit by hand. Listed by name
 * here too, never as a tolerance — a fourth one appearing must fail this file.
 */
const ENUM_ONLY_KEYS = ['IFCSOLIDSTRATUM', 'IFCVOIDSTRATUM', 'IFCWATERSTRATUM'] as const;

/**
 * Named entities that MUST be present, rather than a count floor. Each was
 * either observed missing (the `*ElementedCase` / `*StandardCase` / `*Style`
 * families displayed raw-UPPERCASE) or is the canonical example of a family
 * this map exists to spell.
 */
const REQUIRED = [
  'IfcWallElementedCase',
  'IfcSlabElementedCase',
  'IfcBuildingElement',
  'IfcDoorStyle',
  'IfcWindowStyle',
  'IfcWallStandardCase',
  'IfcSlabStandardCase',
  'IfcBeamStandardCase',
  'IfcColumnStandardCase',
  'IfcMemberStandardCase',
  'IfcPlateStandardCase',
  'IfcDoorStandardCase',
  'IfcWindowStandardCase',
  'IfcProxy',
  'IfcPump',
  'IfcZone',
  'IfcWall',
] as const;

describe('IFC_ENTITY_NAMES ↔ generated IFC schema', () => {
  it('anti-vacuity: the three schema arrays and the map are all populated', () => {
    // A silently-empty import would make every parity check below pass.
    expect(ENTITIES_IFC2X3.length).toBeGreaterThan(700);
    expect(ENTITIES_IFC4.length).toBeGreaterThan(900);
    expect(ENTITIES_IFC4X3.length).toBeGreaterThan(1000);
    expect(SCHEMA_NAMES.size).toBeGreaterThan(1100);
    expect(Object.keys(IFC_ENTITY_NAMES).length).toBeGreaterThan(1100);

    // Negative control: a name that is in neither source must be absent from
    // both, so a match here would mean the lookups are not real lookups.
    expect(SCHEMA_NAMES.has('IFCNOTAREALENTITY')).toBe(false);
    expect(IFC_ENTITY_NAMES['IFCNOTAREALENTITY']).toBeUndefined();
  });

  it('names every entity the required list calls out, in both sources', () => {
    const notInSchema = REQUIRED.filter((n) => !SCHEMA_NAMES.has(n.toUpperCase()));
    expect(notInSchema, 'required entity vanished from the generated schema').toEqual([]);

    const notInTable = REQUIRED.filter((n) => IFC_ENTITY_NAMES[n.toUpperCase()] !== n);
    expect(notInTable, 'required entity missing or misspelled in IFC_ENTITY_NAMES').toEqual([]);
  });

  it('schema → map: every generated entity is present, exactly spelled', () => {
    const missing: string[] = [];
    for (const [upper, pascal] of SCHEMA_NAMES) {
      if (IFC_ENTITY_NAMES[upper] !== pascal) {
        missing.push(`${upper} -> expected ${pascal}, got ${IFC_ENTITY_NAMES[upper]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('map → schema: every key is derivable, apart from the named enum-only keys', () => {
    const undeclared = Object.keys(IFC_ENTITY_NAMES).filter(
      (k) => !SCHEMA_NAMES.has(k) && !(ENUM_ONLY_KEYS as readonly string[]).includes(k),
    );
    expect(undeclared, 'map key that no generated schema backs').toEqual([]);

    // The named exceptions must still all be real entries, so the allowlist
    // cannot rot into a blanket excuse.
    for (const key of ENUM_ONLY_KEYS) {
      expect(IFC_ENTITY_NAMES[key], `${key} is allowlisted but absent`).toBeDefined();
    }
  });

  it('every map key is exactly the uppercase of its value', () => {
    const bad = Object.entries(IFC_ENTITY_NAMES).filter(([k, v]) => v.toUpperCase() !== k);
    expect(bad).toEqual([]);
  });
});
