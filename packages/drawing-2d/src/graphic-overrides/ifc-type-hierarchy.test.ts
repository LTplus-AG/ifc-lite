/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-parity guard for the graphic-override subtype table.
 *
 * The table shipped drifted — 10 of `IfcBuildingElement`'s subtypes and 74 of
 * `IfcDistributionElement`'s were missing, and one key (`IfcFlowElement`) was
 * not an IFC entity at all. Nothing caught it because nothing compared the
 * table to a schema. This does, in both directions, against `@ifc-lite/data`'s
 * `ENTITIES_IFC4` — an authority independent of the one the table was
 * generated from (the parser's `SCHEMA_REGISTRY`).
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC4 } from '@ifc-lite/data';
import {
  SUBTYPES_BY_SUPERTYPE,
  AUTHORING_ALIASES,
  getIfcSubtypes,
} from './ifc-type-hierarchy.js';

/** Roots the table claims to cover: what a 2D drawing can contain. */
const COVERED_ROOTS = ['IfcElement', 'IfcSpatialElement'] as const;

const IFC4_NAMES = new Set(ENTITIES_IFC4.map((e) => e.name));

const CHILDREN = new Map<string, string[]>();
for (const entity of ENTITIES_IFC4) {
  if (!entity.parent) continue;
  const siblings = CHILDREN.get(entity.parent) ?? [];
  siblings.push(entity.name);
  CHILDREN.set(entity.parent, siblings);
}

function schemaDescendants(root: string): string[] {
  const out: string[] = [];
  const walk = (node: string): void => {
    for (const child of CHILDREN.get(node) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Every entity the table is expected to know about. */
const COVERED = new Set<string>([
  ...COVERED_ROOTS,
  ...COVERED_ROOTS.flatMap(schemaDescendants),
]);

describe('IFC type hierarchy vs IFC4 schema', () => {
  it('derives a non-trivial universe from the schema (anti-vacuity)', () => {
    // If ENTITIES_IFC4 failed to load or the parent walk broke, COVERED would
    // collapse and every subset assertion below would pass vacuously.
    expect(IFC4_NAMES.size).toBeGreaterThan(500);
    expect(COVERED.size).toBeGreaterThan(100);
    for (const root of COVERED_ROOTS) {
      expect(schemaDescendants(root).length).toBeGreaterThan(0);
    }
  });

  it('resolves every schema subtype of every covered supertype', () => {
    const gaps: string[] = [];
    for (const supertype of COVERED) {
      const expected = schemaDescendants(supertype);
      if (expected.length === 0) continue;
      const resolved = new Set(getIfcSubtypes(supertype));
      const missing = expected.filter((name) => !resolved.has(name));
      if (missing.length > 0) {
        gaps.push(`${supertype} does not reach: ${missing.sort().join(', ')}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('lists only real IFC4 entities', () => {
    const unknown: string[] = [];
    for (const [supertype, subtypes] of Object.entries(SUBTYPES_BY_SUPERTYPE)) {
      if (!IFC4_NAMES.has(supertype)) unknown.push(`key ${supertype}`);
      for (const subtype of subtypes) {
        if (!IFC4_NAMES.has(subtype)) unknown.push(`${supertype} -> ${subtype}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('claims only edges the schema actually has', () => {
    const wrong: string[] = [];
    for (const [supertype, subtypes] of Object.entries(SUBTYPES_BY_SUPERTYPE)) {
      const actual = new Set(CHILDREN.get(supertype) ?? []);
      for (const subtype of subtypes) {
        if (!actual.has(subtype)) wrong.push(`${supertype} -> ${subtype}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('stays within the covered roots', () => {
    // A key outside IfcElement/IfcSpatialElement means the table grew a branch
    // the parity check above does not police.
    const strays = Object.keys(SUBTYPES_BY_SUPERTYPE).filter((k) => !COVERED.has(k));
    expect(strays).toEqual([]);
  });
});

describe('authoring aliases', () => {
  it('are exactly the three documented non-schema conveniences', () => {
    // Pins intent: a new alias must be added deliberately, with a reason.
    expect(Object.keys(AUTHORING_ALIASES).sort()).toEqual([
      'IfcFlowElement',
      'IfcRamp',
      'IfcStair',
    ]);
  });

  it('point at real IFC4 entities', () => {
    for (const [alias, targets] of Object.entries(AUTHORING_ALIASES)) {
      for (const target of targets) {
        expect(IFC4_NAMES.has(target), `${alias} -> ${target}`).toBe(true);
      }
    }
  });

  it('IfcFlowElement is not an entity in any bundled schema, and maps to the real supertype', () => {
    expect(IFC4_NAMES.has('IfcFlowElement')).toBe(false);
    const resolved = getIfcSubtypes('IfcFlowElement');
    expect(resolved).toContain('IfcDistributionFlowElement');
    // It now reaches the whole flow subtree, not the four names it used to list.
    for (const name of ['IfcFlowSegment', 'IfcDuctSegment', 'IfcAirTerminal', 'IfcValve']) {
      expect(resolved).toContain(name);
    }
  });

  it('keep IfcStair/IfcRamp reaching their flights', () => {
    expect(getIfcSubtypes('IfcStair')).toContain('IfcStairFlight');
    expect(getIfcSubtypes('IfcRamp')).toContain('IfcRampFlight');
  });
});

describe('getIfcSubtypes', () => {
  it('returns [] for an unknown or leaf type', () => {
    expect(getIfcSubtypes('IfcNotAnEntity')).toEqual([]);
    expect(getIfcSubtypes('IfcWallStandardCase')).toEqual([]);
  });

  it('returns each name once', () => {
    const resolved = getIfcSubtypes('IfcElement');
    expect(resolved.length).toBe(new Set(resolved).size);
  });
});
