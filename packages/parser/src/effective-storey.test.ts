/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';
import { effectiveStoreyId, effectiveStoreyResolver } from './effective-storey.js';
import type { EffectiveSpatialContext } from './effective-spatial-members.js';
import type { EffectiveRelationship } from './effective-relationship-overlay.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDING('0000000000000000000002',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#3=IFCBUILDINGSTOREY('0000000000000000000003',$,'L0',$,$,$,$,$,.ELEMENT.,0.);
#4=IFCSPACE('0000000000000000000004',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#5=IFCWALL('0000000000000000000005',$,'Wall',$,$,$,$,$,$);
#10=IFCRELAGGREGATES('0000000000000000000010',$,$,$,#1,(#2));
#11=IFCRELAGGREGATES('0000000000000000000011',$,$,$,#2,(#3));
#12=IFCRELAGGREGATES('0000000000000000000012',$,$,$,#3,(#4));
#13=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000013',$,$,$,(#5),#3);
ENDSEC;END-ISO-10303-21;`;

describe('effectiveStoreyId', () => {
  // #6232 M4: with any edit pending, a space its storey aggregates resolved to
  // no storey, though the parsed model maps it to that storey (#1075), so
  // Split and the Room tool's Update refused every IfcSpace of an edited model.
  it('puts a space its storey aggregates on that storey, with or without pending edits', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
    const edited: EffectiveSpatialContext = {
      relationships: { relationships: [], supersededSourceIds: new Set() },
      isDeleted: () => false,
      typeName: (id) => store.entities.getTypeName(id),
    };
    expect(effectiveStoreyId(store, 4)).toBe(3);
    expect(effectiveStoreyId(store, 4, edited)).toBe(3);
    expect(effectiveStoreyId(store, 5, edited)).toBe(3);
    expect(effectiveStoreyId(store, 3, edited), 'a storey is on no storey').toBeUndefined();
  });

  it('never puts a space on a storey that is deleted in the same edit', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
    const storeyDeleted: EffectiveSpatialContext = {
      relationships: { relationships: [], supersededSourceIds: new Set() },
      isDeleted: (id) => id === 3,
      typeName: (id) => store.entities.getTypeName(id),
    };
    expect(effectiveStoreyId(store, 4, storeyDeleted)).toBeUndefined();
  });

  // #9668: the structural derivation resolves every element under one context.
  it('resolves many products under one context with the edited relationships read once', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
    let reads = 0;
    // An edit moves the wall from the storey into the space, which the storey aggregates.
    const relationships: EffectiveRelationship[] = [{ relationshipId: 20, relationshipType: 'IfcRelContainedInSpatialStructure', relating: [4], related: [5] }];
    const edited: EffectiveSpatialContext = {
      relationships: { get relationships() { reads++; return relationships; }, supersededSourceIds: new Set([13]) },
      isDeleted: () => false,
      typeName: (id) => store.entities.getTypeName(id),
    };
    const storeyOf = effectiveStoreyResolver(store, edited);
    expect([3, 4, 5].map(storeyOf)).toEqual([undefined, 3, 3]);
    expect([3, 4, 5].map((id) => effectiveStoreyId(store, id, edited))).toEqual([undefined, 3, 3]);
    expect(reads, 'one read for the resolver, one per effectiveStoreyId call').toBe(4);
  });
});
