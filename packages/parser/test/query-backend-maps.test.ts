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
import {
  RelationshipType,
  ENTITIES_IFC2X3,
  ENTITIES_IFC4X3,
  ENTITY_NAME_ALIASES,
  CROSS_SCHEMA_RENAMES,
} from '@ifc-lite/data';
import { SCHEMA_REGISTRY } from '../src/generated/schema-registry.js';

describe('expandTypes', () => {
  it('includes both IFC4 case subtypes of IfcWall', () => {
    const result = expandTypes(['IfcWall']);
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).toContain('IFCWALLELEMENTEDCASE');
  });

  it('includes both IFC4 case subtypes of IfcSlab', () => {
    // The mutation that survived: dropping IFCSLABELEMENTEDCASE from one copy
    // silently narrowed `byType('IfcSlab')` on that surface alone.
    const result = expandTypes(['IfcSlab']);
    expect(result).toContain('IFCSLABSTANDARDCASE');
    expect(result).toContain('IFCSLABELEMENTEDCASE');
  });

  it('passes through a type with no known subtypes', () => {
    expect(expandTypes(['IfcRoof'])).toEqual(['IFCROOF']);
  });

  it('uppercases lowercase input, since entityIndex.byType is uppercase-keyed', () => {
    expect(expandTypes(['ifcwall'])).toContain('IFCWALL');
  });

  it('expands every type in the list', () => {
    const result = expandTypes(['IfcWall', 'IfcRoof']);
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).toContain('IFCROOF');
  });

  it('returns nothing for an empty list', () => {
    expect(expandTypes([])).toEqual([]);
  });

  it('lists the parent type before its subtypes', () => {
    // Callers build a Set from this, but the parent-first order is what makes
    // the result readable in a debug dump; pin it so a rewrite keeps it.
    expect(expandTypes(['IfcBeam'])).toEqual(['IFCBEAM', 'IFCBEAMSTANDARDCASE']);
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
      const expanded = expandTypes([supertype]);
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
    const expanded = expandTypes(['IfcFurnishingElement']);
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

  it.each([
    ['IFC2X3', ENTITIES_IFC2X3],
    ['IFC4X3', ENTITIES_IFC4X3],
  ])('lists every subtype the %s table declares, for every base', (version, list) => {
    // Anti-vacuity: at least one base has to have subtypes in this table, or
    // the loop below would pass by finding nothing to compare.
    expect(BASES.some((b) => tableDescendants(list, b).length > 0), version).toBe(true);
    for (const base of BASES) {
      const expanded = expandTypes([base]);
      for (const sub of tableDescendants(list, base)) {
        expect(expanded, `${version}: ${base} -> ${sub}`).toContain(sub);
      }
    }
  });

  it('reaches IfcCourse from IfcBuildingElement, the IFC4X3 rename of its own base', () => {
    // IfcBuildingElement is absent from the IFC4X3 table and IfcBuiltElement
    // from the IFC4 one, so the union of the tables alone leaves each spelling
    // blind to the other version's leaves.
    expect(expandTypes(['IfcBuildingElement'])).toContain('IFCCOURSE');
    expect(expandTypes(['IfcBuiltElement'])).toContain('IFCWALLSTANDARDCASE');
  });

  it('honours the alias tables in the descendant direction, not just the ancestor one', () => {
    // `resolveEntityNameAlias` has always resolved these leaves upward. The
    // descendant direction did not, so `byType('IfcGeotechnicalStratum')`
    // answered 0 on a file full of IFCSOLIDSTRATUM records.
    expect(Object.keys(ENTITY_NAME_ALIASES).length).toBeGreaterThan(0);
    for (const [leaf, supertype] of Object.entries(ENTITY_NAME_ALIASES)) {
      expect(expandTypes([supertype]), `${supertype} -> ${leaf}`).toContain(leaf.toUpperCase());
    }
    expect(CROSS_SCHEMA_RENAMES.length).toBeGreaterThan(0);
    for (const [older, newer] of CROSS_SCHEMA_RENAMES) {
      const a = expandTypes([older]).filter((n) => n !== older && n !== newer);
      const b = expandTypes([newer]).filter((n) => n !== older && n !== newer);
      expect(a.sort(), `${older} vs ${newer}`).toEqual(b.sort());
    }
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
