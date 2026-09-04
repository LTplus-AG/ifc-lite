/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { expandTypeNamesToDescendants } from './descendants.js';
import { ENTITY_NAME_ALIASES, CROSS_SCHEMA_RENAMES } from './entity-aliases.js';

describe('expandTypeNamesToDescendants', () => {
  it('IfcWall includes itself and IfcWallStandardCase, excludes unrelated types', () => {
    const result = expandTypeNamesToDescendants(['IfcWall'], 'IFC4');
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).not.toContain('IFCDOOR');
  });

  it('IfcBuildingElement includes many concrete subtypes, excludes non-elements', () => {
    const result = expandTypeNamesToDescendants(['IfcBuildingElement'], 'IFC4');
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCSLAB');
    expect(result).toContain('IFCCOLUMN');
    expect(result).not.toContain('IFCSPACE');
    expect(result).not.toContain('IFCPROJECT');
  });

  it('an unrecognized type still falls back to itself, no crash', () => {
    const result = expandTypeNamesToDescendants(['IfcTotallyMadeUpType'], 'IFC4');
    expect(result).toEqual(['IFCTOTALLYMADEUPTYPE']);
  });

  it('is case-insensitive on input and uppercases output', () => {
    const result = expandTypeNamesToDescendants(['ifcwall'], 'IFC4');
    expect(result).toContain('IFCWALL');
  });

  it('deduplicates across multiple requested types', () => {
    const result = expandTypeNamesToDescendants(['IfcWall', 'IfcWallStandardCase'], 'IFC4');
    const count = result.filter((t) => t === 'IFCWALLSTANDARDCASE').length;
    expect(count).toBe(1);
  });
});

/**
 * `entityIndex.byType` is keyed by the names a FILE contains, and those need
 * not belong to the version its header claims. `IfcSlabStandardCase` is only
 * in the IFC4 table and `IfcCourse` only in IFC4X3, so a closure that read one
 * table answered a different set for each header on the same bytes.
 *
 * Rule (b) admits exactly those names: declared by another table, and not
 * declared by this file's schema AT ALL. The negatives in the next block are
 * the other half of that rule.
 */
describe('the closure reaches leaf spellings the file\'s own schema does not declare', () => {
  it('IfcSlab reaches the IFC4-only case subtypes', () => {
    const result = expandTypeNamesToDescendants(['IfcSlab'], 'IFC4');
    expect(result).toContain('IFCSLABSTANDARDCASE');
    expect(result).toContain('IFCSLABELEMENTEDCASE');
  });

  it('IfcFurnishingElement reaches IfcFurniture, absent from the IFC2X3 table', () => {
    const result = expandTypeNamesToDescendants(['IfcFurnishingElement'], 'IFC4');
    expect(result).toContain('IFCFURNITURE');
    expect(result).toContain('IFCSYSTEMFURNITUREELEMENT');
  });

  it('IfcBuiltElement reaches IfcCourse, an IFC4X3-only leaf', () => {
    const result = expandTypeNamesToDescendants(['IfcBuiltElement'], 'IFC4');
    expect(result).toContain('IFCCOURSE');
  });

  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])(
    'reaches the same slab, furniture and stratum spellings under %s',
    (version) => {
      // The differential: the three headers must agree about names no schema
      // re-parented, whichever table declares them.
      expect(expandTypeNamesToDescendants(['IfcSlab'], version)).toContain('IFCSLABSTANDARDCASE');
      expect(expandTypeNamesToDescendants(['IfcSlab'], version)).toContain('IFCSLABELEMENTEDCASE');
      expect(expandTypeNamesToDescendants(['IfcFurnishingElement'], version)).toContain('IFCFURNITURE');
      expect(expandTypeNamesToDescendants(['IfcGeotechnicalStratum'], version)).toContain('IFCSOLIDSTRATUM');
      expect(expandTypeNamesToDescendants(['IfcBuildingElement'], version)).toContain('IFCCOURSE');
      expect(expandTypeNamesToDescendants(['IfcBuiltElement'], version)).toContain('IFCWALLSTANDARDCASE');
    },
  );
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
      expect(expandTypeNamesToDescendants([supertype], 'IFC4'), `${supertype} -> ${leaf}`).toContain(
        leaf.toUpperCase(),
      );
    }
  });

  it('an aliased leaf does NOT pick up its siblings', () => {
    // The narrowing is one-way. `IfcSolidStratum` resolving UP to
    // `IfcGeotechnicalStratum` must not make it resolve back DOWN to every
    // other stratum, which would over-match a query for solid strata.
    const result = expandTypeNamesToDescendants(['IfcSolidStratum'], 'IFC4');
    expect(result).toEqual(['IFCSOLIDSTRATUM']);
  });

  it('both spellings of a cross-schema rename reach the same descendants', () => {
    expect(CROSS_SCHEMA_RENAMES.length).toBeGreaterThan(0);
    for (const [older, newer] of CROSS_SCHEMA_RENAMES) {
      const a = expandTypeNamesToDescendants([older], 'IFC4').filter((n) => n !== older && n !== newer);
      const b = expandTypeNamesToDescendants([newer], 'IFC4').filter((n) => n !== older && n !== newer);
      expect(a.sort(), `${older} vs ${newer}`).toEqual(b.sort());
      expect(a.length, `${older} has descendants to compare`).toBeGreaterThan(0);
    }
  });

  it('IfcBuildingElement reaches the IFC4X3-only leaves of its renamed self', () => {
    // The named instance of the rule above, legible without rerunning it.
    expect(expandTypeNamesToDescendants(['IfcBuildingElement'], 'IFC4')).toContain('IFCCOURSE');
  });
});

