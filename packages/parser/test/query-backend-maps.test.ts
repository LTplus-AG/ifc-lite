/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The query backends' shared lookup tables.
 *
 * `IFC_SUBTYPES` / `expandTypes` / `QUERY_REL_TYPE_MAP` were three
 * byte-identical copies — one in the viewer's `query-adapter`, one in
 * `@ifc-lite/cli`'s `HeadlessBackend`, one in `@ifc-lite/mcp`'s
 * `backend-query` — behind a single SDK query API. Only the CLI copy had a
 * test, so the other two were free to drift: removing `IFCSLABELEMENTEDCASE`
 * from the MCP copy left all 272 of its tests green, meaning
 * `byType('IfcSlab')` could answer differently depending on which surface the
 * caller reached. They now share this module; these tests cover it at its new
 * home so the coverage no longer belongs to one consumer.
 */

import { describe, it, expect } from 'vitest';
import { IFC_SUBTYPES, expandTypes, QUERY_REL_TYPE_MAP } from '../src/query-backend-maps.js';
import { RelationshipType, ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import { ENTITY_NAME_ALIASES } from '../src/ifc-schema.js';
import { SCHEMA_REGISTRY } from '../src/generated/schema-registry.js';

describe('expandTypes', () => {
  it('includes both IFC4 case subtypes of IfcWall', () => {
    const result = expandTypes(['IfcWall'], 'IFC4');
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).toContain('IFCWALLELEMENTEDCASE');
  });

  it('includes both IFC4 case subtypes of IfcSlab', () => {
    // The mutation that survived: dropping IFCSLABELEMENTEDCASE from one copy
    // silently narrowed `byType('IfcSlab')` on that surface alone.
    const result = expandTypes(['IfcSlab'], 'IFC4');
    expect(result).toContain('IFCSLABSTANDARDCASE');
    expect(result).toContain('IFCSLABELEMENTEDCASE');
  });

  it('passes through a type with no known subtypes', () => {
    expect(expandTypes(['IfcRoof'], 'IFC4')).toEqual(['IFCROOF']);
  });

  it('uppercases lowercase input, since entityIndex.byType is uppercase-keyed', () => {
    expect(expandTypes(['ifcwall'], 'IFC4')).toContain('IFCWALL');
  });

  it('expands every type in the list', () => {
    const result = expandTypes(['IfcWall', 'IfcRoof'], 'IFC4');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).toContain('IFCROOF');
  });

  it('returns nothing for an empty list', () => {
    expect(expandTypes([], 'IFC4')).toEqual([]);
  });

  it('lists the parent type before its subtypes', () => {
    // Callers build a Set from this, but the parent-first order is what makes
    // the result readable in a debug dump; pin it so a rewrite keeps it.
    expect(expandTypes(['IfcBeam'], 'IFC4')).toEqual(['IFCBEAM', 'IFCBEAMSTANDARDCASE']);
  });
});

/**
 * `schemaVersion` is optional because `expandTypes` is a published export and
 * requiring it would break `expandTypes(['IfcWall'])` at compile time, which a
 * bug-fix release must not do. Omitted, it unions the three bundled schemas.
 *
 * The union is exactly the misfiling the per-version path exists to avoid, so
 * these pin the difference in both directions rather than only asserting the
 * fallback returns something.
 */
describe('an omitted schema version falls back to the union', () => {
  it('is a superset of what every named version answers', () => {
    // The defining property, and the reason omitting the version is safe for
    // an existing caller: nothing a per-schema answer contains goes missing.
    // (Most leaf spellings are already in every per-version answer -- that is
    // rule (b) doing its job -- so the union's only real addition is the
    // re-parented names the next case names.)
    for (const base of ['IfcBuildingElement', 'IfcElement', 'IfcObject', 'IfcSlab']) {
      const unioned = new Set(expandTypes([base]));
      for (const version of ['IFC2X3', 'IFC4', 'IFC4X3']) {
        const named = expandTypes([base], version);
        expect(named.length, `${base} @ ${version}`).toBeGreaterThan(0);
        for (const name of named) expect(unioned, `${base} @ ${version}: ${name}`).toContain(name);
      }
    }
  });

  it('and is strictly bigger than at least one of them, so the superset is not an identity', () => {
    const unioned = expandTypes(['IfcBuildingElement']);
    expect(unioned.length).toBeGreaterThan(expandTypes(['IfcBuildingElement'], 'IFC4').length);
  });

  it('and pays for it by misfiling a re-parented entity, which naming the schema does not', () => {
    // IfcReinforcingBar is an IfcBuildingElement in IFC2X3 and an
    // IfcElementComponent from IFC4 on. This is the cost the doc comment
    // warns about, stated as a test so it cannot be mistaken for a bug.
    expect(expandTypes(['IfcBuildingElement'])).toContain('IFCREINFORCINGBAR');
    expect(expandTypes(['IfcBuildingElement'], 'IFC4')).not.toContain('IFCREINFORCINGBAR');
    expect(expandTypes(['IfcBuildingElement'], 'IFC2X3')).toContain('IFCREINFORCINGBAR');
  });

  it('still gates the IfcRoot branch, so the fallback is not a free-for-all', () => {
    const rooted = expandTypes(['IfcRoot']);
    expect(rooted).not.toContain('IFCPROPERTYSET');
    expect(rooted).not.toContain('IFCRELDEFINESBYPROPERTIES');
    expect(rooted).toContain('IFCWALL');
  });

  it('does not share a cache entry with a named version, or with an unknown string', () => {
    // '' and 'nonsense' resolve to IFC4; only an ABSENT version unions. A key
    // built with `schemaVersion ?? ''` would have collapsed the first pair.
    expect(expandTypes(['IfcObject'])).toContain('IFCPROJECT');
    expect(expandTypes(['IfcObject'], '')).not.toContain('IFCPROJECT');
    expect(expandTypes(['IfcObject'], 'nonsense')).not.toContain('IFCPROJECT');
    expect(expandTypes(['IfcObject'])).toContain('IFCPROJECT');
  });
});

