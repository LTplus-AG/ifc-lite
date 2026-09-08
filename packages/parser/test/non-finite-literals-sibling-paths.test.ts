/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sibling paths of `non-finite-numeric-literals.test.ts`.
 *
 * Making `getNumber` answer `undefined` for `1.0E400` fixed the native
 * `IfcMapConversion` path and, in the same stroke, ARMED every `?? 0` / `|| 0`
 * downstream of it: while the answer was `Infinity` those fallbacks were dead
 * code, because `Infinity` is neither nullish nor falsy. Each one it woke turns
 * a visibly poisoned value into a plausible-looking substitute:
 *
 *   IFC2x3 `ePSet_MapConversion`  Eastings `Infinity` -> `0`   (origin)
 *   legacy `IfcSite`              RefElevation -> `0`          (sea level)
 *   `IfcMaterialLayer`            LayerThickness -> `0`        (a 0mm layer)
 *   `IfcMapConversion` Scale      `undefined` -> `|| 1.0`      (unscaled)
 *
 * `NaN`, `Infinity` and `-Infinity` are asserted separately throughout: only
 * the infinities are what an overflowing STEP real produces, and a
 * `Number.isFinite` -> `isNaN` mutation fails a different subset of them.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import type { IfcEntity } from '../src/entity-extractor.js';
import type { IfcAttributeValue } from '../src/types.js';
import { ColumnarParser, extractGeoreferencingOnDemand } from '../src/columnar-parser.js';
import { extractGeoreferencing } from '../src/georef-extractor.js';
import { extractMaterials } from '../src/material-extractor.js';

/** Parse a whole STEP body through `parseLite` and hand back the store. */
async function storeOf(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const refs = [...new StepTokenizer(source).scanEntitiesFast()].map((r) => ({
    expressId: r.expressId,
    type: r.type,
    byteOffset: r.offset,
    byteLength: r.length,
    lineNumber: r.line,
  }));
  return await new ColumnarParser().parseLite(source.buffer.slice(0), refs, {});
}

const OWNER = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);`;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The refusal diagnostics only. A whole-file parse also warns about the
 * missing IfcProject and spatial hierarchy in these minimal fixtures, so
 * asserting on the raw call count would be asserting on unrelated noise.
 */
function refusals(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes('IEEE-754 double range'));
}

/* ------------------------------------------------------------------ *
 * 1. The IFC2x3 twin: ePSet_MapConversion
 * ------------------------------------------------------------------ */

/**
 * An IFC2x3 georeferenced file: no IfcMapConversion entity, the offsets carried
 * as `IfcPropertySingleValue`s in a property set named `ePSet_MapConversion`.
 */
function epsetFile(
  e: string,
  n: string,
  h: string,
  extra = `#23=IFCPROPERTYSINGLEVALUE('Scale',$,IFCREAL(1.),$);
#24=IFCPROPERTYSINGLEVALUE('TargetCRS',$,IFCLABEL('EPSG:2056'),$);`,
  members = '#20,#21,#22,#23,#24',
): string {
  return `${OWNER}
#20=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(${e}),$);
#21=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(${n}),$);
#22=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(${h}),$);
${extra}
#30=IFCPROPERTYSET('pset-guid',#1,'ePSet_MapConversion',$,(${members}));`;
}