/**
 * Callers slice this list with `offset`/`limit`, so the order is part of the
 * contract: a traversal-dependent order shifts a caller's page whenever the
 * generated schema tables are regenerated.
 */
describe('order is deterministic and documented', () => {
  it('puts the requested type first, then its descendants sorted', () => {
    const result = expandTypeNamesToDescendants(['IfcSlab'], 'IFC4');
    expect(result[0]).toBe('IFCSLAB');
    expect(result.slice(1)).toEqual([...result.slice(1)].sort());
  });

  it('keeps each requested type immediately ahead of its own descendants', () => {
    const result = expandTypeNamesToDescendants(['IfcBeam', 'IfcRoof'], 'IFC4');
    expect(result).toEqual(['IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCROOF']);
  });

  it('a deeply nested closure is sorted, not depth-first', () => {
    // `IfcBuildingElement`'s closure is wide enough that depth-first pop order
    // and sorted order cannot coincide by accident.
    const result = expandTypeNamesToDescendants(['IfcBuildingElement'], 'IFC4').slice(1);
    expect(result.length).toBeGreaterThan(20);
    expect(result).toEqual([...result].sort());
  });
});

/**
 * The other half of rule (b): a name the file's own schema declares is never
 * pulled in from a version the file is not written in.
 *
 * buildingSMART re-parented entities between versions, so unioning the tables
 * misfiled 45 (supertype, schema) pairs. Each case below is a real re-parenting
 * measured against the bundled tables, and each one made a query answer with
 * records that are not of the requested class on that schema.
 */
describe('a re-parented entity is not pulled in from another schema', () => {
  it.each([
    // base, schema, name that must NOT appear, where the union got it from
    ['IfcBuildingElement', 'IFC4', 'IFCREINFORCINGBAR', 'an IfcElementComponent from IFC4 on'],
    ['IfcBuildingElement', 'IFC4', 'IFCBUILDINGELEMENTPART', 'an IfcElementComponent from IFC4 on'],
    ['IfcObject', 'IFC4', 'IFCPROJECT', 'an IfcContext from IFC4 on'],
    ['IfcObject', 'IFC4X3', 'IFCPROJECT', 'an IfcContext from IFC4 on'],
    ['IfcSystem', 'IFC2X3', 'IFCZONE', 'an IfcGroup in IFC2X3'],
    ['IfcElementType', 'IFC4', 'IFCSPACETYPE', 'an IfcSpatialElementType in IFC4'],
    ['IfcFastener', 'IFC4', 'IFCMECHANICALFASTENER', 'a sibling, not a subtype, in IFC4'],
  ])('%s on %s does not return %s (%s)', (base, version, forbidden) => {
    expect(expandTypeNamesToDescendants([base], version)).not.toContain(forbidden);
  });

  it('but still returns the type it IS a descendant of on the schema that says so', () => {
    // Anti-vacuity in the strongest form available: the same name, the same
    // resolver, the schema where the parentage really holds.
    expect(expandTypeNamesToDescendants(['IfcBuildingElement'], 'IFC2X3')).toContain('IFCREINFORCINGBAR');
    expect(expandTypeNamesToDescendants(['IfcObject'], 'IFC2X3')).toContain('IFCPROJECT');
    expect(expandTypeNamesToDescendants(['IfcSystem'], 'IFC4')).toContain('IFCZONE');
  });

  it('IfcElementComponent, the class IfcReinforcingBar really has on IFC4, still finds it', () => {
    expect(expandTypeNamesToDescendants(['IfcElementComponent'], 'IFC4')).toContain('IFCREINFORCINGBAR');
  });
});

