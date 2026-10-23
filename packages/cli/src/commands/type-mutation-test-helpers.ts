/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

