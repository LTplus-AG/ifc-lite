/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { FloodCheckRefusal } from '../src/errors.js';
import { extractModelFacts } from '../src/model/extract.js';
import { equipment2x3 } from './synthetic-2x3.js';
import { mapOf, parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

async function facts(options: Parameters<typeof syntheticHouse>[0] = {}, extract: Parameters<typeof extractModelFacts>[1] = { groundStorey: 'EG' }) {
  return extractModelFacts(await parseStep(syntheticHouse(options)), extract);
}

async function refusal(promise: Promise<unknown>): Promise<FloodCheckRefusal> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof FloodCheckRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('extractModelFacts on a synthetic EPSG:2056 house', () => {
  it('reads the georeference, storeys, ground storey and slab footprint in map coordinates', async () => {
    const f = await facts({}, {});
    expect(f.georeference).toMatchObject({ crs: 'EPSG:2056', verticalDatum: null, scaleBasis: 'units-agree', orthogonalHeight: 500 });
    expect(f.georeference.rotationDegrees).toBeCloseTo(30, 9);
    expect(f.storeys.map((s) => [s.name, s.level])).toEqual([['UG', 497], ['EG', 500], ['OG', 504]]);
    expect(f.groundStorey).toMatchObject({ level: 500, basis: 'project-zero' });
    expect(f.footprint.source).toBe('slab-outline');
    const corners = f.footprint.rings[0];
    expect(corners).toHaveLength(4);
    for (const [x, y] of [[0, 0], [20, 0], [20, 10], [0, 10]]) {
      const want = mapOf(x, y);
      expect(corners.some((c) => Math.hypot(c.x - want.x, c.y - want.y) < 1e-6)).toBe(true);
    }
  });

  it('picks one element of every candidate kind, at the right place and level', async () => {
    const f = await facts();
    const byName = Object.fromEntries(f.candidates.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(
      ['Haustür', 'Hauptverteilung', 'Heizkessel', 'Kellerfenster', 'Kellertreppe aussen', 'Lichtschacht 1', 'Lüftung'].sort(),
    );
    const near = (c: { position: { x: number; y: number } }, x: number, y: number) => {
      const want = mapOf(x, y);
      expect(c.position.x).toBeCloseTo(want.x, 6);
      expect(c.position.y).toBeCloseTo(want.y, 6);
    };
    // Door: host wall external wins over the door's own IsExternal = false.
    expect(byName['Haustür']).toMatchObject({ category: 'door', ifcClass: 'IfcDoor', level: 500, predefinedType: 'DOOR' });
    expect(byName['Haustür'].selectedBecause).toMatch(/host IsExternal.*states IsExternal = false/);
    near(byName['Haustür'], 10, 0);
    // Unfilled opening: placed at the wall origin, hole read from its extrusion.
    expect(byName['Lüftung']).toMatchObject({ category: 'wall-opening', levelBasis: 'opening-body-bottom' });
    expect(byName['Lüftung'].level).toBeCloseTo(500.3, 9);
    near(byName['Lüftung'], 15, 0);
    expect(byName['Kellerfenster']).toMatchObject({ category: 'basement-window', level: 499 });
    expect(byName['Lichtschacht 1']).toMatchObject({ category: 'light-well', ifcClass: 'IfcBuildingElementProxy' });
    expect(byName['Lichtschacht 1'].level).toBeCloseTo(498.8, 9);
    expect(byName['Heizkessel']).toMatchObject({ category: 'equipment', ifcClass: 'IfcBoiler', predefinedType: 'WATER', level: 497 });
    expect(byName['Hauptverteilung']).toMatchObject({ category: 'equipment', ifcClass: 'IfcElectricDistributionBoard', level: 500 });
    // External stair: entry at the terrain; the ground storey level is the upper estimate the check lowers to terrain.
    expect(byName['Kellertreppe aussen']).toMatchObject({
      category: 'stair',
      level: 500,
      levelBasis: 'ground-storey-or-terrain',
      levelIsUpperEstimate: true,
    });
    // Not picked: the interior stair, the pump upstairs, the upper-floor door.
    expect(f.spaces).toMatchObject([{ name: 'Keller', floorLevel: 497 }]);
  });

  it('honours a given ground storey and footprint', async () => {
    const ring = [mapOf(-1, -1), mapOf(21, -1), mapOf(21, 11), mapOf(-1, 11)];
    const f = await facts({}, { groundStorey: 'UG', footprint: [ring] });
    expect(f.groundStorey).toMatchObject({ level: 497, basis: 'given' });
    expect(f.footprint).toMatchObject({ source: 'given', rings: [ring] });
  });

  it('records a stated vertical datum for the check to compare', async () => {
    expect((await facts({ verticalDatum: 'LN02' })).georeference.verticalDatum).toBe('LN02');
  });
});

// Review finding 5.
describe('technical equipment', () => {
  it('resolves IFC2X3 generic occurrences through their type object', async () => {
    const f = extractModelFacts(await parseStep(equipment2x3()), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
    expect(f.georeference.source).toBe('ePSetMapConversion');
    const picked = Object.fromEntries(f.candidates.filter((c) => c.category === 'equipment').map((c) => [c.name, c]));
    expect(Object.keys(picked).sort()).toEqual(['Batteriespeicher', 'Hauptschalter', 'Hauptverteilung', 'Heizkessel', 'Umwälzpumpe', 'Wärmepumpe']);
    expect(picked['Heizkessel']).toMatchObject({ ifcClass: 'IfcEnergyConversionDevice', predefinedType: 'WATER', level: 497 });
    expect(picked['Heizkessel'].selectedBecause).toBe('IfcEnergyConversionDevice typed IfcBoilerType WATER in the ground storey or below');
    expect(picked['Batteriespeicher'].selectedBecause).toMatch(/IfcFlowStorageDevice typed IfcElectricFlowStorageDeviceType BATTERY/);
    expect(picked['Hauptverteilung'].ifcClass).toBe('IfcElectricDistributionPoint');
    // Not picked: a wash basin (IfcFlowTerminal typed IfcSanitaryTerminalType) and a pump upstairs.
  });

  it('adds batteries, generators, heat pumps, chillers, switching and protective devices and communications appliances in IFC4', async () => {
    const extra = (b: Extra) => {
      const at = (cls: string, name: string, predefined: string) =>
        b.contain(b.storeys.ug.id, b.add(`${cls}(${b.guid()},$,'${name}',$,$,#${b.place(b.storeys.ug.pl, 6, 6, 0)},$,$,.${predefined}.)`));
      at('IFCELECTRICFLOWSTORAGEDEVICE', 'Batterie', 'BATTERY');
      at('IFCELECTRICGENERATOR', 'Notstrom', 'CHP');
      at('IFCUNITARYEQUIPMENT', 'Wärmepumpe', 'SPLITSYSTEM');
      at('IFCCHILLER', 'Kältemaschine', 'AIRCOOLED');
      at('IFCSWITCHINGDEVICE', 'Trenner', 'SWITCHDISCONNECTOR');
      at('IFCPROTECTIVEDEVICE', 'FI', 'RESIDUALCURRENTCIRCUITBREAKER');
      at('IFCCOMMUNICATIONSAPPLIANCE', 'Router', 'ROUTER');
      // IFC4 exporters also write a generic occurrence with a specific type.
      const o = b.add(`IFCFLOWMOVINGDEVICE(${b.guid()},$,'Hebeanlage',$,$,#${b.place(b.storeys.ug.pl, 7, 7, 0)},$,$)`);
      const t = b.add(`IFCPUMPTYPE(${b.guid()},$,'Pumpe',$,$,$,$,$,$,.SUBMERSIBLEPUMP.)`);
      b.add(`IFCRELDEFINESBYTYPE(${b.guid()},$,$,$,(#${o}),#${t})`);
      b.contain(b.storeys.ug.id, o);
    };
    const f = await facts({ extra });
    const names = f.candidates.filter((c) => c.category === 'equipment').map((c) => c.name);
    for (const name of ['Batterie', 'Notstrom', 'Wärmepumpe', 'Kältemaschine', 'Trenner', 'FI', 'Router', 'Hebeanlage', 'Heizkessel', 'Hauptverteilung']) {
      expect(names, name).toContain(name);
    }
    expect(names).not.toContain('Pumpe OG');
  });
});

describe('standard-case slabs', () => {
  it('an IfcSlabStandardCase gives the slab outline like an IfcSlab', async () => {
    const extra = (b: Extra) => {
      const solid = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      const slab = b.add(`IFCSLABSTANDARDCASE(${b.guid()},$,'Bodenplatte',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`);
      b.contain(b.storeys.eg.id, slab);
    };
    const f = await facts({ slab: false, extra });
    expect(f.footprint.source).toBe('slab-outline');
    expect(f.footprint.rings[0]).toHaveLength(4);
  });
});

describe('stairs, ramps, doors and windows', () => {
  // Review finding 7.
  it('keeps an external ramp placed at its top and skips an external stair whose body leads up', async () => {
    const extra = (b: Extra) => {
      // A garage ramp placed at its top edge (ground storey level), no readable body.
      b.contain(b.storeys.eg.id, b.add(`IFCRAMP(${b.guid()},$,'Rampe Tiefgarage',$,$,#${b.place(b.storeys.eg.pl, 10, -6, 0)},$,$,.STRAIGHT_RUN_RAMP.)`));
      // Entrance steps: body from z = 0 to 0.6 m, outside the footprint, leading UP.
      const solid = b.rectExtrusion(0, 0, 2, 1, 0.6, b.axis(0, 0, 0), b.dir(0, 0, 1));
      const steps = b.add(`IFCSTAIR(${b.guid()},$,'Eingangsstufen',$,$,#${b.place(b.storeys.eg.pl, 3, -2, 0)},#${b.shape([solid])},$,.STRAIGHT_RUN_STAIR.)`);
      b.contain(b.storeys.eg.id, steps);
    };
    const f = await facts({ extra });
    const ramp = f.candidates.find((c) => c.name === 'Rampe Tiefgarage');
    expect(ramp).toMatchObject({ category: 'ramp', level: 500, levelBasis: 'ground-storey-or-terrain', levelIsUpperEstimate: true });
    expect(ramp?.selectedBecause).toMatch(/body cannot be read.*kept conservatively.*entry at the terrain/);
    expect(f.candidates.some((c) => c.name === 'Eingangsstufen')).toBe(false);
    expect(f.skipped.find((s) => s.ifcClass === 'IfcStair' && /leads up/.test(s.reason))).toBeDefined();
  });

  it('keeps an external stair when one flight leads up but another has no readable body', async () => {
    const extra = (b: Extra) => {
      const solid = b.rectExtrusion(0, 0, 2, 1, 0.6, b.axis(0, 0, 0), b.dir(0, 0, 1));
      const stair = b.add(`IFCSTAIR(${b.guid()},$,'Aussentreppe',$,$,#${b.place(b.storeys.eg.pl, 3, -2, 0)},#${b.shape([solid])},$,.STRAIGHT_RUN_STAIR.)`);
      const flight = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf unten',$,$,#${b.place(b.storeys.eg.pl, 3, -3, 0)},$,$,1,1,$,$,$)`);
      b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${stair},(#${flight}))`);
      b.contain(b.storeys.eg.id, stair);
    };
    const f = await facts({ extra });
    const stair = f.candidates.find((c) => c.name === 'Aussentreppe');
    expect(stair?.selectedBecause).toMatch(/cannot be read.*kept conservatively/);
    expect(f.skipped.some((s) => s.ifcClass === 'IfcStair' && /leads up/.test(s.reason))).toBe(false);
  });

  // Review finding 8.
  it('takes the lower of a window placement and its filled opening, with a note when they differ', async () => {
    let wallPl = 0;
    const extra = (b: Extra) => {
      wallPl = b.place(b.storeys.eg.pl, 0, 0, 0);
      const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Süd 2',$,$,#${wallPl},$,$,.STANDARD.)`);
      b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(b.storeys.eg.id, wall);
      // Opening hole z 1.0..2.2 at x 4..5; the window is placed at its HEAD (z 2.2).
      const solid = b.rectExtrusion(0, 0, 1, 1.2, 0.4, b.axis(4.5, -0.2, 1.6, b.dir(0, 1, 0), b.dir(1, 0, 0)), b.dir(0, 0, 1));
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Fenster',$,$,#${b.place(wallPl, 0, 0, 0)},#${b.shape([solid])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
      const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster Kopf',$,$,#${b.place(b.storeys.eg.pl, 4.5, 0, 2.2)},$,$,1.2,1.,.WINDOW.,$,$)`);
      b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
      b.contain(b.storeys.eg.id, win);
    };
    const f = await facts({ extra });
    const win = f.candidates.find((c) => c.name === 'Fenster Kopf')!;
    expect(win.levelBasis).toBe('opening-body-bottom');
    expect(win.level).toBeCloseTo(501, 9);
    expect(win.notes?.join()).toMatch(/placement origin 502\.200 m and the bottom of the filled opening 501\.000 m differ by 1\.20 m/);
    // The door, whose opening has no body, keeps its placement.
    expect(f.candidates.find((c) => c.name === 'Haustür')).toMatchObject({ levelBasis: 'placement-origin', level: 500 });
  });
});

// Review finding 6: without a slab outline, the external walls' axes are chained into a real outline.
describe('footprint from external walls', () => {
  const walls = (pts: Array<[number, number]>, closed: boolean) => (b: Extra) => {
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const curve = b.add(`IFCPOLYLINE((#${b.pt2(x0, y0)},#${b.pt2(x1, y1)}))`);
      const wall = b.add(`IFCWALL(${b.guid()},$,'W${i}',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([curve], 'Axis', 'Curve2D')},$,.STANDARD.)`);
      b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(b.storeys.eg.id, wall);
    }
  };
  // An L: the notch at x 12..20, y 6..10 is outside the building. (The house's own south wall 0..20 stays; it lies on this ring.)
  const L: Array<[number, number]> = [[20, 0], [20, 6], [12, 6], [12, 10], [0, 10], [0, 0]];

  it('keeps an L-notch outside the footprint', async () => {
    const f = await facts({ slab: false, extra: walls(L, false) });
    expect(f.footprint.source).toBe('external-wall-outline');
    const ring = f.footprint.rings[0];
    expect(ring).toHaveLength(6);
    const notch = mapOf(16, 8);
    expect(ring.some((p) => Math.hypot(p.x - mapOf(12, 6).x, p.y - mapOf(12, 6).y) < 1e-6)).toBe(true);
    const { insideFootprint, prepareFootprint } = await import('../src/region.js');
    expect(insideFootprint(prepareFootprint(f.footprint), notch)).toBe(false);
  });

  it('falls back to the hull when the walls do not close', async () => {
    const f = await facts({ slab: false, extra: walls([[20, 0], [20, 6], [12, 6], [12, 10], [0, 10]], false) });
    expect(f.footprint.source).toBe('external-wall-hull');
  });
});

describe('review threads: no footprint, explicit IsExternal = false outside', () => {
  it('keeps doors without IsExternal when no outline can be read, on a candidate hull', async () => {
    const extra = (b: Extra) => {
      for (const [name, x, y] of [['Tür A', 0, 5], ['Tür B', 20, 5], ['Tür C', 10, 10]] as const) {
        b.contain(b.storeys.eg.id, b.add(`IFCDOOR(${b.guid()},$,'${name}',$,$,#${b.place(b.storeys.eg.pl, x, y, 0)},$,$,2.1,1.,.DOOR.,$,$)`));
      }
    };
    // No slab, and the house's south wall is the only external wall: no ring can be built from one axis.
    const f = await facts({ slab: false, extra });
    const doors = f.candidates.filter((c) => c.category === 'door').map((c) => c.name);
    expect(doors).toEqual(expect.arrayContaining(['Tür A', 'Tür B', 'Tür C']));
  });

  it('keeps an outside stair that states IsExternal = false', async () => {
    const extra = (b: Extra) => {
      const stair = b.add(`IFCSTAIR(${b.guid()},$,'Aussentreppe falsch',$,$,#${b.place(b.storeys.ug.pl, 25, 2, 0)},$,$,.STRAIGHT_RUN_STAIR.)`);
      b.pset(stair, 'Pset_StairCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
      b.contain(b.storeys.ug.id, stair);
    };
    const stair = (await facts({ extra })).candidates.find((c) => c.name === 'Aussentreppe falsch');
    expect(stair?.selectedBecause).toMatch(/outside the footprint \(despite IsExternal = false\)/);
  });
});

describe('refusals', () => {
  it('refuses a model without a map conversion', async () => {
    expect((await refusal(facts({ withMapConversion: false }))).code).toBe('not-georeferenced');
  });

  it('refuses a model in another CRS than required, and an unidentifiable CRS', async () => {
    expect((await refusal(facts({ crsName: 'EPSG:21781' }, { expectedCrs: 'EPSG:2056' }))).code).toBe('crs-mismatch');
    expect((await refusal(facts({ crsName: 'Lokales System', crsDescription: 'Baustellenkoordinaten' }))).code).toBe('crs-unrecognised');
    // A name that is no EPSG code is still identified when the description names the CRS unambiguously.
    expect((await facts({ crsName: 'Landeskoordinaten' })).georeference.crs).toBe('EPSG:2056');
  });

  it('refuses an ambiguous Scale and accepts an explicit reading', async () => {
    expect((await refusal(facts({ lengthUnit: 'MILLIMETRE' }))).code).toBe('ambiguous-map-scale');
    const bridged = await facts({ lengthUnit: 'MILLIMETRE' }, { mapScale: 'unit-bridged' });
    expect(bridged.georeference.scaleBasis).toBe('unit-bridged');
    const door = bridged.candidates.find((c) => c.name === 'Haustür')!;
    expect(door.position.x).toBeCloseTo(mapOf(10, 0).x, 6);
    expect(door.level).toBeCloseTo(500, 9);
    // Spec-conformant file: Scale 0.001 bridges mm to the metre map unit.
    const explicit = await facts({ lengthUnit: 'MILLIMETRE', scale: 0.001 });
    expect(explicit.georeference.scaleBasis).toBe('explicit-scale');
    expect(explicit.candidates.find((c) => c.name === 'Haustür')!.position.y).toBeCloseTo(mapOf(10, 0).y, 6);
  });
});

// Second-round finding 4: a smaller listing scope would leave elements out, which reads as nothing found.
describe('listing options may only widen what is listed', () => {
  it('refuses a smaller aboveGroundScope or boundaryTolerance', async () => {
    await expect(facts({}, { expectedCrs: 'EPSG:2056', aboveGroundScope: 1 })).rejects.toThrow(/aboveGroundScope may only be raised/);
    await expect(facts({}, { expectedCrs: 'EPSG:2056', boundaryTolerance: 0.2 })).rejects.toThrow(/boundaryTolerance may only be raised/);
    await expect(facts({}, { expectedCrs: 'EPSG:2056', aboveGroundScope: 4, boundaryTolerance: 1.5 })).resolves.toBeDefined();
  });
});

// PR review thread: a slab profile with voids lost its courtyards but was still called a real outline.
describe('slab outline with voids', () => {
  it('a profile hole open to the sky (no slab above) is a courtyard: a hole in the outline, never a complete one', async () => {
    const f = await facts(
      {
        slab: false,
        extra: (b) => {
          const loop = (pts: Array<[number, number]>) =>
            b.add(`IFCPOLYLINE((${[...pts, pts[0]].map(([x, y]) => `#${b.pt2(x, y)}`).join(',')}))`);
          const outer = loop([[0, 0], [20, 0], [20, 10], [0, 10]]);
          const court = loop([[6, 3], [14, 3], [14, 7], [6, 7]]);
          const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${outer},(#${court}))`);
          const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
          const slab = b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte mit Hof',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`);
          b.contain(b.storeys.eg.id, slab);
        },
      },
      { expectedCrs: 'EPSG:2056' },
    );
    // Since the MiniBIM queue failure: a hole is read, not filled; open to the sky it is a courtyard (guarded locally).
    expect(f.footprint.source).toBe('slab-outline');
    expect(f.footprint.courtyardRings).toEqual([1]);
    expect(f.footprint.quality?.worst).toBe('courtyard-ring');
  });
});