describe('expandTypes is memoized without leaking its cache', () => {
  it('a repeated call returns an equal but separate array', () => {
    const a = expandTypes(['IfcWall'], 'IFC4');
    const b = expandTypes(['IfcWall'], 'IFC4');
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
  });

  it('mutating a returned array does not poison the next answer', () => {
    // Callers do `new Set(expandTypes(...))` and `for (const t of ...)`, but a
    // cache that handed out its own array would turn any future `.push`/`.sort`
    // at a call site into a silent, permanent change to what byType matches.
    const first = expandTypes(['IfcSlab'], 'IFC4');
    const length = first.length;
    first.push('IFCNOTATHING');
    first.sort();
    const second = expandTypes(['IfcSlab'], 'IFC4');
    expect(second).toHaveLength(length);
    expect(second).not.toContain('IFCNOTATHING');
    expect(second[0]).toBe('IFCSLAB');
  });

  it('keys on the schema version, not just the type list', () => {
    // IFCPROJECT is an IfcObject in IFC2X3 and an IfcContext from IFC4 on. A
    // cache keyed on the types alone would answer the second call from the
    // first schema's entry.
    expect(expandTypes(['IfcObject'], 'IFC2X3')).toContain('IFCPROJECT');
    expect(expandTypes(['IfcObject'], 'IFC4')).not.toContain('IFCPROJECT');
    expect(expandTypes(['IfcObject'], 'IFC2X3')).toContain('IFCPROJECT');
  });

  it('keys on the order of the type list, which the output preserves', () => {
    expect(expandTypes(['IfcBeam', 'IfcRoof'], 'IFC4')).toEqual(['IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCROOF']);
    expect(expandTypes(['IfcRoof', 'IfcBeam'], 'IFC4')).toEqual(['IFCROOF', 'IFCBEAM', 'IFCBEAMSTANDARDCASE']);
  });
});

describe('IFC_SUBTYPES', () => {
  it('is keyed and valued entirely in uppercase', () => {
    // A PascalCase key would never match, because expandTypes uppercases its
    // input before the lookup — the failure would be a silent empty expansion.
    for (const [parent, subtypes] of Object.entries(IFC_SUBTYPES)) {
      expect(parent).toBe(parent.toUpperCase());
      for (const sub of subtypes) expect(sub).toBe(sub.toUpperCase());
    }
  });

  it('never lists a parent as its own subtype', () => {
    for (const [parent, subtypes] of Object.entries(IFC_SUBTYPES)) {
      expect(subtypes).not.toContain(parent);
    }
  });
});

/**
 * `IFC_SUBTYPES` states by hand a relation the generated `SCHEMA_REGISTRY`
 * already states exactly. Two paths that must agree — and they did not: the map
 * carried the nine `*StandardCase` families and no `IFCFURNISHINGELEMENT`, so
 * `byType('IfcFurnishingElement')` answered with nothing on an IFC4 model whose
 * furniture is `IfcFurniture` (#3229). This pins the hand-written map to the
 * generated schema so it cannot fall behind again.
 */