/**
 * The transitive form of the same misfiling, one level below the node rule (b)
 * skips.
 *
 * Rule (b) never ADDS a name the file's own schema declares. On its own that
 * is not enough: the walk through a foreign table also has to stop at such a
 * node when the own schema puts it outside the requested subtree, or the
 * foreign-only leaves hanging below it come in anyway.
 *
 * `IfcTendonConduit` is IFC4X3-only and sits under `IfcReinforcingElement`
 * there. IFC2X3 declares `IfcReinforcingElement` too, under
 * `IfcBuildingElement` — nowhere near `IfcElementComponent`. Walking through
 * the skipped node put `IFCTENDONCONDUIT` in `byType('IfcElementComponent')`
 * on an IFC2X3 file.
 *
 * Verified by measurement rather than by argument: sweeping all 1159 entity
 * names across the three schema versions, the subtree test changes exactly
 * this one answer and removes nothing else. The first, cruder form of the test
 * — comparing declared parents instead of subtree membership — changed 30
 * answers, including dropping `IFCSLABSTANDARDCASE` from `IfcBuiltElement` on
 * IFC4X3, which is the headline case this resolver exists for. Both directions
 * are pinned below.
 */
describe('a foreign walk stops at a node the file schema places elsewhere', () => {
  it('IfcElementComponent on IFC2X3 does not reach IFCTENDONCONDUIT through IfcReinforcingElement', () => {
    expect(expandTypeNamesToDescendants(['IfcElementComponent'], 'IFC2X3')).not.toContain(
      'IFCTENDONCONDUIT',
    );
  });

  it('but IfcElement on IFC2X3 does, since IFC2X3 really does put it under there', () => {
    // Anti-vacuity: the name is reachable, and the resolver still finds it by
    // the route the file's own schema agrees with.
    expect(expandTypeNamesToDescendants(['IfcElement'], 'IFC2X3')).toContain('IFCTENDONCONDUIT');
    expect(expandTypeNamesToDescendants(['IfcElementComponent'], 'IFC4X3')).toContain(
      'IFCTENDONCONDUIT',
    );
  });

  it('the rename does not read as a re-parenting: IFC4-only leaves survive on IFC4X3', () => {
    // Every element moved from IfcBuildingElement to IfcBuiltElement in
    // IFC4X3. A same-parent test would call that a re-parenting and prune the
    // whole hierarchy; subtree membership does not.
    const built = expandTypeNamesToDescendants(['IfcBuiltElement'], 'IFC4X3');
    expect(built).toContain('IFCSLABSTANDARDCASE');
    expect(built).toContain('IFCWALLSTANDARDCASE');
    expect(expandTypeNamesToDescendants(['IfcSlab'], 'IFC4X3')).toContain('IFCSLABSTANDARDCASE');
  });

  it('a type the file schema does not declare at all keeps the foreign answer whole', () => {
    // `active` guard: IFC2X3 has no IfcSpatialElement, so it has no opinion
    // about that subtree and must not prune the table that does declare it.
    const spatial = expandTypeNamesToDescendants(['IfcSpatialElement'], 'IFC2X3');
    expect(spatial).toContain('IFCBRIDGE');
    expect(spatial).toContain('IFCROAD');
  });
});
