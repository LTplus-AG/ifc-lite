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
import { RelationshipType } from '@ifc-lite/data';

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