describe('IFC_SUBTYPES agrees with the generated schema registry', () => {
  /** Transitive descendants of `type`, read off the registry's inheritance chains. */
  function registryDescendants(type: string): string[] {
    const upper = type.toUpperCase();
    const out: string[] = [];
    for (const entity of Object.values(SCHEMA_REGISTRY.entities)) {
      const self = entity.name.toUpperCase();
      if (self === upper) continue;
      if ((entity.inheritanceChain ?? []).some(a => a.toUpperCase() === upper)) out.push(self);
    }
    return out.sort();
  }

  it('has a supertype to check, and the registry declares subtypes for each', () => {
    // Anti-vacuity. Both halves of every assertion below are derived — an empty
    // map, or a registry that stopped reporting inheritance chains, would make
    // the per-supertype cases pass by finding nothing to compare.
    expect(Object.keys(IFC_SUBTYPES).length).toBeGreaterThan(0);
    for (const supertype of Object.keys(IFC_SUBTYPES)) {
      expect(registryDescendants(supertype).length, supertype).toBeGreaterThan(0);
    }
  });

  it('lists every subtype the registry declares, for every supertype in the map', () => {
    for (const supertype of Object.keys(IFC_SUBTYPES)) {
      const expanded = expandTypes([supertype], 'IFC4');
      for (const sub of registryDescendants(supertype)) {
        expect(expanded, `${supertype} -> ${sub}`).toContain(sub);
      }
    }
  });

  it('lists no subtype the registry does not declare', () => {
    // The other direction: a typo'd or retired class name in the map is a
    // lookup that can never hit, and nothing else would notice it.
    for (const [supertype, subtypes] of Object.entries(IFC_SUBTYPES)) {
      const declared = registryDescendants(supertype);
      for (const sub of subtypes) {
        expect(declared, `${supertype} -> ${sub}`).toContain(sub);
      }
    }
  });

  it('expands IfcFurnishingElement to IfcFurniture and IfcSystemFurnitureElement', () => {
    // The #3229 instance, named so the regression is legible without rerunning
    // the derivation above.
    const expanded = expandTypes(['IfcFurnishingElement'], 'IFC4');
    expect(expanded).toContain('IFCFURNITURE');
    expect(expanded).toContain('IFCSYSTEMFURNITUREELEMENT');
  });
});

/**
 * The same drift check as above, in the two directions `SCHEMA_REGISTRY`
 * cannot see.
 *
 * That registry is the IFC4_ADD2_TC1 codegen pin, so the block above pins
 * `expandTypes` against IFC4 alone. `entityIndex.byType` is keyed by the names
 * a FILE contains, and those need not belong to the version its header claims:
 * `IfcCourse` is IFC4X3-only, `IfcElectricalElement` IFC2X3-only, and a
 * resolver that consulted one table at a time answered a different set for
 * each header on identical bytes. These read the bundled IFC2X3 and IFC4X3
 * entity tables directly.
 */
