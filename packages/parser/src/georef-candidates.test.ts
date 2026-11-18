/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `extractGeoreferenceCandidatesOnDemand` keeps the sources the winner path
 * hides (ePSet beside the IFC4 entity, the IfcSite reference point, a second
 * IfcMapConversion), while `extractGeoreferencingOnDemand` keeps answering
 * with the winner alone.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from './ifc-parser.js';
import { extractGeoreferenceCandidatesOnDemand, extractGeoreferencingOnDemand } from './on-demand-georeferencing.js';

function stepFile(data: string[]): ArrayBuffer {
  const text = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('candidates.ifc','2026-11-15T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...data,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

const HEAD = [
  '#1=IFCCARTESIANPOINT((0.,0.,0.));',
  '#2=IFCAXIS2PLACEMENT3D(#1,$,$);',
  "#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);",
  '#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#5=IFCUNITASSIGNMENT((#4));',
  "#6=IFCPROJECT('0GeorefCandidates00001',$,'p',$,$,$,$,(#3),#5);",
  '#7=IFCLOCALPLACEMENT($,#2);',
  "#8=IFCSITE('0GeorefCandidates00002',$,'Site',$,$,#7,$,$,.ELEMENT.,(42,21,30,240000),(-71,-3,-35,-280000),0.,$,$);",
  "#9=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#4);",
  '#10=IFCMAPCONVERSION(#3,#9,2600000.,1200000.,540.,1.,0.,1.);',
];

describe('extractGeoreferenceCandidatesOnDemand', () => {
  it('keeps the site reference point and the ePSet beside the winning IfcMapConversion', async () => {
    const store = await new IfcParser().parseColumnar(stepFile([
      ...HEAD,
      "#11=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(2601000.),$);",
      "#12=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(1200000.),$);",
      "#13=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(540.),$);",
      "#14=IFCPROPERTYSET('0GeorefCandidates00003',$,'ePSet_MapConversion',$,(#11,#12,#13));",
      "#15=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);",
      "#16=IFCPROPERTYSET('0GeorefCandidates00004',$,'ePSet_ProjectedCRS',$,(#15));",
      '#17=IFCMAPCONVERSION(#3,#9,2600500.,1200000.,540.,1.,0.,1.);',
    ]));

    const candidates = extractGeoreferenceCandidatesOnDemand(store);
    expect(candidates).not.toBeNull();
    expect(candidates?.winner).toBe('mapConversion');
    expect(candidates?.entities.mapConversion?.eastings).toBe(2600000);
    expect(candidates?.mapConversions.map((c) => c.conversion.eastings)).toEqual([2600000, 2600500]);
    expect(candidates?.counts).toEqual({ mapConversion: 2, rigidOperation: 0, projectedCRS: 1, geographicCRS: 0 });
    expect(candidates?.ePSetMapConversion?.mapConversion?.eastings).toBe(2601000);
    expect(candidates?.ePSetMapConversion?.projectedCRS?.name).toBe('EPSG:2056');
    expect(candidates?.siteLocation?.source).toBe('siteLocation');
    expect(candidates?.siteLocation?.mapConversion?.northings).toBeCloseTo(42.35840, 4);
    expect(candidates?.siteLocation?.mapConversion?.eastings).toBeCloseTo(-71.05980, 4);

    // The winner path is unchanged: the IFC4 entity, nothing from the losers.
    const winner = extractGeoreferencingOnDemand(store);
    expect(winner?.source).toBe('mapConversion');
    expect(winner?.mapConversion?.eastings).toBe(2600000);
  });

  // PR #10386 review: each conversion is compared in its own CRS, so each must carry it.
  it('reads every IfcMapConversion with its own TargetCRS', async () => {
    const store = await new IfcParser().parseColumnar(stepFile([
      ...HEAD,
      "#11=IFCPROJECTEDCRS('EPSG:21781',$,$,$,$,$,#4);",
      '#12=IFCMAPCONVERSION(#3,#11,600000.,200000.,540.,1.,0.,1.);',
    ]));
    const candidates = extractGeoreferenceCandidatesOnDemand(store);
    expect(candidates?.mapConversions.map((c) => [c.conversion.id, c.targetCRS?.id, c.targetCRS?.name])).toEqual([
      [10, 9, 'EPSG:2056'],
      [12, 11, 'EPSG:21781'],
    ]);
    expect(candidates?.mapConversions[1].targetCRS?.mapUnitScale).toBe(1);
  });

  it('reports no winner and no sources for a file without georeferencing', async () => {
    const store = await new IfcParser().parseColumnar(stepFile(HEAD.slice(0, 7).concat(
      "#8=IFCSITE('0GeorefCandidates00002',$,'Site',$,$,#7,$,$,.ELEMENT.,$,$,$,$,$);",
    )));
    const candidates = extractGeoreferenceCandidatesOnDemand(store);
    expect(candidates?.winner).toBeUndefined();
    expect(candidates?.entities.hasGeoreference).toBe(false);
    expect(candidates?.ePSetMapConversion).toBeNull();
    expect(candidates?.siteLocation).toBeNull();
    expect(candidates?.mapConversions).toEqual([]);
  });

  it('falls back like the winner path when only the ePSet places the model', async () => {
    const store = await new IfcParser().parseColumnar(stepFile([
      ...HEAD.slice(0, 8),
      "#11=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(2601000.),$);",
      "#12=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(1200000.),$);",
      "#13=IFCPROPERTYSET('0GeorefCandidates00003',$,'ePSet_MapConversion',$,(#11,#12));",
      "#14=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);",
      "#15=IFCPROPERTYSET('0GeorefCandidates00004',$,'ePSet_ProjectedCRS',$,(#14));",
    ]));
    const candidates = extractGeoreferenceCandidatesOnDemand(store);
    expect(candidates?.winner).toBe('ePSetMapConversion');
    expect(extractGeoreferencingOnDemand(store)?.source).toBe('ePSetMapConversion');
    expect(candidates?.siteLocation?.source).toBe('siteLocation');
  });
});
