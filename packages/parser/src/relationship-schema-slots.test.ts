/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
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

  it('the schema-derived GATE contains every concrete IfcRelationship subtype used in this codebase\'s REL_TYPE_MAP, across schema versions', () => {
    const union = getAllConcreteRelationshipTypes();
    for (const t of [
      'IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCRELAGGREGATES', 'IFCRELNESTS',
      'IFCRELASSIGNSTOACTOR', 'IFCRELDECLARES', 'IFCRELSEQUENCE',
      'IFCRELPOSITIONS', 'IFCRELADHERESTOELEMENT',
    ]) {
      expect(union.has(t)).toBe(true);
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
