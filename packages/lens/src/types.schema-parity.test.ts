/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-parity guard for `IFC_SUBTYPE_TO_BASE`.
 *
 * `types.ts` hand-maintains this subclass → base-class map rather than
 * importing `@ifc-lite/data` at runtime (lens does not otherwise depend on
 * it — used here only at test time, mirroring `feature-elements.schema-parity.test.ts`
 * in `packages/drawing-2d`). That leaves the same drift risk: the map
 * originally covered only 4 of IFC4's 9 `*StandardCase` entities
 * (Wall/Slab/Column/Beam) plus the two `*Flight` types, silently missing
 * Door/Window/Member/Plate/Opening — a lens rule written against the base
 * type (`IfcDoor`, `IfcWindow`, ...) never matched entities exported as the
 * StandardCase variant, and `matchesIfcType` in `matching.ts` returned
 * `false` with no error.
 *
 * This test re-derives every `*StandardCase` entity from `@ifc-lite/data`'s
 * generated entity tables (IFC2X3, IFC4, IFC4X3 — an authority independent
 * of the one this map was hand-copied from) and asserts `IFC_SUBTYPE_TO_BASE`
 * agrees with the schema's declared parent in both directions, so a future
 * schema bump or hand-edit cannot quietly reopen the gap.
 *
 * `IfcStairFlight`/`IfcRampFlight` are deliberately excluded from the
 * schema-derived check: the schema itself does not parent them under
 * `IfcStair`/`IfcRamp` (both are `IfcBuiltElement` subtypes — a flight is a
 * *component* of a stair/ramp, not an alternate representation of one), so
 * this pair is a curated "treat as the same family for lens matching"
 * decision, not an inheritance fact the schema can confirm or deny. They are
 * covered instead by the fixed-membership regression guard below.
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import type { IfcEntityInfo } from '@ifc-lite/data';
import { IFC_SUBTYPE_TO_BASE } from './types.js';

/** Every concrete `*StandardCase` entity in one schema, mapped to its declared parent. */
function subtypeUniverse(entities: readonly IfcEntityInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entity of entities) {
    if (!entity.parent) continue;
    if (entity.name.endsWith('StandardCase')) {
      out.set(entity.name, entity.parent);
    }
  }
  return out;
}

const SCHEMAS: ReadonlyArray<readonly [name: string, entities: readonly IfcEntityInfo[]]> = [
  ['IFC2X3', ENTITIES_IFC2X3],
  ['IFC4', ENTITIES_IFC4],
  ['IFC4X3', ENTITIES_IFC4X3],
];

describe('IFC_SUBTYPE_TO_BASE vs generated IFC schemas', () => {
  for (const [schemaName, entities] of SCHEMAS) {
    const universe = subtypeUniverse(entities);

    it(`derives a non-trivial *StandardCase/*Flight universe from ${schemaName} (anti-vacuity)`, () => {
      // If the schema import failed or the naming filter broke, `universe`
      // would collapse to empty and the assertions below would pass
      // vacuously.
      expect(universe.size).toBeGreaterThan(0);
    });

    it(`IFC_SUBTYPE_TO_BASE covers every ${schemaName} *StandardCase/*Flight entity with its declared parent`, () => {
      const mismatches: string[] = [];
      for (const [subtype, parent] of universe) {
        const mapped = IFC_SUBTYPE_TO_BASE[subtype];
        if (mapped !== parent) {
          mismatches.push(`${subtype}: expected -> ${parent}, got -> ${mapped ?? '(missing)'}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  // IfcStairFlight/IfcRampFlight are curated, not schema-derived (see the
  // file-level comment) — excluded from this check.
  const CURATED_NON_SCHEMA_ENTRIES = new Set(['IfcStairFlight', 'IfcRampFlight']);

  it('does not map any *StandardCase entry to a parent other than the schema-declared one (no extras/typos)', () => {
    const allEntities = [...ENTITIES_IFC2X3, ...ENTITIES_IFC4, ...ENTITIES_IFC4X3];
    const byName = new Map(allEntities.map((e) => [e.name, e]));
    const badEntries = Object.entries(IFC_SUBTYPE_TO_BASE)
      .filter(([subtype]) => !CURATED_NON_SCHEMA_ENTRIES.has(subtype))
      .filter(([subtype, base]) => {
        const entity = byName.get(subtype);
        // Every mapped subtype must exist in at least one schema, with the
        // schema's own parent matching what we mapped it to.
        return !entity || entity.parent !== base;
      });
    expect(badEntries).toEqual([]);
  });

  it('pins the two curated non-schema entries (IfcStairFlight/IfcRampFlight)', () => {
    expect(IFC_SUBTYPE_TO_BASE['IfcStairFlight']).toBe('IfcStair');
    expect(IFC_SUBTYPE_TO_BASE['IfcRampFlight']).toBe('IfcRamp');
  });

  // Regression guard: a fix that swallowed everything (e.g. "map every Ifc*
  // entity to itself, or to IfcElement") would pass the coverage assertions
  // above too — pin that unrelated, non-subtype entities are absent.
  it('does not map unrelated base entities (regression guard)', () => {
    expect(IFC_SUBTYPE_TO_BASE['IfcWall']).toBeUndefined();
    expect(IFC_SUBTYPE_TO_BASE['IfcDoor']).toBeUndefined();
    expect(IFC_SUBTYPE_TO_BASE['IfcSpace']).toBeUndefined();
    expect(Object.keys(IFC_SUBTYPE_TO_BASE)).toHaveLength(11);
  });
});
