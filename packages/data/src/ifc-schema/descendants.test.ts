/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { expandTypeNamesToDescendants } from './descendants.js';
import { ENTITY_NAME_ALIASES, CROSS_SCHEMA_RENAMES } from './entity-aliases.js';

describe('expandTypeNamesToDescendants', () => {
  it('IfcWall includes itself and IfcWallStandardCase, excludes unrelated types', () => {
    const result = expandTypeNamesToDescendants(['IfcWall']);
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).not.toContain('IFCDOOR');
  });

  it('IfcBuildingElement includes many concrete subtypes, excludes non-elements', () => {
    const result = expandTypeNamesToDescendants(['IfcBuildingElement']);
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCSLAB');
    expect(result).toContain('IFCCOLUMN');
    expect(result).not.toContain('IFCSPACE');
    expect(result).not.toContain('IFCPROJECT');
  });

  it('an unrecognized type still falls back to itself, no crash', () => {
    const result = expandTypeNamesToDescendants(['IfcTotallyMadeUpType']);
    expect(result).toEqual(['IFCTOTALLYMADEUPTYPE']);
  });

  it('is case-insensitive on input and uppercases output', () => {
    const result = expandTypeNamesToDescendants(['ifcwall']);
    expect(result).toContain('IFCWALL');
  });

  it('deduplicates across multiple requested types', () => {
    const result = expandTypeNamesToDescendants(['IfcWall', 'IfcWallStandardCase']);
    const count = result.filter((t) => t === 'IFCWALLSTANDARDCASE').length;
    expect(count).toBe(1);
  });
});

/**
 * The closure is the UNION across the bundled schemas, because
 * `entityIndex.byType` is keyed by the names a FILE contains and those need
 * not belong to the version its header claims.
 *
 * `IfcSlabStandardCase` is only in the IFC4 table, `IfcCourse` only in IFC4X3,
 * so a per-version closure answered a different set for each header on the
 * same bytes. These pin the union directly, one name per table.
 */
describe('the closure spans the bundled schemas, not one version', () => {
  it('IfcSlab reaches the IFC4-only case subtypes', () => {
    const result = expandTypeNamesToDescendants(['IfcSlab']);
    expect(result).toContain('IFCSLABSTANDARDCASE');
    expect(result).toContain('IFCSLABELEMENTEDCASE');
  });

  it('IfcFurnishingElement reaches IfcFurniture, absent from the IFC2X3 table', () => {
    const result = expandTypeNamesToDescendants(['IfcFurnishingElement']);
    expect(result).toContain('IFCFURNITURE');
    expect(result).toContain('IFCSYSTEMFURNITUREELEMENT');
  });

  it('IfcBuiltElement reaches IfcCourse, an IFC4X3-only leaf', () => {
    const result = expandTypeNamesToDescendants(['IfcBuiltElement']);
    expect(result).toContain('IFCCOURSE');
  });

  it('takes no schema version, so no header can narrow it', () => {
    // The signature is the guarantee: there is no argument a caller could pass
    // that makes `IfcSlab` stop reaching `IfcSlabStandardCase`. Pinned as a
    // behaviour rather than a type, because the type is erased at runtime and
    // the query surfaces used to pass `store.schemaVersion` here.
    expect(expandTypeNamesToDescendants.length).toBe(1);
  });
});

/**
 * Two alias relations, read in opposite directions. Getting them the same way
 * round is the whole bug: the strata table is a NARROWING (leaf → nearest
 * known supertype) and the rename table is an EQUALITY.
 */
describe('alias tables in the descendant direction', () => {
  it('every aliased leaf is a descendant of the supertype it aliases to', () => {
    expect(Object.keys(ENTITY_NAME_ALIASES).length).toBeGreaterThan(0);
    for (const [leaf, supertype] of Object.entries(ENTITY_NAME_ALIASES)) {
      expect(expandTypeNamesToDescendants([supertype]), `${supertype} -> ${leaf}`).toContain(
        leaf.toUpperCase(),
      );
    }
  });

  it('an aliased leaf does NOT pick up its siblings', () => {
    // The narrowing is one-way. `IfcSolidStratum` resolving UP to
    // `IfcGeotechnicalStratum` must not make it resolve back DOWN to every
    // other stratum, which would over-match a query for solid strata.
    const result = expandTypeNamesToDescendants(['IfcSolidStratum']);
    expect(result).toEqual(['IFCSOLIDSTRATUM']);
  });

  it('both spellings of a cross-schema rename reach the same descendants', () => {
    expect(CROSS_SCHEMA_RENAMES.length).toBeGreaterThan(0);
    for (const [older, newer] of CROSS_SCHEMA_RENAMES) {
      const a = expandTypeNamesToDescendants([older]).filter((n) => n !== older && n !== newer);
      const b = expandTypeNamesToDescendants([newer]).filter((n) => n !== older && n !== newer);
      expect(a.sort(), `${older} vs ${newer}`).toEqual(b.sort());
      expect(a.length, `${older} has descendants to compare`).toBeGreaterThan(0);
    }
  });

  it('IfcBuildingElement reaches the IFC4X3-only leaves of its renamed self', () => {
    // The named instance of the rule above, legible without rerunning it.
    expect(expandTypeNamesToDescendants(['IfcBuildingElement'])).toContain('IFCCOURSE');
  });
});

/**
 * Callers slice this list with `offset`/`limit`, so the order is part of the
 * contract: a traversal-dependent order shifts a caller's page whenever the
 * generated schema tables are regenerated.
 */
describe('order is deterministic and documented', () => {
  it('puts the requested type first, then its descendants sorted', () => {
    const result = expandTypeNamesToDescendants(['IfcSlab']);
    expect(result[0]).toBe('IFCSLAB');
    expect(result.slice(1)).toEqual([...result.slice(1)].sort());
  });

  it('keeps each requested type immediately ahead of its own descendants', () => {
    const result = expandTypeNamesToDescendants(['IfcBeam', 'IfcRoof']);
    expect(result).toEqual(['IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCROOF']);
  });

  it('a deeply nested closure is sorted, not depth-first', () => {
    // `IfcBuildingElement`'s closure is wide enough that depth-first pop order
    // and sorted order cannot coincide by accident.
    const result = expandTypeNamesToDescendants(['IfcBuildingElement']).slice(1);
    expect(result.length).toBeGreaterThan(20);
    expect(result).toEqual([...result].sort());
  });
});
