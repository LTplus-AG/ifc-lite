/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef` round trips on real fixtures, one per schema: write through
 * the SDK, export, re-parse the bytes with the existing extractor
 * (`extractGeoreferencingOnDemand`) and compare every field. Fixtures come
 * from `pnpm fixtures`; a missing one skips.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractGeoreferencingOnDemand, parseModel, type GeoreferenceInfo } from '@ifc-lite/parser';
import { openModel, type HeadlessModelSession } from '../headless.js';
import { GeoreferencingError } from './types.js';

const fixture = (rel: string) => new URL(`../../../../tests/models/${rel}`, import.meta.url);
const IFC4_PLAIN = fixture('ara3d/IfcOpenHouse_IFC4.ifc');
const IFC4_GEOREF = fixture('buildingsmart/Building-Architecture.ifc');
const IFC4X3_PLAIN = fixture('buildingsmart/annex_e/basic-geometric-shape/extruded-solid.ifc');
const IFC4X3_GEOREF = fixture('ifc5/Georeferencing_georeferenced-bridge-deck.ifc');
const IFC2X3_SITE_LATLONG = fixture('ara3d/example.ifc');

function itWith(url: URL, name: string, fn: () => Promise<void>) {
  if (existsSync(url)) it(name, fn);
  else it.skip(`${name} (fixture missing — run \`pnpm fixtures\`)`, () => {});
}

async function open(url: URL): Promise<HeadlessModelSession> {
  return openModel(readFileSync(url), { disableWorkerScan: true });
}

async function reparse(model: HeadlessModelSession): Promise<{ text: string; info: GeoreferenceInfo }> {
  const out = model.bim.export.ifc();
  const text = typeof out === 'string' ? out : new TextDecoder().decode(out);
  const { store } = await parseModel(new TextEncoder().encode(text), { disableWorkerScan: true });
  const info = extractGeoreferencingOnDemand(store);
  if (!info) throw new Error('re-parsed model has no source to read');
  return { text, info };
}

function count(text: string, type: string): number {
  return (text.match(new RegExp(`=${type}\\(`, 'g')) ?? []).length;
}

function refusal(fn: () => unknown): GeoreferencingError {
  try {
    fn();
  } catch (err) {
    if (err instanceof GeoreferencingError) return err;
    throw err;
  }
  throw new Error('expected a GeoreferencingError');
}

const FULL_CRS = {
  Name: 'EPSG:2056',
  Description: 'CH1903+ / LV95',
  GeodeticDatum: 'CH1903+',
  VerticalDatum: 'LN02',
  MapProjection: 'Swiss Oblique Mercator',
  MapZone: 'CH',
  MapUnit: 'METRE',
};