describe('the IFC2x3 ePSet path does not substitute a 0 origin either', () => {
  it('reads a fully finite ePSet map conversion (negative control / anti-vacuity)', async () => {
    const geo = extractGeoreferencingOnDemand(
      await storeOf(epsetFile('2600000.', '1200000.', '400.')),
    );
    // Anti-vacuity: this fixture really does produce a usable ePSet
    // georeference, so an absent `mapConversion` below is caused by the
    // literal and not by the fixture failing to reach the ePSet path at all.
    expect(geo?.source).toBe('ePSetMapConversion');
    expect(geo!.mapConversion!.eastings).toBe(2600000);
    expect(geo!.mapConversion!.northings).toBe(1200000);
    expect(geo!.mapConversion!.orthogonalHeight).toBe(400);
    expect(geo!.transformMatrix![12]).toBe(2600000);
  });

  it.each([
    ['Eastings', '+Infinity', '1.0E400', '1200000.', '400.'],
    ['Eastings', '-Infinity', '-1.0E400', '1200000.', '400.'],
    ['Northings', '+Infinity', '2600000.', '1.0E400', '400.'],
    ['Northings', '-Infinity', '2600000.', '-1.0E400', '400.'],
    ['OrthogonalHeight', '+Infinity', '2600000.', '1200000.', '1.0E400'],
    ['OrthogonalHeight', '-Infinity', '2600000.', '1200000.', '-1.0E400'],
  ])('refuses the ePSet conversion when %s is %s', async (_slot, _sign, e, n, h) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const geo = extractGeoreferencingOnDemand(await storeOf(epsetFile(e, n, h)));

    // The regression this file exists for: `asNumber(...) ?? 0` put a
    // plausible `0` here the moment `getNumber` started answering `undefined`.
    expect(geo?.mapConversion).toBeUndefined();
    expect(geo?.mapConversion?.eastings).not.toBe(0);
    expect(geo?.transformMatrix).toBeUndefined();
    expect(geo?.source).toBeUndefined();

    // Anti-vacuity: the CRS in the same fixture IS still read, so the refusal
    // is scoped to the placement rather than the whole ePSet being missed.
    expect(geo?.projectedCRS?.name).toBe('EPSG:2056');
    expect(geo?.hasGeoreference).toBe(true);

    // And it is not silent. The whole point of refusing over substituting is
    // that a consumer can tell something was discarded.
    expect(refusals(warn)).toHaveLength(1);
    expect(refusals(warn)[0]).toContain('ePSet_MapConversion');
  });

  it.each([
    ['Scale', `#23=IFCPROPERTYSINGLEVALUE('Scale',$,IFCREAL(1.0E400),$);`],
    ['XAxisAbscissa', `#23=IFCPROPERTYSINGLEVALUE('XAxisAbscissa',$,IFCREAL(1.0E400),$);`],
    ['XAxisOrdinate', `#23=IFCPROPERTYSINGLEVALUE('XAxisOrdinate',$,IFCREAL(-1.0E400),$);`],
  ])('refuses the ePSet conversion when the optional %s overflows', async (name, extra) => {
    // The optional components are not "absent, so default": an overflowing
    // Scale would become `|| 1.0` and an overflowing axis pair an angle of 0,
    // both of which look exactly like an ordinary unrotated placement.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const geo = extractGeoreferencingOnDemand(
      await storeOf(epsetFile('2600000.', '1200000.', '400.', extra, '#20,#21,#22,#23')),
    );
    expect(geo?.mapConversion).toBeUndefined();
    expect(geo?.transformMatrix).toBeUndefined();
    expect(refusals(warn)[0] ?? '').toContain(name);
  });

  it('keeps a genuine zero easting on the ePSet path', async () => {
    // The other direction: 0 is a legal easting and must round-trip. A CRS
    // name is present, so the `has_georef()` reject does not apply.
    const geo = extractGeoreferencingOnDemand(
      await storeOf(epsetFile('0.', '1200000.', '400.')),
    );
    expect(geo?.source).toBe('ePSetMapConversion');
    expect(geo!.mapConversion!.eastings).toBe(0);
    expect(geo!.transformMatrix![12]).toBe(0);
  });

  it('warns before falling back to the legacy site when nothing survives', async () => {
    // Secondary effect of the refusal: with all three offsets unrepresentable
    // AND no CRS name, the ePSet has nothing left to report and the caller
    // drops to the legacy IfcSite/EPSG:4326 path. That fallback is allowed —
    // it is what a file with no ePSet would get — but it must not be silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ifc = `${OWNER}
#20=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(1.0E400),$);
#21=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(1.0E400),$);
#22=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(1.0E400),$);
#30=IFCPROPERTYSET('pset-guid',#1,'ePSet_MapConversion',$,(#20,#21,#22));
#40=IFCSITE('site-guid',#1,'Site',$,$,$,$,$,$,(47,22,0,0),(8,32,0,0),100.,$,$);`;
    const geo = extractGeoreferencingOnDemand(await storeOf(ifc));

    expect(geo?.source).toBe('siteLocation');
    expect(geo?.projectedCRS?.name).toBe('EPSG:4326');
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('ePSet_MapConversion')),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 1b. The native path's OPTIONAL components
 * ------------------------------------------------------------------ */

function nativeGeorefFile(abscissa: string, ordinate: string, scale: string): string {
  return `${OWNER}
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);
#6=IFCPROJECTEDCRS('EPSG:2056','CH1903+','CH1903+',$,$,$,$);
#7=IFCMAPCONVERSION(#5,#6,2600000.,1200000.,400.,${abscissa},${ordinate},${scale});`;
}

describe('an overflowing OPTIONAL map-conversion component refuses too', () => {
  it('reads a rotated, scaled conversion (negative control / anti-vacuity)', async () => {
    const geo = extractGeoreferencingOnDemand(await storeOf(nativeGeorefFile('0.', '1.', '2.')));
    expect(geo?.mapConversion?.scale).toBe(2);
    expect(geo?.mapConversion?.xAxisOrdinate).toBe(1);
    expect(geo?.transformMatrix?.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('keeps absent optionals absent — `$` is not a refusal', async () => {
    // The refusal must fire on a stated-but-unrepresentable value only. `$` is
    // the ordinary case: scale defaults to 1 and the axes to no rotation, and
    // that has always been correct.
    const geo = extractGeoreferencingOnDemand(await storeOf(nativeGeorefFile('$', '$', '$')));
    expect(geo?.mapConversion).toBeDefined();
    expect(geo?.mapConversion?.scale).toBeUndefined();
    expect(geo?.transformMatrix![12]).toBe(2600000);
  });

  it.each([
    ['Scale', '0.', '1.', '1.0E400'],
    ['Scale', '0.', '1.', '-1.0E400'],
    ['XAxisAbscissa', '1.0E400', '1.', '1.'],
    ['XAxisOrdinate', '0.', '-1.0E400', '1.'],
  ])('refuses when %s overflows', async (name, a, o, s) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const geo = extractGeoreferencingOnDemand(await storeOf(nativeGeorefFile(a, o, s)));

    // `computeTransformMatrix` reads `scale || 1.0` and treats a missing axis
    // pair as angle 0, so dropping just the field would have substituted the
    // schema default for a value the file explicitly stated.
    expect(geo?.mapConversion).toBeUndefined();
    expect(geo?.transformMatrix).toBeUndefined();
    // Anti-vacuity: the CRS is still read from the same fixture.
    expect(geo?.projectedCRS?.name).toBe('EPSG:2056');
    expect(refusals(warn)[0] ?? '').toContain(name);
  });
});

/* ------------------------------------------------------------------ *
 * 2. asNumber no longer short-circuits getNumber
 * ------------------------------------------------------------------ */

describe('a pset value that is already a number inherits the same contract', () => {
  it('an Infinity NominalValue does not slip past the ePSet coercion', () => {
    // `asNumber` used to read `typeof v === 'number' ? v : getNumber(v)`, so a
    // value that reached the property map as an actual `Infinity` — not as the
    // preserved `"1.0E400"` token — bypassed the guard entirely. Hand-built
    // entities are exactly that shape, and are also what every other caller of
    // `extractGeoreferencing` in this package's tests uses.
    const entities = new Map<number, IfcEntity>();
    entities.set(20, {
      expressId: 20,
      type: 'IfcPropertySingleValue',
      attributes: ['Eastings', null, Infinity, null],
    });
    entities.set(21, {
      expressId: 21,
      type: 'IfcPropertySingleValue',
      attributes: ['Northings', null, 1200000, null],
    });
    entities.set(22, {
      expressId: 22,
      type: 'IfcPropertySingleValue',
      attributes: ['TargetCRS', null, 'EPSG:2056', null],
    });
    entities.set(30, {
      expressId: 30,
      type: 'IfcPropertySet',
      attributes: ['guid', null, 'ePSet_MapConversion', null, ['#20', '#21', '#22']],
    });
    const byType = new Map<string, number[]>([['IfcPropertySet', [30]]]);

    const geo = extractGeoreferencing(entities, byType);
    expect(geo.mapConversion?.eastings).not.toBe(Infinity);
    expect(geo.mapConversion?.eastings).not.toBe(0);
    expect(geo.transformMatrix).toBeUndefined();
  });

  it('a finite number NominalValue still reads through (negative control)', () => {
    const entities = new Map<number, IfcEntity>();
    entities.set(20, {
      expressId: 20,
      type: 'IfcPropertySingleValue',
      attributes: ['Eastings', null, 2600000, null],
    });
    entities.set(21, {
      expressId: 21,
      type: 'IfcPropertySingleValue',
      attributes: ['Northings', null, 1200000, null],
    });
    entities.set(30, {
      expressId: 30,
      type: 'IfcPropertySet',
      attributes: ['guid', null, 'ePSet_MapConversion', null, ['#20', '#21']],
    });
    const byType = new Map<string, number[]>([['IfcPropertySet', [30]]]);

    const geo = extractGeoreferencing(entities, byType);
    expect(geo.source).toBe('ePSetMapConversion');
    expect(geo.mapConversion?.eastings).toBe(2600000);
    expect(geo.mapConversion?.northings).toBe(1200000);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The legacy IfcSite path
 * ------------------------------------------------------------------ */

function siteEntities(elevation: IfcAttributeValue) {
  const entities = new Map<number, IfcEntity>();
  entities.set(50, {
    expressId: 50,
    type: 'IfcSite',
    // IfcSite: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation, LongName, CompositionType,
    // RefLatitude[9], RefLongitude[10], RefElevation[11], …
    attributes: [
      'site-guid', null, 'Site', null, null, null, null, null, null,
      [47, 22, 0, 0],
      [8, 32, 0, 0],
      elevation,
      null, null,
    ],
  });
  return {
    entities,
    byType: new Map<string, number[]>([['IfcSite', [50]]]),
  };
}

describe('the legacy IfcSite path does not substitute a 0 elevation', () => {
  it('reads a finite RefElevation (negative control / anti-vacuity)', () => {
    const { entities, byType } = siteEntities(412.5);
    const geo = extractGeoreferencing(entities, byType);
    expect(geo.source).toBe('siteLocation');
    expect(geo.mapConversion?.orthogonalHeight).toBe(412.5);
  });

  it('keeps a genuine zero RefElevation — a site at datum is a real site', () => {
    const { entities, byType } = siteEntities(0);
    const geo = extractGeoreferencing(entities, byType);
    expect(geo.source).toBe('siteLocation');
    expect(geo.mapConversion?.orthogonalHeight).toBe(0);
  });

  it('keeps a site with an absent RefElevation, still at 0', () => {
    // `$` has always meant "no elevation stated", and `?? 0` is the right
    // answer for it. Refusal is reserved for a stated, unrepresentable one.
    const { entities, byType } = siteEntities(null);
    const geo = extractGeoreferencing(entities, byType);
    expect(geo.source).toBe('siteLocation');
    expect(geo.mapConversion?.orthogonalHeight).toBe(0);
  });

  it.each([
    ['+Infinity', '1.0E400'],
    ['-Infinity', '-1.0E400'],
  ])('skips the site when RefElevation is %s', (_label, literal) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { entities, byType } = siteEntities(literal);
    const geo = extractGeoreferencing(entities, byType);

    expect(geo.hasGeoreference).toBe(false);
    expect(geo.mapConversion).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('RefElevation');
  });

  it('an overflowing elevation on one site does not hide the next site', () => {
    // Anti-vacuity for the `continue`: the loop moves on rather than bailing.
    const { entities, byType } = siteEntities('1.0E400');
    entities.set(51, {
      expressId: 51,
      type: 'IfcSite',
      attributes: [
        'site-b', null, 'Site B', null, null, null, null, null, null,
        [47, 22, 0, 0], [8, 32, 0, 0], 300, null, null,
      ],
    });
    byType.set('IfcSite', [50, 51]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const geo = extractGeoreferencing(entities, byType);
    expect(geo.source).toBe('siteLocation');
    expect(geo.mapConversion?.id).toBe(51);
    expect(geo.mapConversion?.orthogonalHeight).toBe(300);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Material layer thickness
 * ------------------------------------------------------------------ */

function layerEntities(thickness: IfcAttributeValue) {
  const entities = new Map<number, IfcEntity>();
  entities.set(100, { expressId: 100, type: 'IfcMaterial', attributes: ['Concrete', null, null] });
  entities.set(200, {
    expressId: 200,
    type: 'IfcMaterialLayer',
    attributes: ['#100', thickness, null, 'Layer A', null, null, 1],
  });
  entities.set(201, {
    expressId: 201,
    type: 'IfcMaterialLayer',
    attributes: ['#100', 0.05, null, 'Layer B', null, null, 2],
  });
  entities.set(300, {
    expressId: 300,
    type: 'IfcMaterialLayerSet',
    attributes: [['#200', '#201'], 'Wall build-up', null],
  });
  return {
    entities,
    byType: new Map<string, number[]>([
      ['IfcMaterial', [100]],
      ['IfcMaterialLayer', [200, 201]],
      ['IfcMaterialLayerSet', [300]],
    ]),
  };
}

describe('material layer thickness is not substituted with 0 either', () => {
  it('reads finite thicknesses and totals them (negative control / anti-vacuity)', () => {
    const { entities, byType } = layerEntities(0.2);
    const data = extractMaterials(entities, byType);
    expect(data.materialLayers.size).toBe(2);
    expect(data.materialLayers.get(200)?.thickness).toBe(0.2);
    expect(data.materialLayerSets.get(300)?.totalThickness).toBeCloseTo(0.25, 10);
  });

  it('keeps a genuine zero-thickness layer', () => {
    // The other direction: a 0 thickness is representable, so it survives —
    // absence has to keep meaning "unrepresentable" and nothing else.
    const { entities, byType } = layerEntities(0);
    const data = extractMaterials(entities, byType);
    expect(data.materialLayers.get(200)?.thickness).toBe(0);
    expect(data.materialLayerSets.get(300)?.totalThickness).toBeCloseTo(0.05, 10);
  });

  it.each([
    ['+Infinity', '1.0E400'],
    ['-Infinity', '-1.0E400'],
  ])('drops the layer when LayerThickness is %s', (_label, literal) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { entities, byType } = layerEntities(literal);
    const data = extractMaterials(entities, byType);

    expect(data.materialLayers.has(200)).toBe(false);
    expect(data.materialLayers.get(200)?.thickness).not.toBe(0);
    // Anti-vacuity: the sibling layer is untouched, so the drop is scoped.
    expect(data.materialLayers.get(201)?.thickness).toBe(0.05);
    // An unknowable total is absent, not silently short by the missing layer.
    expect(data.materialLayerSets.get(300)?.totalThickness).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('LayerThickness');
  });
});
