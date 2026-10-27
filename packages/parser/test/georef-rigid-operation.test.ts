/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC4X3_ADD1+ coordinate operations beside IfcMapConversion: IfcRigidOperation
 * (a pure translation, in lengths or in plane angles), its IfcGeographicCRS
 * target, and the IfcWellKnownText definition attached to a CRS by inverse.
 * Read through the on-demand path the viewer uses.
 */

import { describe, it, expect, vi } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractGeoreferencingOnDemand } from '../src/on-demand-extractors.js';
import { transformToWorld } from '../src/georef-extractor.js';

async function georefOf(data: string) {
  const source = new TextEncoder().encode(data);
  const entityRefs = [...new StepTokenizer(source).scanEntitiesFast()].map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const store = await new ColumnarParser().parseLite(source.buffer.slice(0), entityRefs, {});
  return extractGeoreferencingOnDemand(store);
}

/** The georeferencing block of a real IFC4X3_ADD2 bridge export (DB_REF local TM; labels and origin changed). */
const DB_REF_WKT = 'COMPOUNDCRS["LOCAL_TM_EXAMPLE",PROJCRS["Local TM",BASEGEOGCRS["DB_REF",DATUM["Deutsche Bahn Reference System",ELLIPSOID["Bessel 1841",6377397.155,299.1528128,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",5681]],CONVERSION["Local Projection",METHOD["Transverse_Mercator"],PARAMETER["central_meridian",10.4521,ANGLEUNIT["degree",0.0174532925199433,ID["EPSG",9122]]],PARAMETER["latitude_of_origin",51.2763,ANGLEUNIT["degree",0.0174532925199433,ID["EPSG",9122]]],PARAMETER["scale_factor",1.0000124,SCALEUNIT["unity",1,ID["EPSG",9201]]],PARAMETER["false_easting",20000,LENGTHUNIT["metre",1,ID["EPSG",9001]]],PARAMETER["false_northing",30000,LENGTHUNIT["metre",1,ID["EPSG",9001]]]],CS[Cartesian,2],AXIS["e",east,ORDER[1],LENGTHUNIT["metre",1,ID["EPSG",9001]]],AXIS["n",north,ORDER[2],LENGTHUNIT["metre",1,ID["EPSG",9001]]]],VERTCRS["GNTRANS2016 height",VDATUM["GNTRANS2016"],CS[vertical,1],AXIS["gravity-related height",up,LENGTHUNIT["metre",1]],ID["EPSG",9927]],USAGE[SCOPE["Engineering survey"],AREA["Example area"],BBOX[51.18,10.30,51.37,10.60]]]';
const BRIDGE = `#29=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCAXIS2PLACEMENT3D(#29,$,$);
#167=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-005,#30,$);
#50551=IFCPROJECTEDCRS('WKT','LOCAL_TM_EXAMPLE','EPSG:5681','EPSG:9927','GK','Local zone',#50554);
#50552=IFCRIGIDOPERATION(#167,#50551,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),0.);
#50553=IFCWELLKNOWNTEXT('${DB_REF_WKT}',#50551);
#50554=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`;

const CONTEXT = `#1=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);`;
const DEGREE_UNIT = `#20=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#21=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.0174532925199433),#20);
#22=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#23=IFCCONVERSIONBASEDUNIT(#22,.PLANEANGLEUNIT.,'DEGREE',#21);`;

