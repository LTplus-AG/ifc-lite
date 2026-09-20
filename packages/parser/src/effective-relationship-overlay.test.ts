/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { IfcAttributeValue } from '@ifc-lite/data';
import { IfcParser } from './index.js';
import { getAttributeNamesForSchema } from './ifc-schema.js';
import { effectiveRelationshipEdges, resolveEffectiveRelationshipOverlay } from './effective-relationship-overlay.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDING('0000000000000000000002',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#3=IFCWALL('0000000000000000000003',$,'Old',$,$,$,$,$,$);
#4=IFCWALL('0000000000000000000004',$,'New',$,$,$,$,$,$);
#5=IFCRELAGGREGATES('0000000000000000000005',$,$,$,#2,(#3));
ENDSEC;END-ISO-10303-21;`;

const IFC2X3_COVERS = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC2X3'));ENDSEC;
DATA;
#2=IFCSPACE('0000000000000000000002',$,'Space',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#3=IFCCOVERING('0000000000000000000003',$,'Covering',$,$,$,$,$,$,.FLOORING.);
#5=IFCRELCOVERSSPACES('0000000000000000000005',$,$,$,#2,(#3));
ENDSEC;END-ISO-10303-21;`;

const IFC_PROPERTY_SET = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#3=IFCWALL('0000000000000000000003',$,'Old',$,$,$,$,$,$);
#4=IFCWALL('0000000000000000000004',$,'New',$,$,$,$,$,$);
#20=IFCPROPERTYSET('0000000000000000000020',$,'First',$,());
#21=IFCPROPERTYSET('0000000000000000000021',$,'Second',$,());
#30=IFCRELDEFINESBYPROPERTIES('0000000000000000000030',$,$,$,(#3),(#20,#21));
ENDSEC;END-ISO-10303-21;`;

describe('effective relationship overlay (#5009)', () => {
  it('uses the model schema instead of a cross-schema attribute spelling', () => {
    expect(getAttributeNamesForSchema('IfcRelCoversSpaces', 'IFC2X3')[4]).toBe('RelatedSpace');
    expect(getAttributeNamesForSchema('IfcRelCoversSpaces', 'IFC4')[4]).toBe('RelatingSpace');
  });

  it('suppresses a parsed edge and resolves its named endpoint edit', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
    const named = new Map<number, ReadonlyMap<string, unknown>>([[5, new Map([['RelatedObjects', '#4']])]]);
    const overlay = resolveEffectiveRelationshipOverlay(store, {
      createdEntities: () => [],
      mutatedEntityIds: () => named.keys(),
      namedAttributes: id => named.get(id) ?? [],
      positionalAttributes: () => [] as Array<readonly [number, IfcAttributeValue]>,
      isDeleted: () => false,
    });
    expect(overlay.supersededSourceIds).toEqual(new Set([5]));
    expect(effectiveRelationshipEdges(overlay, () => false, 2, 'IfcRelAggregates')).toEqual([{
      relationshipId: 5,
      relationshipType: 'IfcRelAggregates',
      direction: 'forward',
      targetId: 4,
    }]);
  });

  it('uses the IFC2X3 schema slots when both endpoints start with Related', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC2X3_COVERS).buffer as ArrayBuffer);
    const overlay = resolveEffectiveRelationshipOverlay(store, {
      createdEntities: () => [],
      mutatedEntityIds: () => [5],
      namedAttributes: () => [['RelatedCoverings', ['#3']]],
      positionalAttributes: () => [] as Array<readonly [number, IfcAttributeValue]>,
      isDeleted: () => false,
    });
    expect(effectiveRelationshipEdges(overlay, () => false, 2, 'IfcRelCoversSpaces')).toEqual([{
      relationshipId: 5,
      relationshipType: 'IfcRelCoversSpaces',
      direction: 'forward',
      targetId: 3,
    }]);
  });

  it('retains every relating definition in an aggregate select', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC_PROPERTY_SET).buffer as ArrayBuffer);
    const overlay = resolveEffectiveRelationshipOverlay(store, {
      createdEntities: () => [],
      mutatedEntityIds: () => [30],
      namedAttributes: () => [['RelatedObjects', ['#4']]],
      positionalAttributes: () => [] as Array<readonly [number, IfcAttributeValue]>,
      isDeleted: () => false,
    });
    expect(effectiveRelationshipEdges(overlay, () => false, 4, 'IfcRelDefinesByProperties')).toEqual([
      { relationshipId: 30, relationshipType: 'IfcRelDefinesByProperties', direction: 'inverse', targetId: 20 },
      { relationshipId: 30, relationshipType: 'IfcRelDefinesByProperties', direction: 'inverse', targetId: 21 },
    ]);
    expect(effectiveRelationshipEdges(overlay, () => false, 21, 'IfcRelDefinesByProperties')).toEqual([
      { relationshipId: 30, relationshipType: 'IfcRelDefinesByProperties', direction: 'forward', targetId: 4 },
    ]);
  });

  it('matches export precedence when named and positional edits share a slot (#5009)', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
    const overlay = resolveEffectiveRelationshipOverlay(store, {
      createdEntities: () => [],
      mutatedEntityIds: () => [5],
      namedAttributes: () => [['RelatedObjects', ['#3']]],
      positionalAttributes: () => [[5, ['#4']]],
      isDeleted: () => false,
    });

    expect(effectiveRelationshipEdges(overlay, () => false, 2, 'IfcRelAggregates')).toEqual([{
      relationshipId: 5,
      relationshipType: 'IfcRelAggregates',
      direction: 'forward',
      targetId: 4,
    }]);
  });

  it('classifies a parsed relationship by its queued effective type (#5009 review)', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
    const overlay = resolveEffectiveRelationshipOverlay(store, {
      createdEntities: () => [],
      mutatedEntityIds: () => [5],
      namedAttributes: () => [],
      positionalAttributes: () => [],
      entityType: () => 'IfcRelNests',
      isDeleted: () => false,
    });

    expect(effectiveRelationshipEdges(overlay, () => false, 2, 'IfcRelAggregates')).toEqual([]);
    expect(effectiveRelationshipEdges(overlay, () => false, 2, 'IfcRelNests')).toEqual([{
      relationshipId: 5,
      relationshipType: 'IfcRelNests',
      direction: 'forward',
      targetId: 3,
    }]);
  });

  it('includes a parsed non-relationship retyped into a relationship (#5009 review)', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
    const overlay = resolveEffectiveRelationshipOverlay(store, {
      createdEntities: () => [],
      mutatedEntityIds: () => [3],
      namedAttributes: () => [],
      positionalAttributes: () => [[4, '#2'], [5, ['#4']]],
      entityType: () => 'IfcRelAggregates',
      isDeleted: () => false,
    });

    expect(overlay.supersededSourceIds).toEqual(new Set());
    expect(effectiveRelationshipEdges(overlay, () => false, 2, 'IfcRelAggregates')).toEqual([{
      relationshipId: 3,
      relationshipType: 'IfcRelAggregates',
      direction: 'forward',
      targetId: 4,
    }]);
  });
});
