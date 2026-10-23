/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';

export const schemas = [
  { schema: 'IFC2X3', type: 'IFCWINDOWSTYLE', tail: '.SINGLE_PANEL.,.WOOD.,.T.,.F.' },
  { schema: 'IFC4', type: 'IFCWALLTYPE', tail: "'Wall',.STANDARD." },
  { schema: 'IFC4X3', type: 'IFCRAILTYPE', tail: "'Rail',.RACKRAIL." },
] as const;

export function source(fixture: (typeof schemas)[number]): Uint8Array {
  return new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", `FILE_SCHEMA(('${fixture.schema}'));`,
    'ENDSEC;', 'DATA;',
    `#1=${fixture.type}('0aaaaaaaaaaaaaaaaaaaaa',$,'Type A',$,$,(#3,#5),$,'T-001',${fixture.tail});`,
    "#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI60'),$);",
    "#3=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'Pset_TestType',$,(#2,#6));",
    "#4=IFCQUANTITYLENGTH('Length',$,$,2.,$);",
    "#5=IFCELEMENTQUANTITY('0ccccccccccccccccccccc',$,'Qto_TestType',$,$,(#4,#7));",
    "#6=IFCPROPERTYSINGLEVALUE('Code',$,IFCLABEL('TYPE-001'),$);",
    "#7=IFCQUANTITYAREA('Area',$,$,6.,$);",
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n'));
}


/** Read ownership directly; the own-data extractors also accept relationship sets. */
export function directlyOwnedSetNames(store: IfcDataStore): string[] {
  const extractor = new EntityExtractor(store.source);
  // @raw-entity-enumeration-ok independent reparse checks original HasPropertySets ownership; no live mutation view exists
  const ownerRef = store.entityIndex.byId.get(1);
  if (!ownerRef) throw new Error('fixture type #1 missing');
  const ids = extractor.extractEntity(ownerRef)?.attributes[5];
  if (!Array.isArray(ids)) return [];
  return ids.map(id => {
    if (typeof id !== 'number') throw new Error('HasPropertySets contains a non-reference');
    // @raw-entity-enumeration-ok inspect the owned set in the independently reparsed export, without an overlay
    const ref = store.entityIndex.byId.get(id);
    if (!ref) throw new Error(`owned set #${id} missing`);
    return String(extractor.extractEntity(ref)?.attributes[2]);
  }).sort();
}
