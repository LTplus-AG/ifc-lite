/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import {
  ASSOCIATION_REL_TYPES, HIERARCHY_REL_TYPES, PROPERTY_REL_TYPES, REL_TYPE_MAP,
} from './columnar-parser-indexes.js';
import { prepareColumnarEntities } from './columnar-entity-preparation.js';
import { getRelationshipSlotPlan, getAllConcreteRelationshipTypes, getConcreteRelationshipTypes } from './relationship-schema-slots.js';

describe('relationship-schema-slots (#4205)', () => {
  it('resolves a plain default-shaped subtype (relating then related list)', () => {
    // IfcRelDeclares: RelatingContext (single, post-root index 0),
    // RelatedDefinitions (list, index 1) — no inherited attrs to skip over.
    const plan = getRelationshipSlotPlan('IFCRELDECLARES');
    expect(plan).toEqual({ relating: { index: 0, isList: false }, related: { index: 1, isList: true } });
  });

  it('resolves a subtype where the related slot comes BEFORE relating (IfcRelAssigns family)', () => {
    // IfcRelAssignsToActor inherits RelatedObjects/RelatedObjectsType from
    // IfcRelAssigns (indices 0, 1) before its own RelatingActor (index 2) —
    // the opposite attribute order from the "default" shape above. A
    // resolver that assumed relating always comes first would misread this.
    const plan = getRelationshipSlotPlan('IFCRELASSIGNSTOACTOR');
    expect(plan).toEqual({ relating: { index: 2, isList: false }, related: { index: 0, isList: true } });
  });

  it('resolves a subtype where both slots are single references, not lists (port topology)', () => {
    const plan = getRelationshipSlotPlan('IFCRELCONNECTSPORTTOELEMENT');
    expect(plan?.relating.isList).toBe(false);
    expect(plan?.related.isList).toBe(false);
  });

  it('does not mistake a same-prefixed non-reference attribute for the ref slot', () => {
    // IfcRelConnectsPathElements adds RelatingPriorities (IfcInteger LIST)
    // and RelatingConnectionType (enum) ahead of the inherited
    // RelatingElement/RelatedElement it actually shares an edge through.
    // Neither is a reference — picking either up as "the relating slot"
    // would scan the wrong bytes entirely.
    const plan = getRelationshipSlotPlan('IFCRELCONNECTSPATHELEMENTS');
    expect(plan).toBeDefined();
    expect(plan!.relating.isList).toBe(false); // RelatingElement, not the RelatingPriorities LIST
  });

  it('resolves an IFC4X3-only subtype absent from the IFC4-pinned registry', () => {
    const plan = getRelationshipSlotPlan('IFCRELPOSITIONS');
    expect(plan).toEqual({ relating: { index: 0, isList: false }, related: { index: 1, isList: true } });
  });

  it('answers undefined for a name no bundled schema knows', () => {
    expect(getRelationshipSlotPlan('IFCRELTOTALLYMADEUP')).toBeUndefined();
  });

  it('every REL_TYPE_MAP key reaches its correct category and resolves a schema slot plan (#4672)', async () => {
    const entries = Object.entries(REL_TYPE_MAP);
    expect(entries.length).toBeGreaterThan(0);
    const prepared = await prepareColumnarEntities(entries.map(([type], index) => ({
      expressId: index + 1, type, byteOffset: 0, byteLength: 0, lineNumber: 0,
    })), false, async () => {});
    const union = getAllConcreteRelationshipTypes();
    for (const [type, relationshipType] of entries) {
      // Assert the routing contract independently of membership in the
      // production gate sets: properties and these three associations have
      // specialized extraction; every other mapped type needs hierarchy
      // extraction. In particular, DefinesByType belongs to hierarchy.
      const property = relationshipType === RelationshipType.DefinesByProperties;
      const association = [RelationshipType.AssociatesMaterial,
        RelationshipType.AssociatesClassification, RelationshipType.AssociatesDocument,
      ].includes(relationshipType);
      const hierarchy = !property && !association;
      expect(union.has(type), type).toBe(true);
      expect([
        PROPERTY_REL_TYPES.has(type), ASSOCIATION_REL_TYPES.has(type), HIERARCHY_REL_TYPES.has(type),
      ], type).toEqual([property, association, hierarchy]);
      expect([
        prepared.propertyRelRefs.some(ref => ref.type === type),
        prepared.associationRelRefs.some(ref => ref.type === type),
        prepared.relationshipRefs.some(ref => ref.type === type),
      ], type).toEqual([property, association, hierarchy]);
      expect(getRelationshipSlotPlan(type), type).toBeDefined();
    }
  });

  it('excludes abstract IfcRelationship supertypes from the GATE', () => {
    const union = getAllConcreteRelationshipTypes();
    // IfcRelAssociates is deliberately excluded from this list: it is
    // abstract in IFC4/IFC4X3 but NOT in IFC2X3 (`isAbstract: false` in the
    // codegen-generated `ifc2x3/schema-registry.ts`) — a real schema
    // difference, not a derivation bug, so the union correctly includes it.
    for (const abstractName of ['IFCRELATIONSHIP', 'IFCRELASSIGNS', 'IFCRELCONNECTS', 'IFCRELDECOMPOSES', 'IFCRELDEFINES']) {
      expect(union.has(abstractName)).toBe(false);
    }
  });

  it('per-version lookup answers only what that version actually declares', () => {
    // IfcRelPositions is IFC4X3-only.
    expect(getConcreteRelationshipTypes('IFC4').has('IFCRELPOSITIONS')).toBe(false);
    expect(getConcreteRelationshipTypes('IFC4X3').has('IFCRELPOSITIONS')).toBe(true);
  });
});
