/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end: parse → extract facts → fetch (stubbed) → check → property sets.
 * No live network: the BAFU provider is fed a PNG rendered from a known
 * hazard layout, and terrain comes from a stub grid.
 */

import { fixture as fetchedFixture } from './fixture.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { describe, expect, it } from 'vitest';
import { BAFU_CLASSES } from '../src/bafu/dataset.js';
import { createBafuRunoffProvider } from '../src/bafu/provider.js';
import { runFloodCheck } from '../src/check/run.js';
import { FloodCheckRefusal } from '../src/errors.js';
import { extractModelFacts } from '../src/model/extract.js';
import { ELEMENT_PSET, SITE_PSET, toPropertySets } from '../src/psets.js';
import type { HazardProvider, MapBBox, MapPoint, TerrainSource } from '../src/types.js';
import { CODE, fixture, rgbaPng, syntheticRaster, NO_OTHER_BUILDINGS } from './helpers.js';
import { ORIGIN, ROTATION_DEG, parseStep, syntheticHouse } from './synthetic-model.js';

const VIOLET = [223, 115, 255, 255];
const PURPLE = [132, 0, 168, 255];
const CLEAR = [0, 0, 0, 0];

function toLocal(p: MapPoint): MapPoint {
  const a = (-ROTATION_DEG * Math.PI) / 180;
  const dx = p.x - ORIGIN.e;
  const dy = p.y - ORIGIN.n;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

/** A fake wms.geo.admin.ch: south of the house 0.1–0.25 m, east of it > 0.25 m, elsewhere nothing. */
function fakeWms(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string) => {
    urls.push(String(input));
    const q = new URL(String(input)).searchParams;
    const [minX, minY, maxX, maxY] = q.get('BBOX')!.split(',').map(Number);
    const w = Number(q.get('WIDTH'));
    const h = Number(q.get('HEIGHT'));
    const cell = (maxX - minX) / w;
    const png = rgbaPng(w, h, (col, row) => {
      const local = toLocal({ x: minX + (col + 0.5) * cell, y: maxY - (row + 0.5) * cell });
      if (local.x > 20) return PURPLE;
      if (local.y < 0) return VIOLET;
      return CLEAR;
    });
    expect(minY).toBeLessThan(maxY);
    return new Response(new Blob([png as BlobPart]), { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

/** A flat terrain grid in the geodata-ch shape: values at nodes, origin at the north-west node. */
function flatGrid(height: number, verticalCrs: string, crs: string): TerrainSource & { boxes: MapBBox[] } {
  const boxes: MapBBox[] = [];
  return {
    crs,
    verticalCrs,
    verticalAccuracy: 0.5,
    boxes,
    async grid(bbox, { resolution }) {
      boxes.push(bbox);
      const width = Math.floor((bbox.maxX - bbox.minX) / resolution) + 1;
      const rows = Math.floor((bbox.maxY - bbox.minY) / resolution) + 1;
      return {
        crs,
        verticalCrs,
        sampling: 'node',
        width,
        height: rows,
        resolution,
        origin: { x: bbox.minX, y: bbox.maxY },
        values: new Float32Array(width * rows).fill(height),
        hasData: true,
      };
    },
  };
}

describe('synthetic EPSG:2056 house through the BAFU provider', () => {
  it('finds exposed, undecidable and unaffected elements with the numbers and provenance', async () => {
    const store = await parseStep(syntheticHouse({ verticalDatum: 'LN02' }));
    const facts = extractModelFacts(store, { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
    const { fetchImpl, urls } = fakeWms();
    const provider = createBafuRunoffProvider({ fetch: fetchImpl, now: () => new Date('2026-11-15T11:00:00Z') });
    const terrain = flatGrid(499.95, 'EPSG:5728', 'EPSG:2056');
    const result = await runFloodCheck(facts, provider, terrain);

    expect(urls).toHaveLength(1);
    expect(terrain.boxes).toHaveLength(1);
    const byName = Object.fromEntries(result.results.map((r) => [r.candidate.name, r]));
    // Door threshold 500.00 vs class (0.1, 0.25] on terrain 499.95: surface > 500.05 → exposed.
    expect(byName['Haustür']).toMatchObject({ outcome: 'exposed', hazardClass: { id: 'depth-0.1-0.25' } });
    expect(byName['Haustür'].terrainHeight).toBeCloseTo(499.95, 4);
    expect(byName['Haustür'].comparison?.levelAboveSurfaceLowerBound).toBeCloseTo(-0.05, 4);
    // Opening sill 500.30: between 500.05 and 500.70 (500.20 + 0.5 margin) → the class cannot decide.
    expect(byName['Lüftung'].outcome).toBe('within-class-range');
    expect(byName['Kellerfenster'].outcome).toBe('exposed');
    expect(byName['Lichtschacht 1'].outcome).toBe('exposed');
    expect(byName['Heizkessel']).toMatchObject({ outcome: 'exposed', anchorBasis: 'nearest-outline-point' });
    // West of the house nothing is mapped, but the distribution board stands 2 m inside the outline: the ground
    // sampled at the outline may not be in front of it, so "no runoff mapped" is withheld (second-round finding 3).
    expect(byName['Hauptverteilung']).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'anchor-moved' });
    expect(result.heightReference).toMatchObject({ status: 'confirmed', entries: [{ level: 500 }] });
    expect(result.heightReference.allowance).toBeCloseTo(0.05, 3);
    // External stair east of the house, class > 0.25 m: its upper-estimate top edge 500.00 <= 500.20 → exposed.
    expect(byName['Kellertreppe aussen']).toMatchObject({ outcome: 'exposed', hazardClass: { id: 'depth-gt-0.25' } });
    expect(result.reachableBelowGround.map((r) => r.space.name)).toEqual(['Keller']);
    expect(result.verticalDatum.basis).toBe('stated-and-equal');
    expect(result.provenance.retrievedAt).toBe('2026-11-15T11:00:00.000Z');

    const psets = toPropertySets(result, BAFU_CLASSES);
    expect(psets.site.Name).toBe(SITE_PSET);
    expect(psets.elements).toHaveLength(result.results.length);
    const doorSet = psets.elements.find((e) => e.expressId === byName['Haustür'].candidate.expressId)!.propertySet;
    expect(doorSet.Name).toBe(ELEMENT_PSET);
    expect(Object.fromEntries(doorSet.Properties.map((p) => [p.Name, p.NominalValue]))).toMatchObject({
      Outcome: 'exposed',
      HazardClass: 'depth-0.1-0.25',
      ElementLevel: 500,
      LevelBasis: 'placement-origin',
    });
  });
});

// Review finding 10: an outage answers transparent PNGs, which must not read as "no runoff mapped".
describe('a wholly transparent answer through the BAFU provider', () => {
  function wms(reference: Uint8Array): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string) => {
      urls.push(String(input));
      const q = new URL(String(input)).searchParams;
      const png = q.get('BBOX') === '2599560,1199720,2599569,1199729'
        ? reference
        : rgbaPng(Number(q.get('WIDTH')), Number(q.get('HEIGHT')), () => CLEAR);
      return new Response(new Blob([png as BlobPart]), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it('reports "no runoff mapped" only after the reference location confirms the layer renders', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse()), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
    const up = wms(fixture('bern-uniform-9px.png'));
    const ok = await runFloodCheck(facts, createBafuRunoffProvider({ fetch: up.fetchImpl }), flatGrid(499.95, 'EPSG:5728', 'EPSG:2056'), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(up.urls).toHaveLength(2);
    expect(ok.layerCheck.confirmation?.confirmed).toBe(true);
    // Every element not withheld is "no runoff mapped"; interior equipment (anchor moved) and the external stair
    // (upper-estimate level) are withheld by the same conditions that withhold "above the mapped class range".
    expect(new Set(ok.results.map((r) => r.outcome))).toEqual(new Set(['no-runoff-mapped', 'unclassified']));
    expect(new Set(ok.results.filter((r) => r.outcome === 'unclassified').map((r) => r.unclassifiedReason))).toEqual(
      new Set(['anchor-moved', 'level-upper-estimate']),
    );
    expect(ok.results.find((r) => r.candidate.name === 'Haustür')?.outcome).toBe('no-runoff-mapped');

    const down = wms(rgbaPng(9, 9, () => CLEAR));
    const outage = await runFloodCheck(facts, createBafuRunoffProvider({ fetch: down.fetchImpl }), flatGrid(499.95, 'EPSG:5728', 'EPSG:2056'), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(new Set(outage.results.map((r) => r.unclassifiedReason))).toEqual(new Set(['layer-not-confirmed']));
    const site = Object.fromEntries(toPropertySets(outage, BAFU_CLASSES).site.Properties.map((p) => [p.Name, p.NominalValue]));
    expect(site).toMatchObject({ RasterEmpty: true, LayerRenderingConfirmed: false, Count_NoRunoffMapped: 0 });
  });
});

describe('repo fixtures', () => {
  const sample = fileURLToPath(new URL('../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));

  async function parseFile(path: string) {
    const b = readFileSync(path);
    return new IfcParser().parseColumnar(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }

  it('refuses the committed UTM 60S sample against the Swiss map, both at extraction and at run time', async () => {
    const store = await parseFile(sample);
    await expect(async () => extractModelFacts(store, { expectedCrs: 'EPSG:2056' })).rejects.toMatchObject({ code: 'crs-mismatch' });
    const facts = extractModelFacts(store);
    expect(facts.georeference.crs).toBe('EPSG:32760');
    const provider = createBafuRunoffProvider({ fetch: (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch });
    await expect(runFloodCheck(facts, provider, flatGrid(0, 'EPSG:5728', 'EPSG:2056'))).rejects.toBeInstanceOf(FloodCheckRefusal);
  });

  const { path: miniBim, present: hasMiniBim } = fetchedFixture('georeferencer/MiniBIM-3.1-DO_01_VORM.ifc');
  it.skipIf(!hasMiniBim)('runs a Revit-exported model (MiniBIM, EPSG:28992) end to end with a stub provider in its CRS (fixture: pnpm fixtures)', async () => {
    const store = await parseFile(miniBim);
    // Without a stated ground storey the ±0.00 pick is only a guess (so nothing is excluded by its level).
    expect(extractModelFacts(store).groundStorey).toMatchObject({ level: 3.5, basis: 'project-zero' });
    const facts = extractModelFacts(store, { groundStorey: 41 });
    expect(facts.georeference).toMatchObject({ crs: 'EPSG:28992', orthogonalHeight: 3.5, verticalDatum: null });
    expect(facts.groundStorey).toMatchObject({ level: 3.5, basis: 'given' });
    // The ground slab's profile has four holes: an 81.33 m² floor area and two 4.22 m² shafts, all roofed by the slabs above
    // (interior, filled), and a 9.63 m² shaft open through every floor and the roof (a courtyard: open ground, guarded locally).
    expect(facts.footprint.source).toBe('slab-outline');
    expect(facts.footprint.quality?.worst).toBe('courtyard-ring');
    expect(facts.footprint.courtyardRings).toHaveLength(1);
    expect(facts.footprint.quality?.notes.filter((n) => /roofed by slab/.test(n))).toHaveLength(3);
    const count = (cat: string) => facts.candidates.filter((c) => c.category === cat).length;
    // Ten ground-floor doors sit in walls with Pset_WallCommon.IsExternal = TRUE (the doors themselves say FALSE).
    expect(count('door')).toBe(10);
    expect(count('wall-opening')).toBe(15);
    expect(count('slab-opening')).toBe(4);
    // The doors' bodies are mapped items (Revit): read, their levels are exact. The 45 mapped equipment items lie on the
    // first floor and above (7.40 m to 28.40 m), proven above the scope now that their bodies are read, so they are skipped.
    expect(facts.candidates.filter((c) => c.category === 'door').every((c) => !c.levelIsUpperEstimate)).toBe(true);
    expect(facts.skipped.filter((sk) => sk.reason === 'equipment above the ground storey')).toHaveLength(45);

    // The Swiss provider refuses this model outright.
    const bafu = createBafuRunoffProvider({ fetch: (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch });
    await expect(runFloodCheck(facts, bafu, flatGrid(3.4, 'EPSG:5709', 'EPSG:28992'))).rejects.toMatchObject({ code: 'crs-mismatch' });

    // A stub provider in the model's own CRS: 0–0.1 m everywhere outside the building.
    const stub: HazardProvider = {
      id: 'stub',
      crs: 'EPSG:28992',
      classes: BAFU_CLASSES,
      extent: { minX: 0, minY: 300_000, maxX: 300_000, maxY: 650_000 },
      modelCellSize: 1,
      async fetchRaster({ bbox }) {
        const w = Math.ceil(bbox.maxX - bbox.minX);
        const h = Math.ceil(bbox.maxY - bbox.minY);
        return syntheticRaster(bbox.minX, bbox.minY, w, h, 1, () => CODE['depth-0-0.1'], 'EPSG:28992');
      },
    };
    const result = await runFloodCheck(facts, stub, flatGrid(3.4, 'EPSG:5709', 'EPSG:28992'));
    expect(result.results).toHaveLength(facts.candidates.length);
    // Thresholds at 3.50 vs class (0, 0.1] on terrain 3.40: 3.40 < 3.50 <= 3.50 + 0.5 → undecidable from the class.
    const doors = result.results.filter((r) => r.candidate.category === 'door');
    expect(new Set(doors.map((r) => r.outcome))).toEqual(new Set(['within-class-range']));
    expect(result.verticalDatum.basis).toBe('not-stated-assumed-equal');
  });
});
