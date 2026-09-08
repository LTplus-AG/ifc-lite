/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity can legitimately carry two distinct IfcPropertySets that
 * share the same name (e.g. one from the type definition, one from the
 * occurrence). `HeadlessBackend.query.entities()`'s property filter
 * used to do `props.find(p => p.name === filter.psetName)`, which only
 * ever sees the FIRST same-named set -- an entity whose wanted property
 * lives on the SECOND same-named set was silently excluded from the
 * result set, with no indication anything was omitted.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHeadlessContext } from './loader.js';
import type { BimContext } from '@ifc-lite/sdk';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Wall #72 carries TWO "Pset_WallCommon" sets: the first (#80) has only
// IsExternal, the second (#83) has the FireRating we're filtering on.
//
// Wall #90 (Wall F) carries TWO "Pset_WallCommon" sets that BOTH carry
// FireRating, with DIFFERENT values: #92 (first) is 'REI30' (does not
// match), #95 (second) is 'REI60' (matches). This is the shape #3490
// actually reports — `findPropertyInSets` finds the property on the
// FIRST set either way, so testing only that one value wrongly excludes
// the wall when the match lives on the second set.
//
// Wall #100 (Wall G) carries the same two-set shape with NEITHER value
// matching — the negative control.
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72,#90,#100),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#80= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#81));
#82= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#80);
#84= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#83= IFCPROPERTYSET('${guid('PST2')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#72),#83);
#90= IFCWALL('${guid('WALF')}',$,'Wall F',$,$,#40,$,'tagF',$);
#91= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI30'),$);
#92= IFCPROPERTYSET('${guid('PST3')}',$,'Pset_WallCommon',$,(#91));
#93= IFCRELDEFINESBYPROPERTIES('${guid('RDP3')}',$,$,$,(#90),#92);
#94= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#95= IFCPROPERTYSET('${guid('PST4')}',$,'Pset_WallCommon',$,(#94));
#96= IFCRELDEFINESBYPROPERTIES('${guid('RDP4')}',$,$,$,(#90),#95);
#100= IFCWALL('${guid('WALG')}',$,'Wall G',$,$,#40,$,'tagG',$);
#101= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI30'),$);
#102= IFCPROPERTYSET('${guid('PST5')}',$,'Pset_WallCommon',$,(#101));
#103= IFCRELDEFINESBYPROPERTIES('${guid('RDP5')}',$,$,$,(#100),#102);
#104= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI45'),$);
#105= IFCPROPERTYSET('${guid('PST6')}',$,'Pset_WallCommon',$,(#104));
#106= IFCRELDEFINESBYPROPERTIES('${guid('RDP6')}',$,$,$,(#100),#105);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let bim: BimContext;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-cli-dup-pset-filter-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
  ({ bim } = await createHeadlessContext(join(tmp, 'm.ifc')));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('HeadlessBackend query.entities() property filter — two same-named property sets', () => {
  it('does not silently exclude an entity whose filtered property lives on the SECOND same-named set (Wall A: FIRST set has no FireRating at all), and any-matches an entity whose SECOND set overrides a non-matching value on the FIRST (Wall F: #3490)', () => {
    const results = bim
      .query()
      .byType('IfcWall')
      .where('Pset_WallCommon', 'FireRating', '=', 'REI60')
      .toArray();

    expect(results.map((e) => e.name)).toEqual(['Wall A', 'Wall F']);
  });

  it('still matches on the property from the FIRST same-named set', () => {
    const results = bim
      .query()
      .byType('IfcWall')
      .where('Pset_WallCommon', 'IsExternal', '=', true)
      .toArray();

    expect(results.map((e) => e.name)).toEqual(['Wall A']);
  });

  it('excludes an entity where NEITHER same-named set matches', () => {
    const results = bim
      .query()
      .byType('IfcWall')
      .where('Pset_WallCommon', 'FireRating', '=', 'REI99')
      .toArray();

    expect(results.map((e) => e.name)).toEqual([]);
  });
});