describe('IfcRigidOperation', () => {
  it('reads the bridge: rigid source, its TargetCRS and the attached WKT', async () => {
    const georef = await georefOf(BRIDGE);
    expect(georef?.hasGeoreference).toBe(true);
    expect(georef?.source).toBe('rigidOperation');
    expect(georef?.mapConversion).toMatchObject({
      id: 50552, operation: 'rigidOperation', sourceCRS: 167, targetCRS: 50551,
      eastings: 0, northings: 0, orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
    });
    expect(georef?.projectedCRS).toMatchObject({
      id: 50551, name: 'WKT', description: 'LOCAL_TM_EXAMPLE', geodeticDatum: 'EPSG:5681',
      verticalDatum: 'EPSG:9927', mapUnit: 'METRE', mapUnitScale: 1,
    });
    expect(georef?.projectedCRS?.wellKnownText).toBe(DB_REF_WKT);
    expect(transformToWorld([20000, 30000, 3], georef!)).toEqual([20000, 30000, 3]);
  });

  it('translates by length measures, without rotation or scale', async () => {
    const georef = await georefOf(`${CONTEXT}
#2=IFCPROJECTEDCRS('EPSG:25833',$,$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCLENGTHMEASURE(390000.),IFCLENGTHMEASURE(5800000.),34.5);`);
    expect(georef?.source).toBe('rigidOperation');
    expect(georef?.projectedCRS?.name).toBe('EPSG:25833');
    expect(transformToWorld([10, 20, 1], georef!)).toEqual([390010, 5800020, 35.5]);
  });

  it('follows its TargetCRS rather than the first CRS in the file', async () => {
    const georef = await georefOf(`${CONTEXT}
#2=IFCPROJECTEDCRS('EPSG:25832',$,$,$,$,$,$);
#3=IFCPROJECTEDCRS('EPSG:25833',$,$,$,$,$,$);
#4=IFCRIGIDOPERATION(#1,#3,IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.),$);`);
    expect(georef?.projectedCRS?.name).toBe('EPSG:25833');
  });

  it('yields to an IfcMapConversion in the same file', async () => {
    const georef = await georefOf(`${CONTEXT}
#2=IFCPROJECTEDCRS('EPSG:25833',$,$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.),$);
#4=IFCMAPCONVERSION(#1,#2,100.,200.,0.,1.,0.,1.);`);
    expect(georef?.source).toBe('mapConversion');
    expect(georef?.mapConversion?.eastings).toBe(100);
  });

  it('translates (lambda, phi) plane angles in the geographic CRS AngleUnit', async () => {
    const georef = await georefOf(`${CONTEXT}
${DEGREE_UNIT}
#2=IFCGEOGRAPHICCRS('EPSG:4326','WGS 84','WGS84',$,#23,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCPLANEANGLEMEASURE(13.3),IFCPLANEANGLEMEASURE(52.4),12.);`);
    expect(georef?.source).toBe('rigidOperation');
    expect(georef?.projectedCRS).toMatchObject({ kind: 'geographic', name: 'EPSG:4326', geodeticDatum: 'WGS84', mapUnit: 'DEGREE' });
    expect(georef?.mapConversion?.eastings).toBeCloseTo(13.3, 12);
    expect(georef?.mapConversion?.northings).toBeCloseTo(52.4, 12);
    expect(georef?.mapConversion?.orthogonalHeight).toBe(12);
  });

  it('falls back to the project plane-angle unit, and to radians when none is assigned', async () => {
    const inDegrees = await georefOf(`${CONTEXT}
${DEGREE_UNIT}
#5=IFCUNITASSIGNMENT((#23));
#6=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#1),#5);
#2=IFCGEOGRAPHICCRS('EPSG:4326',$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCPLANEANGLEMEASURE(13.3),IFCPLANEANGLEMEASURE(52.4),$);`);
    expect(inDegrees?.mapConversion?.eastings).toBeCloseTo(13.3, 12);

    const inRadians = await georefOf(`${CONTEXT}
#5=IFCUNITASSIGNMENT(());
#6=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#1),#5);
#2=IFCGEOGRAPHICCRS('EPSG:4326',$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCPLANEANGLEMEASURE(0.25),IFCPLANEANGLEMEASURE(0.5),$);`);
    expect(inRadians?.mapConversion?.eastings).toBeCloseTo(0.25 * 180 / Math.PI, 12);
    expect(inRadians?.mapConversion?.northings).toBeCloseTo(0.5 * 180 / Math.PI, 12);
  });

  it('refuses a cyclic conversion-based angle unit instead of overflowing the stack', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const georef = await georefOf(`${CONTEXT}
#20=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(1.),#21);
#21=IFCCONVERSIONBASEDUNIT(*,.PLANEANGLEUNIT.,'LOOP',#20);
#2=IFCGEOGRAPHICCRS('EPSG:4326',$,$,$,#21,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCPLANEANGLEMEASURE(13.3),IFCPLANEANGLEMEASURE(52.4),$);`);
      expect(georef?.mapConversion).toBeUndefined();
      expect(georef?.projectedCRS?.name).toBe('EPSG:4326');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['mixed measure types', `#2=IFCPROJECTEDCRS('EPSG:25833',$,$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCLENGTHMEASURE(1.),IFCPLANEANGLEMEASURE(2.),$);`],
    ['plane angles against a projected CRS', `#2=IFCPROJECTEDCRS('EPSG:25833',$,$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCPLANEANGLEMEASURE(1.),IFCPLANEANGLEMEASURE(2.),$);`],
    ['lengths against a geographic CRS', `#2=IFCGEOGRAPHICCRS('EPSG:4326',$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.),$);`],
  ])('refuses %s, keeping only the declared CRS', async (_label, body) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const georef = await georefOf(`${CONTEXT}\n${body}`);
      expect(georef?.hasGeoreference).toBe(true);
      expect(georef?.mapConversion).toBeUndefined();
      expect(georef?.source).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('IfcRigidOperation #3'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('IfcWellKnownText', () => {
  it('does not let a WKT-only CRS without an operation hold back the IfcSite fallback', async () => {
    const georef = await georefOf(`${CONTEXT}
#2=IFCPROJECTEDCRS('',$,$,$,$,$,$);
#4=IFCWELLKNOWNTEXT('PROJCRS["x"]',#2);
#6=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#1),$);
#9=IFCLOCALPLACEMENT($,$);
#10=IFCSITE('2YvctVUKr0kugbFTf53O9L',$,'S',$,$,#9,$,$,.ELEMENT.,(47,22,0,0),(8,32,0,0),400.,$,$);`);
    expect(georef?.source).toBe('siteLocation');
  });

  it('lets a CRS with a blank Name claim georeferencing through its WKT (WHERE NameOrWKT)', async () => {
    const georef = await georefOf(`${CONTEXT}
#2=IFCPROJECTEDCRS('',$,$,$,$,$,$);
#3=IFCRIGIDOPERATION(#1,#2,IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.),$);
#4=IFCWELLKNOWNTEXT('PROJCRS["x",BASEGEOGCRS["ETRS89",DATUM["European Terrestrial Reference System 1989",ELLIPSOID["GRS 1980",6378137,298.257222101]]],CONVERSION["UTM zone 33N",METHOD["Transverse Mercator",ID["EPSG",9807]]],CS[Cartesian,2],AXIS["E",east],AXIS["N",north],LENGTHUNIT["metre",1]]',#2);`);
    expect(georef?.hasGeoreference).toBe(true);
    expect(georef?.projectedCRS?.name).toBe('');
    expect(georef?.projectedCRS?.wellKnownText).toMatch(/^PROJCRS\["x"/);
  });

  it('only attaches WKT that references this CRS', async () => {
    const georef = await georefOf(`${CONTEXT}
#2=IFCPROJECTEDCRS('EPSG:25833',$,$,$,$,$,$);
#3=IFCPROJECTEDCRS('EPSG:25832',$,$,$,$,$,$);
#4=IFCMAPCONVERSION(#1,#2,0.,0.,0.,$,$,$);
#5=IFCWELLKNOWNTEXT('PROJCRS["other"]',#3);`);
    expect(georef?.projectedCRS?.name).toBe('EPSG:25833');
    expect(georef?.projectedCRS?.wellKnownText).toBeUndefined();
  });
});