describe('expandTypes agrees with the bundled IFC2X3 and IFC4X3 tables too', () => {
  /** Transitive descendants of `type` within one bundled entity table. */
  function tableDescendants(list: readonly { name: string; parent?: string }[], type: string): string[] {
    const children = new Map<string, string[]>();
    for (const entity of list) {
      if (!entity.parent) continue;
      const parent = entity.parent.toUpperCase();
      const bucket = children.get(parent) ?? [];
      bucket.push(entity.name.toUpperCase());
      children.set(parent, bucket);
    }
    const out: string[] = [];
    const stack = [type.toUpperCase()];
    const seen = new Set(stack);
    while (stack.length > 0) {
      for (const child of children.get(stack.pop() as string) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        stack.push(child);
      }
    }
    return out.sort();
  }

  const BASES = ['IFCWALL', 'IFCSLAB', 'IFCFURNISHINGELEMENT', 'IFCBUILDINGELEMENT', 'IFCBUILTELEMENT'];
  const RENAME_PAIR = ['IFCBUILDINGELEMENT', 'IFCBUILTELEMENT'];

  it.each([
    ['IFC2X3', ENTITIES_IFC2X3],
    ['IFC4X3', ENTITIES_IFC4X3],
  ])('lists every subtype the %s table declares, for every base', (version, list) => {
    // Anti-vacuity: at least one base has to have subtypes in this table, or
    // the loop below would pass by finding nothing to compare.
    expect(BASES.some((b) => tableDescendants(list, b).length > 0), version).toBe(true);
    for (const base of BASES) {
      const expanded = expandTypes([base], version);
      for (const sub of tableDescendants(list, base)) {
        expect(expanded, `${version}: ${base} -> ${sub}`).toContain(sub);
      }
    }
  });

  /**
   * The other direction, and the one nothing else states: every name the
   * expansion returns that the file's own schema DECLARES has to be a
   * descendant of the base in that same table.
   *
   * The positive check above cannot see an over-match, and the union this
   * replaces failed exactly here: `IfcReinforcingBar` is declared by the IFC4
   * table under `IfcElementComponent`, so it was in the expansion of
   * `IfcBuildingElement` on IFC4 and no assertion in this file objected. Names
   * the schema does NOT declare are rule (b)'s business and are excluded from
   * the check by construction; the rename pair is the one reasoned exception,
   * since neither spelling is declared by both tables.
   */
  it.each([
    ['IFC2X3', ENTITIES_IFC2X3],
    ['IFC4', ENTITIES_IFC4],
    ['IFC4X3', ENTITIES_IFC4X3],
  ])('adds no name %s declares under a different parent', (version, list) => {
    const declared = new Set(list.map((e) => e.name.toUpperCase()));
    let checked = 0;
    for (const base of BASES) {
      const allowed = new Set([base, ...RENAME_PAIR, ...tableDescendants(list, base)]);
      // The rename pair's own subtree is legitimate under either spelling.
      for (const other of RENAME_PAIR) for (const d of tableDescendants(list, other)) allowed.add(d);
      for (const name of expandTypes([base], version)) {
        if (!declared.has(name)) continue; // rule (b): this schema has no opinion
        checked++;
        expect(allowed, `${version}: ${base} must not reach ${name}`).toContain(name);
      }
    }
    // Anti-vacuity: without this the test passes on an empty expansion, or on
    // one where every name happens to be outside the table.
    expect(checked, `${version} had declared names to check`).toBeGreaterThan(BASES.length);
  });

  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('reaches across the IfcBuiltElement rename on %s', (version) => {
    // IfcBuildingElement is absent from the IFC4X3 table and IfcBuiltElement
    // from the IFC4 one, so without the rename equality each spelling is blind
    // to the other version's leaves on every header.
    expect(expandTypes(['IfcBuildingElement'], version)).toContain('IFCCOURSE');
    expect(expandTypes(['IfcBuiltElement'], version)).toContain('IFCWALLSTANDARDCASE');
  });

  it('honours the alias tables in the descendant direction, not just the ancestor one', () => {
    // `resolveEntityNameAlias` has always resolved these leaves upward. The
    // descendant direction did not, so `byType('IfcGeotechnicalStratum')`
    // answered 0 on a file full of IFCSOLIDSTRATUM records.
    expect(Object.keys(ENTITY_NAME_ALIASES).length).toBeGreaterThan(0);
    for (const version of ['IFC2X3', 'IFC4', 'IFC4X3']) {
      for (const [leaf, supertype] of Object.entries(ENTITY_NAME_ALIASES)) {
        expect(expandTypes([supertype], version), `${version}: ${supertype} -> ${leaf}`).toContain(
          leaf.toUpperCase(),
        );
      }
    }
    // The one rename pair, spelled out rather than read off the resolver's own
    // table: deriving the expectation from the thing under test would pass on
    // an empty table.
    const a = expandTypes(['IfcBuildingElement'], 'IFC4').filter((n) => !RENAME_PAIR.includes(n));
    const b = expandTypes(['IfcBuiltElement'], 'IFC4').filter((n) => !RENAME_PAIR.includes(n));
    expect(a.sort()).toEqual(b.sort());
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('QUERY_REL_TYPE_MAP', () => {
  it('is keyed by the PascalCase IFC entity name a caller writes', () => {
    // entityIndex keys are uppercase, but this map is keyed by what a caller
    // passes to `related()`. Uppercasing it would make every lookup miss and
    // `related()` would quietly answer with no edges.
    for (const key of Object.keys(QUERY_REL_TYPE_MAP)) {
      expect(key.startsWith('IfcRel')).toBe(true);
    }
  });

  it('resolves the five relationships the SDK surface exposes', () => {
    expect(QUERY_REL_TYPE_MAP.IfcRelContainedInSpatialStructure).toBe(RelationshipType.ContainsElements);
    expect(QUERY_REL_TYPE_MAP.IfcRelAggregates).toBe(RelationshipType.Aggregates);
    expect(QUERY_REL_TYPE_MAP.IfcRelDefinesByType).toBe(RelationshipType.DefinesByType);
    expect(QUERY_REL_TYPE_MAP.IfcRelVoidsElement).toBe(RelationshipType.VoidsElement);
    expect(QUERY_REL_TYPE_MAP.IfcRelFillsElement).toBe(RelationshipType.FillsElement);
  });

  it('answers undefined for a relationship outside the SDK surface', () => {
    // The backends return no edges for an unknown name rather than throwing;
    // that only holds while the lookup misses rather than resolving to 0.
    expect(QUERY_REL_TYPE_MAP.IfcRelAssociatesMaterial).toBeUndefined();
  });
});