describe('bim.georef round trip — IFC4', () => {
  itWith(IFC4_PLAIN, 'creates IfcProjectedCRS + IfcMapConversion and every field reads back', async () => {
    const model = await open(IFC4_PLAIN);
    try {
      expect(model.bim.georef.get().hasGeoreference).toBe(false);
      const result = model.bim.georef.set({
        ProjectedCRS: FULL_CRS,
        MapConversion: { Eastings: 2600123.25, Northings: 1199876.5, OrthogonalHeight: 431.75, Scale: 0.9996 },
        rotationDegrees: 30,
      });
      expect(result.mapUnit).toEqual({ value: 'METRE', source: 'explicit', detail: 'given explicitly' });
      expect(model.bim.georef.get()).toMatchObject({ pending: true, source: 'IfcMapConversion' });
      expect(model.bim.georef.get().rotationDegrees).toBeCloseTo(30, 12);

      const { text, info } = await reparse(model);
      expect(count(text, 'IFCMAPCONVERSION')).toBe(1);
      expect(count(text, 'IFCPROJECTEDCRS')).toBe(1);
      expect(info.source).toBe('mapConversion');
      expect(info.projectedCRS).toMatchObject({
        name: 'EPSG:2056', description: 'CH1903+ / LV95', geodeticDatum: 'CH1903+', verticalDatum: 'LN02',
        mapProjection: 'Swiss Oblique Mercator', mapZone: 'CH', mapUnit: 'METRE', mapUnitScale: 1,
      });
      const mc = info.mapConversion!;
      expect(mc.eastings).toBe(2600123.25);
      expect(mc.northings).toBe(1199876.5);
      expect(mc.orthogonalHeight).toBe(431.75);
      expect(mc.xAxisAbscissa).toBeCloseTo(Math.cos(Math.PI / 6), 14);
      expect(mc.xAxisOrdinate).toBeCloseTo(0.5, 14);
      expect(mc.scale).toBe(0.9996);
      // SourceCRS is the model's own 3D context.
      expect(mc.sourceCRS).toBe(11);
    } finally { model.close(); }
  });

  itWith(IFC4_GEOREF, 'refuses a second georeferencing, replaces on request, keeps the same-named CRS unit', async () => {
    const model = await open(IFC4_GEOREF);
    try {
      const before = model.bim.georef.get();
      expect(before).toMatchObject({ source: 'IfcMapConversion', ProjectedCRS: { Name: 'EPSG:32760', MapUnit: 'MILLIMETRE' } });
      const input = {
        ProjectedCRS: { Name: 'EPSG:32760', GeodeticDatum: 'WGS 84' },
        MapConversion: { Eastings: 729000000, Northings: 9064000000, OrthogonalHeight: 1250, XAxisAbscissa: 0, XAxisOrdinate: 1 },
      };
      const err = refusal(() => model.bim.georef.set(input));
      expect(err.code).toBe('ALREADY_GEOREFERENCED');
      expect(err.message).toContain('IfcMapConversion #19');
      expect(err.missing).toEqual(['replace']);

      const result = model.bim.georef.set({ ...input, replace: true });
      expect(result.removed).toEqual(['IfcMapConversion #19', 'IfcProjectedCRS #18']);
      expect(result.mapUnit).toMatchObject({ value: 'MILLIMETRE', source: 'existing' });

      const { text, info } = await reparse(model);
      expect(count(text, 'IFCMAPCONVERSION')).toBe(1);
      expect(count(text, 'IFCPROJECTEDCRS')).toBe(1);
      expect(text).not.toMatch(/^#19=/m);
      expect(info.projectedCRS).toMatchObject({ name: 'EPSG:32760', geodeticDatum: 'WGS 84', mapUnit: 'MILLIMETRE', mapUnitScale: 0.001 });
      expect(info.projectedCRS?.description).toBeUndefined();
      expect(info.mapConversion).toMatchObject({ eastings: 729000000, northings: 9064000000, orthogonalHeight: 1250, xAxisAbscissa: 0, xAxisOrdinate: 1 });
      expect(info.mapConversion?.scale).toBeUndefined();
    } finally { model.close(); }
  });

  itWith(IFC4_GEOREF, 'update edits the records in place and leaves every other value alone', async () => {
    const model = await open(IFC4_GEOREF);
    try {
      const before = model.bim.georef.get();
      model.bim.georef.update({ MapConversion: { Eastings: 729013000 }, rotationDegrees: 90 });
      const { text, info } = await reparse(model);
      expect(text).toMatch(/^#19=IFCMAPCONVERSION\(/m);
      expect(info.mapConversion).toMatchObject({
        id: 19, eastings: 729013000, northings: before.MapConversion!.Northings,
        orthogonalHeight: before.MapConversion!.OrthogonalHeight, xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1,
      });
      expect(info.projectedCRS).toMatchObject({ id: 18, name: 'EPSG:32760', mapUnit: 'MILLIMETRE' });
    } finally { model.close(); }
  });

  itWith(IFC4_GEOREF, 'refuses a CRS rename that would keep the old datum and unit', async () => {
    const model = await open(IFC4_GEOREF);
    try {
      const err = refusal(() => model.bim.georef.update({ ProjectedCRS: { Name: 'EPSG:2193' } }));
      expect(err.code).toBe('CONTRADICTION');
      expect(err.missing).toEqual(['ProjectedCRS.Description', 'ProjectedCRS.GeodeticDatum', 'ProjectedCRS.MapUnit']);
      expect(model.bim.georef.get().pending).toBe(false);
    } finally { model.close(); }
  });

  itWith(IFC4_GEOREF, 'remove deletes the map conversion and the CRS', async () => {
    const model = await open(IFC4_GEOREF);
    try {
      const result = model.bim.georef.remove();
      expect(result.removed).toEqual(['IfcMapConversion #19', 'IfcProjectedCRS #18']);
      const { text, info } = await reparse(model);
      expect(count(text, 'IFCMAPCONVERSION') + count(text, 'IFCPROJECTEDCRS')).toBe(0);
      expect(info.hasGeoreference).toBe(false);
    } finally { model.close(); }
  });

  itWith(IFC4_PLAIN, 'refuses IfcMapConversionScaled factors on IFC4', async () => {
    const model = await open(IFC4_PLAIN);
    try {
      const err = refusal(() => model.bim.georef.set({
        ProjectedCRS: FULL_CRS,
        MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3, FactorX: 1, FactorY: 1, FactorZ: 1 },
      }));
      expect(err.code).toBe('UNSUPPORTED_SCHEMA');
      expect(err.message).toContain('IFC4X3');
    } finally { model.close(); }
  });
});

describe('bim.georef round trip — IFC4X3', () => {
  itWith(IFC4X3_PLAIN, 'creates IfcMapConversionScaled with FactorX/Y/Z and a US survey foot map unit', async () => {
    const model = await open(IFC4X3_PLAIN);
    try {
      model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2227', GeodeticDatum: 'NAD83', MapUnit: 'US SURVEY FOOT' },
        MapConversion: { Eastings: 6000000, Northings: 2100000, OrthogonalHeight: 12, Scale: 1, FactorX: 0.99995, FactorY: 0.99996, FactorZ: 1 },
        rotationDegrees: -15,
      });
      expect(model.bim.georef.get().source).toBe('IfcMapConversionScaled');
      const { text, info } = await reparse(model);
      expect(count(text, 'IFCMAPCONVERSIONSCALED')).toBe(1);
      expect(count(text, 'IFCMAPCONVERSION')).toBe(0);
      expect(info.projectedCRS).toMatchObject({ name: 'EPSG:2227', geodeticDatum: 'NAD83', mapUnit: 'US SURVEY FOOT' });
      expect(info.projectedCRS?.mapUnitScale).toBeCloseTo(1200 / 3937, 12);
      expect(info.mapConversion).toMatchObject({ eastings: 6000000, northings: 2100000, orthogonalHeight: 12, scale: 1, factorX: 0.99995, factorY: 0.99996, factorZ: 1 });
      expect(info.mapConversion?.xAxisAbscissa).toBeCloseTo(Math.cos((-15 * Math.PI) / 180), 14);
      expect(info.mapConversion?.xAxisOrdinate).toBeCloseTo(Math.sin((-15 * Math.PI) / 180), 14);
    } finally { model.close(); }
  });

  itWith(IFC4X3_GEOREF, 'refuses factors on a plain IfcMapConversion and writes them on replace', async () => {
    const model = await open(IFC4X3_GEOREF);
    try {
      const err = refusal(() => model.bim.georef.update({ MapConversion: { FactorX: 1, FactorY: 1, FactorZ: 1 } }));
      expect(err.code).toBe('UNSUPPORTED_RECORD');
      // The file's CRS declares no MapUnit, so a replace must name one.
      const missingUnit = refusal(() => model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:32610', VerticalDatum: 'EPSG:5703' },
        MapConversion: { Eastings: 545991.68, Northings: 4184941.97, OrthogonalHeight: 0, FactorX: 0.9996, FactorY: 0.9996, FactorZ: 1 },
        replace: true,
      }));
      expect(missingUnit.code).toBe('MISSING_INPUT');
      expect(missingUnit.missing).toEqual(['ProjectedCRS.MapUnit']);
      model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:32610', VerticalDatum: 'EPSG:5703', MapUnit: 'METRE' },
        MapConversion: { Eastings: 545991.68, Northings: 4184941.97, OrthogonalHeight: 0, FactorX: 0.9996, FactorY: 0.9996, FactorZ: 1 },
        replace: true,
      });
      const { text, info } = await reparse(model);
      expect(count(text, 'IFCMAPCONVERSIONSCALED')).toBe(1);
      expect(count(text, 'IFCMAPCONVERSION')).toBe(0);
      expect(count(text, 'IFCPROJECTEDCRS')).toBe(1);
      expect(info.mapConversion).toMatchObject({ eastings: 545991.68, northings: 4184941.97, factorX: 0.9996, factorY: 0.9996, factorZ: 1 });
      expect(info.projectedCRS).toMatchObject({ name: 'EPSG:32610', verticalDatum: 'EPSG:5703', mapUnit: 'METRE' });
    } finally { model.close(); }
  });
});

