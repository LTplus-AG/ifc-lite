/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two store queries the diff adapters share (issue #4955): the spatial
 * container as a NAME path, and an authored key (`Tag` or `Pset.Prop`).
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';
import { authoredKeyValue, parseAuthoredKeySpec, spatialContainerPath } from './identity-hints.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0000000000000000000000',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCSITE('1000000000000000000000',$,'Site',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#42= IFCBUILDING('2000000000000000000000',$,'Main ',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCBUILDINGSTOREY('3000000000000000000000',$,'Level 2',$,$,#40,$,$,.ELEMENT.,0.);
#44= IFCSPACE('4000000000000000000000',$,'Room 204',$,$,#40,$,$,.ELEMENT.,.INTERNAL.,$);
#45= IFCRELAGGREGATES('5000000000000000000000',$,$,$,#1,(#41));
#46= IFCRELAGGREGATES('6000000000000000000000',$,$,$,#41,(#42));
#47= IFCRELAGGREGATES('7000000000000000000000',$,$,$,#42,(#43));
#48= IFCRELAGGREGATES('8000000000000000000000',$,$,$,#43,(#44));
#70= IFCWALL('A000000000000000000000',$,'Wall A',$,$,#40,$,'tagA',$);
#71= IFCFURNISHINGELEMENT('B000000000000000000000',$,'Chair',$,$,#40,$,'  ',$);
#72= IFCWALL('C000000000000000000000',$,'Loose wall',$,$,#40,$,$,$);
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('9000000000000000000000',$,$,$,(#70),#43);
#81= IFCRELCONTAINEDINSPATIALSTRUCTURE('D000000000000000000000',$,$,$,(#71),#44);
#90= IFCPROPERTYSET('E000000000000000000000',$,'Pset_Asset',$,(#91,#92));
#91= IFCPROPERTYSINGLEVALUE('AssetId',$,IFCLABEL('AST-0042'),$);
#92= IFCPROPERTYSINGLEVALUE('Blank',$,IFCLABEL(''),$);
#93= IFCRELDEFINESBYPROPERTIES('F000000000000000000000',$,$,$,(#70),#90);
ENDSEC;
END-ISO-10303-21;
`;

async function load() {
  const bytes = new TextEncoder().encode(MODEL);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer, {});
}

describe('spatialContainerPath', () => {
  it('names the path from the project to the finest container, trimming names', async () => {
    const store = await load();
    expect(spatialContainerPath(store, 70)).toBe('Proj/Site/Main/Level 2');
    expect(spatialContainerPath(store, 71)).toBe('Proj/Site/Main/Level 2/Room 204');
  });

  it('answers undefined for an element contained nowhere', async () => {
    const store = await load();
    expect(spatialContainerPath(store, 72)).toBeUndefined();
  });
});

describe('authoredKeyValue', () => {
  it('parses Tag and Pset.Prop specs, and rejects the rest', () => {
    expect(parseAuthoredKeySpec('tag')).toEqual({ kind: 'tag' });
    expect(parseAuthoredKeySpec(' Pset_Asset.AssetId ')).toEqual({
      kind: 'property',
      pset: 'Pset_Asset',
      property: 'AssetId',
    });
    expect(parseAuthoredKeySpec('AssetId')).toBeUndefined();
    expect(parseAuthoredKeySpec('.x')).toBeUndefined();
    expect(parseAuthoredKeySpec('x.')).toBeUndefined();
  });

  it('reads Tag, treating blank as absent', async () => {
    const store = await load();
    const tag = parseAuthoredKeySpec('Tag')!;
    expect(authoredKeyValue(store, 70, tag)).toBe('tagA');
    expect(authoredKeyValue(store, 71, tag)).toBeUndefined();
    expect(authoredKeyValue(store, 72, tag)).toBeUndefined();
  });

  it('reads a property by set and name, treating blank as absent', async () => {
    const store = await load();
    expect(authoredKeyValue(store, 70, parseAuthoredKeySpec('Pset_Asset.AssetId')!)).toBe('AST-0042');
    expect(authoredKeyValue(store, 70, parseAuthoredKeySpec('Pset_Asset.Blank')!)).toBeUndefined();
    expect(authoredKeyValue(store, 70, parseAuthoredKeySpec('Pset_Asset.Missing')!)).toBeUndefined();
    expect(authoredKeyValue(store, 71, parseAuthoredKeySpec('Pset_Asset.AssetId')!)).toBeUndefined();
  });
});
