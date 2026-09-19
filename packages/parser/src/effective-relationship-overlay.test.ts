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
      relationshipType: 'IFCRELAGGREGATES',
      direction: 'forward',
      targetId: 4,
    }]);
  });
});