describe('bim.georef round trip — IFC2X3 property-set convention', () => {
  itWith(IFC2X3_SITE_LATLONG, 'writes ePSet_MapConversion + ePSet_ProjectedCRS on the IfcSite, then updates and removes them', async () => {
    const model = await open(IFC2X3_SITE_LATLONG);
    let written: string;
    try {
      // The fixture only has IfcSite RefLatitude/RefLongitude: that is not a
      // map conversion, so set needs no replace, and the note says it stays.
      expect(model.bim.georef.get().source).toBe('IfcSite');
      const result = model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:26919', GeodeticDatum: 'NAD83', MapUnit: 'METRE' },
        MapConversion: { Eastings: 327000.5, Northings: 4677000.25, OrthogonalHeight: 20, Scale: 1 },
        rotationDegrees: 45,
      });
      expect(result.storage).toBe('propertySets');
      expect(result.notes.join('\n')).toContain('RefLatitude/RefLongitude');
      const { text, info } = await reparse(model);
      written = text;
      expect(info.source).toBe('ePSetMapConversion');
      expect(info.projectedCRS).toMatchObject({ name: 'EPSG:26919', geodeticDatum: 'NAD83', mapUnit: 'METRE' });
      expect(info.mapConversion).toMatchObject({ eastings: 327000.5, northings: 4677000.25, orthogonalHeight: 20, scale: 1 });
      expect(info.mapConversion?.xAxisAbscissa).toBeCloseTo(Math.SQRT1_2, 14);
      expect(info.mapConversion?.xAxisOrdinate).toBeCloseTo(Math.SQRT1_2, 14);
      expect(text).toMatch(/IFCPROPERTYSINGLEVALUE\('Eastings',\$,IFCLENGTHMEASURE\(327000\.5\),\$\)/);
    } finally { model.close(); }

    const reopened = await openModel(new TextEncoder().encode(written), { disableWorkerScan: true });
    try {
      expect(reopened.bim.georef.get().source).toBe('ePSet_MapConversion');
      expect(refusal(() => reopened.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:26919', MapUnit: 'METRE' },
        MapConversion: { Eastings: 0, Northings: 0, OrthogonalHeight: 0 },
      })).code).toBe('ALREADY_GEOREFERENCED');
      reopened.bim.georef.update({ MapConversion: { Northings: 4677100 } });
      const updated = await reparse(reopened);
      expect(updated.info.mapConversion).toMatchObject({ eastings: 327000.5, northings: 4677100, orthogonalHeight: 20 });
      expect(updated.info.projectedCRS?.name).toBe('EPSG:26919');
      reopened.bim.georef.remove();
      const removed = await reparse(reopened);
      expect(removed.text).not.toMatch(/ePSet_MapConversion/i);
      expect(removed.text).not.toMatch(/ePSet_ProjectedCRS/i);
      // Falls back to the untouched IfcSite location again.
      expect(removed.info.source).toBe('siteLocation');
    } finally { reopened.close(); }
  });

  itWith(IFC2X3_SITE_LATLONG, 'refuses IfcMapConversionScaled factors on IFC2X3', async () => {
    const model = await open(IFC2X3_SITE_LATLONG);
    try {
      expect(refusal(() => model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:26919', MapUnit: 'METRE' },
        MapConversion: { Eastings: 1, Northings: 1, OrthogonalHeight: 1, FactorX: 1, FactorY: 1, FactorZ: 1 },
      })).code).toBe('UNSUPPORTED_SCHEMA');
    } finally { model.close(); }
  });
});
