/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a caller may and may not assume when it swaps the IFC4-pinned
 * inheritance lookup for the cross-schema one (#2001, #2003).
 *
 * Two call-site families depend on this:
 *
 * - The **membership tests** — `chain.includes('IfcRoot')` in the CLI's
 *   `validate` and the MCP `model_audit`, `chain.includes('IfcObjectDefinition')`
 *   in `diff-scope.ts` / `diff-fingerprints.ts`. They may swap freely: over
 *   every class the pin carries the two lookups agree on every verdict and on
 *   the leaf's own name.
 * - The **chain reporters** — MCP `schema_describe`, which hands the chain to
 *   the caller. They may not: the two disagree on the *content* of the chain
 *   for 62 pinned classes, because the schema union lets IFC4X3 win a name
 *   collision (`IfcBuildingElement` → `IfcBuiltElement`, `IfcFacility` inserted
 *   above `IfcBuilding`). `schema_describe` therefore keeps the pin as its
 *   primary source and uses the union only for classes the pin has no row for.
 *
 * And nobody may index positionally: the pinned chain is root→leaf and the union
 * walk is leaf→root, so `chain[0]` names a different class on 717 of the 776.
 * The union walk also *falls back* to the pin, which would answer in the
 * opposite order again — unreachable today because the bundled tables cover
 * every pinned class, and asserted here so it stays that way.
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import { SCHEMA_REGISTRY, getInheritanceChainForEntity } from '../src/generated/schema-registry.js';
import { getInheritanceChain as getInheritanceChainAcrossSchemas } from '../src/ifc-schema.js';

/**
 * The bundled schema tables, keyed uppercase — the same union
 * `getInheritanceChainFromSchemaUnion` walks, read here directly.
 *
 * Asking the *public* function whether the union knows a class cannot answer:
 * it falls back to the pinned registry when the union comes up empty, so for a
 * pinned class it is non-empty either way and the question is unaskable. A test
 * that goes through the fallback to detect a gap the fallback exists to hide is
 * a test that cannot fail.
 */
const UNION_BY_UPPER = new Set(
  [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]
    .flatMap((list) => list.map((entity) => entity.name.toUpperCase())),
);

const PINNED = Object.keys(SCHEMA_REGISTRY.entities);

/** The chain entry naming the class itself, wherever the source put it. */
function leafOf(chain: string[], type: string): string | undefined {
  return chain.find((ancestor) => ancestor.toUpperCase() === type.toUpperCase());
}

describe('getInheritanceChainForEntity vs getInheritanceChainAcrossSchemas', () => {
  it('covers the whole IFC4_ADD2_TC1 pin', () => {
    expect(PINNED.length).toBe(776);
  });

  it('agrees on every membership verdict, so no IFC4 file changes behaviour', () => {
    const disagreements: string[] = [];
    for (const type of PINNED) {
      const pinned = getInheritanceChainForEntity(type);
      const cross = getInheritanceChainAcrossSchemas(type);
      for (const ancestor of ['IfcRoot', 'IfcObjectDefinition', 'IfcRelationship', 'IfcPropertyDefinition']) {
        if (pinned.includes(ancestor) !== cross.includes(ancestor)) {
          disagreements.push(`${type}/${ancestor}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('agrees on every leaf name', () => {
    const disagreements: string[] = [];
    for (const type of PINNED) {
      const pinned = leafOf(getInheritanceChainForEntity(type), type);
      const cross = leafOf(getInheritanceChainAcrossSchemas(type), type);
      if (pinned !== cross) disagreements.push(`${type}: ${pinned} vs ${cross}`);
    }
    expect(disagreements).toEqual([]);
  });

  it('answers a chain for classes outside the pin, which is the whole point', () => {
    // IFC2X3-only (dropped from IFC4) and IFC4X3-only classes.
    for (const type of ['IfcScheduleTimeControl', 'IfcSpaceProgram', 'IfcServiceLife', 'IfcMove', 'IfcCourse', 'IfcBorehole']) {
      expect(getInheritanceChainForEntity(type), type).toEqual([]);
      expect(getInheritanceChainAcrossSchemas(type), type).toContain('IfcRoot');
    }
  });

  it('returns opposite orders, so positional access inverts on 717 of 776 classes', () => {
    let inverted = 0;
    let trivial = 0;
    for (const type of PINNED) {
      const pinned = getInheritanceChainForEntity(type);
      const cross = getInheritanceChainAcrossSchemas(type);
      if (pinned[0] !== cross[0]) inverted++;
      else trivial++;
    }
    expect(inverted).toBe(717);
    // The 59 that survive positional access are the single-element chains — the
    // EXPRESS roots, where leaf and root are the same entry.
    expect(trivial).toBe(59);
    for (const type of PINNED) {
      if (getInheritanceChainForEntity(type)[0] === getInheritanceChainAcrossSchemas(type)[0]) {
        expect(getInheritanceChainForEntity(type).length, type).toBe(1);
      }
    }
    // The pinned lookup is root→leaf …
    expect(getInheritanceChainForEntity('IfcWall')[0]).toBe('IfcRoot');
    // … and the cross-schema one is leaf→root, for the same class.
    expect(getInheritanceChainAcrossSchemas('IfcWall')[0]).toBe('IfcWall');
  });

  it('has no pinned class the schema union misses, which is what pins its order today', () => {
    // `getInheritanceChainAcrossSchemas` walks the union first and *falls back*
    // to the pin — and the fallback answers in the opposite order. Today that
    // branch is unreachable for a pinned class, so the function's order is
    // uniformly leaf→root. If a regenerated pin ever gains a class the bundled
    // tables lack, this flips and the same function starts returning both
    // orders; positional readers would invert silently.
    //
    // Membership is read off the union tables, NOT off the public function:
    // the fallback would make every pinned class look present and this
    // assertion vacuous.
    const unionMisses = PINNED.filter((type) => !UNION_BY_UPPER.has(type.toUpperCase()));
    expect(unionMisses).toEqual([]);
  });

  it('is a question the public function cannot answer, which is why the tables are read directly', () => {
    // The guard on the guard. Every pinned class resolves non-empty through the
    // public function whether the union knows it or not, because of the
    // fallback — so a `unionMisses` computed that way is empty by construction
    // and would keep passing after the union lost the class.
    const throughTheFallback = PINNED.filter((type) => getInheritanceChainAcrossSchemas(type).length === 0);
    expect(throughTheFallback).toEqual([]);
    for (const type of PINNED) expect(getInheritanceChainForEntity(type).length).toBeGreaterThan(0);
  });

  it('answers nothing for a class no schema declares', () => {
    expect(UNION_BY_UPPER.has('IFCACMEVENDOREXTENSION')).toBe(false);
    expect(getInheritanceChainAcrossSchemas('IfcAcmeVendorExtension')).toEqual([]);
    expect(getInheritanceChainForEntity('IfcAcmeVendorExtension')).toEqual([]);
  });

  it('disagrees on chain content for the 62 classes IFC4X3 renamed a supertype of', () => {
    const differing: string[] = [];
    for (const type of PINNED) {
      const pinned = new Set(getInheritanceChainForEntity(type));
      const cross = new Set(getInheritanceChainAcrossSchemas(type));
      if (pinned.size !== cross.size || [...pinned].some((a) => !cross.has(a))) differing.push(type);
    }
    expect(differing.length).toBe(62);
    // IFC4 says IfcBuildingElement; the union answers with IFC4X3's rename.
    expect(getInheritanceChainForEntity('IfcBeam')).toContain('IfcBuildingElement');
    expect(getInheritanceChainAcrossSchemas('IfcBeam')).toContain('IfcBuiltElement');
  });
});
