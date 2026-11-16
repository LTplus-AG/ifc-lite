/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { prepareFootprint } from '../src/region.js';
import { describe, expect, it } from 'vitest';
import {
  BAFU_ATTRIBUTION,
  BAFU_CLASSES,
  BAFU_DISCLAIMER,
  BAFU_LIMITS,
  BAFU_RETURN_PERIOD,
} from '../src/bafu/dataset.js';
import { checkFloodExposure } from '../src/check/check.js';
import { checkBBox, runFloodCheck } from '../src/check/run.js';
import { outlineTerrainPoints, planSamples, pointKey, resolveSampling, terrainSamplerFromGrid } from '../src/check/sampling.js';
import { ELEMENT_PSET, SITE_PSET, toPropertySets } from '../src/psets.js';
import type { HazardProvider, MapPoint, TerrainSource } from '../src/types.js';
import { boxFacts, candidate, CODE, E0, flatTerrain, N0, PROVENANCE, syntheticRaster, TEST_ACCURACY, NO_OTHER_BUILDINGS } from './helpers.js';

const pointTerrain = (heightAt: (p: MapPoint) => number | null): TerrainSource => ({
  crs: 'EPSG:2056',
  verticalCrs: 'EPSG:5728',
  verticalAccuracy: TEST_ACCURACY,
  heightAt,
});

const door = (level: number) => candidate({ position: { x: E0 + 10, y: N0 }, level });
const southRaster = (code: number) =>
  syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, (p: MapPoint) => (p.y < N0 ? code : 0));

function stubProvider(): HazardProvider & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    id: 'stub',
    crs: 'EPSG:2056',
    classes: BAFU_CLASSES,
    extent: { minX: 2_300_000, minY: 900_000, maxX: 3_100_000, maxY: 1_450_000 },
    modelCellSize: 1,
    requests,
    async fetchRaster(request) {
      requests.push(request);
      return southRaster(CODE['depth-0-0.1']);
    },
  };
}

describe('runFloodCheck', () => {
  it('fetches heights only for the distinct sample points when the terrain offers points', async () => {
    const asked: MapPoint[] = [];
    // The raised element is on the upper storey, so the ground-storey door at grade alone confirms the height reference.
    const facts = boxFacts([door(500), candidate({ expressId: 2, position: { x: E0 + 10, y: N0 }, level: 502, storeyId: 11 })]);
    const result = await runFloodCheck(
      facts,
      stubProvider(),
      pointTerrain((p) => {
        asked.push(p);
        return 500;
      }),
    );
    // Both candidates share one anchor, so one set of 12 ring points, plus the outline samples of the height test.
    const s = resolveSampling();
    const distinct = new Set([...planSamples(door(500), prepareFootprint(facts.footprint), s).points.map((p) => p.point), ...outlineTerrainPoints(prepareFootprint(facts.footprint), s)].map(pointKey));
    expect(asked).toHaveLength(distinct.size);
    expect(new Set(asked.map(pointKey)).size).toBe(asked.length);
    expect(result.results.map((r) => r.outcome)).toEqual(['exposed', 'above-mapped-class-range']);
  });

  it('requests one raster covering every ring point', async () => {
    const provider = stubProvider();
    const facts = boxFacts([door(500)]);
    await runFloodCheck(facts, provider, pointTerrain(() => 500));
    expect(provider.requests).toHaveLength(1);
    const box = checkBBox(facts);
    expect(box.minY).toBeLessThanOrEqual(N0 - 3);
    expect(box.maxX).toBeGreaterThanOrEqual(E0 + 23);
  });

  it('refuses before fetching: no candidates, outside the extent, wrong datum', async () => {
    const provider = stubProvider();
    const terrain = pointTerrain(() => 500);
    await expect(runFloodCheck(boxFacts([]), provider, terrain)).rejects.toMatchObject({ code: 'no-candidates' });
    const far = boxFacts([candidate({ position: { x: 90_770, y: 435_320 }, level: 3 })], {
      footprint: { rings: [], source: 'candidate-hull', fromElements: [] },
    });
    await expect(runFloodCheck(far, provider, terrain)).rejects.toMatchObject({ code: 'outside-provider-extent' });
    const lhn = boxFacts([door(500)]);
    lhn.georeference.verticalDatum = 'LHN95';
    await expect(runFloodCheck(lhn, provider, terrain)).rejects.toMatchObject({ code: 'vertical-datum-mismatch' });
    expect(provider.requests).toHaveLength(0);
  });

  // Review finding 2: a wrong unit or scale reading spreads a building over kilometres; it died with a RangeError.
  it('refuses a plan extent no building has (wrong length unit or map scale) before fetching', async () => {
    const provider = stubProvider();
    const spread = boxFacts([door(500), candidate({ expressId: 2, position: { x: E0 + 10_000, y: N0 + 5_000 }, level: 500 })]);
    const refused = runFloodCheck(spread, provider, pointTerrain(() => 500));
    await expect(refused).rejects.toMatchObject({ code: 'georeference-implausible' });
    await expect(refused).rejects.toThrow(/span 10010 m x 5010 m, more than the 1000 m.*wrong length unit or map scale/);
    expect(provider.requests).toHaveLength(0);
    // A raised limit yields results, but the georeference counts as unconfirmed: nothing is favourable.
    const large = await runFloodCheck(spread, provider, pointTerrain(() => 500), { maxPlanExtent: 20_000 });
    expect(large.heightReference.status).toBe('unconfirmed');
    expect(large.heightReference.unconfirmedBecause.join()).toMatch(/accepted only by a raised maxPlanExtent/);
  });

  // Second-round finding 4: options that would coarsen what is read are refused.
  it('refuses a hazard cell coarser than half the model raster and a coarser terrain grid', async () => {
    const facts = boxFacts([door(500)]);
    await expect(runFloodCheck(facts, stubProvider(), pointTerrain(() => 500), { cellSize: 2 })).rejects.toThrow(/at most 0\.5 m/);
    await expect(runFloodCheck(facts, stubProvider(), pointTerrain(() => 500), { terrainResolution: 2 })).rejects.toThrow(/terrainResolution/);
  });

  it('refuses an implausible ground storey even when the terrain comes as points', async () => {
    const sunk = boxFacts([door(0)], { groundStorey: { expressId: 10, level: 0, basis: 'project-zero' } });
    await expect(runFloodCheck(sunk, stubProvider(), pointTerrain(() => 500))).rejects.toMatchObject({ code: 'georeference-implausible' });
  });

  it('passes the provider coverage perimeter to the check', async () => {
    const provider = { ...stubProvider(), covers: () => false };
    const result = await runFloodCheck(boxFacts([door(500)]), provider, pointTerrain(() => 500));
    expect(result.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'outside-coverage' });
  });

  it('asks the provider to confirm rendering only when the whole raster is transparent', async () => {
    let asked = 0;
    const empty: HazardProvider = {
      ...stubProvider(),
      async fetchRaster() {
        return southRaster(0);
      },
      async confirmRendering() {
        asked++;
        return { confirmed: true, requestUrl: 'ref', detail: '81 of 81', retrievedAt: PROVENANCE.retrievedAt };
      },
    };
    const result = await runFloodCheck(boxFacts([door(500)]), empty, pointTerrain(() => 500), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(asked).toBe(1);
    expect(result.results[0].outcome).toBe('no-runoff-mapped');
    expect(result.layerCheck).toMatchObject({ rasterEmpty: true, confirmation: { confirmed: true } });
    const withClasses = { ...stubProvider(), confirmRendering: empty.confirmRendering };
    await runFloodCheck(boxFacts([door(500)]), withClasses, pointTerrain(() => 500));
    expect(asked).toBe(1);
  });
});

// Review finding 9: grids state whether their values sit on nodes or cell centres.
describe('terrainSamplerFromGrid', () => {
  const grid = (sampling: 'node' | 'cell-centre', values: number[], hasData?: boolean) =>
    terrainSamplerFromGrid({
      crs: 'EPSG:2056',
      verticalCrs: 'EPSG:5728',
      sampling,
      width: 2,
      height: 2,
      resolution: 2,
      origin: { x: 0, y: 4 },
      values: new Float32Array(values),
      ...(hasData === undefined ? {} : { hasData }),
    });

  it('cell-centre grids: interpolates between cell centres, null off the grid or next to no-data', () => {
    const sampler = grid('cell-centre', [10, 12, 14, NaN]);
    expect(sampler.heightAt({ x: 1, y: 3 })).toBe(10); // centre of the top-left cell
    expect(sampler.heightAt({ x: 2, y: 3 })).toBe(11); // halfway to the top-right cell centre
    expect(sampler.heightAt({ x: 3, y: 1 })).toBeNull(); // no-data cell
    expect(sampler.heightAt({ x: 9, y: 9 })).toBeNull();
  });

  it('node grids (the geodata-ch convention): values sit at origin + (col, -row) * resolution, no half-cell shift', () => {
    const sampler = grid('node', [10, 12, 14, 16]);
    expect(sampler.heightAt({ x: 0, y: 4 })).toBe(10); // the north-west node is the origin itself
    expect(sampler.heightAt({ x: 2, y: 4 })).toBe(12);
    expect(sampler.heightAt({ x: 1, y: 3 })).toBe(13); // centre of the four nodes
    expect(sampler.heightAt({ x: 2, y: 2 })).toBe(16);
    // The cell-centre reading of the same values is half a cell off:
    expect(grid('cell-centre', [10, 12, 14, 16]).heightAt({ x: 0, y: 4 })).toBeNull();
    expect(sampler.heightAt({ x: 2.01, y: 4 })).toBeNull();
  });

  it('honours hasData: false and refuses an unknown convention', () => {
    expect(grid('node', [10, 12, 14, 16], false).heightAt({ x: 1, y: 3 })).toBeNull();
    expect(() => grid('corner' as 'node', [1, 2, 3, 4])).toThrow(/sampling must be/);
  });
});

describe('property-set payloads', () => {
  it('records dataset, dates, classes, return period, licence, attribution and limits on the site', () => {
    const result = checkFloodExposure(boxFacts([door(500)]), southRaster(CODE['depth-gt-0.25']), flatTerrain(500));
    const { site, elements } = toPropertySets(result, BAFU_CLASSES);
    expect(site.Name).toBe(SITE_PSET);
    expect(SITE_PSET.startsWith('Pset_')).toBe(false);
    expect(ELEMENT_PSET.startsWith('IfcLite_')).toBe(true);
    const props = Object.fromEntries(site.Properties.map((p) => [p.Name, p]));
    expect(props.DatasetDate.NominalValue).toBe('2018-05-22');
    expect(props.RetrievedAt.NominalValue).toBe('2026-11-15T10:00:00.000Z');
    expect(props.ClassDefinition.NominalValue).toContain('depth-gt-0.25: 0.25 m < h (Flow depth h > 0.25 m)');
    expect(props.ClassDefinition.NominalValue).toContain('depth-0-0.1: 0 m < h <= 0.1 m');
    expect(props.Count_Exposed.NominalValue).toBe(1);
    expect(props.Count_AboveMappedClassRange.NominalValue).toBe(0);
    expect(props.VerticalDatumBasis.NominalValue).toBe('not-stated-assumed-equal');
    expect(props.TerrainVerticalCrs.NominalValue).toBe('EPSG:5728');
    expect(props.HeightPlausibilityStatus.NominalValue).toBe('within-band');
    expect(props.HeightPlausibilityBasis.NominalValue).toMatch(/ground storey 500\.00 m within \[500\.00 - 1\.5, 500\.00 \+ 2\.5\] m/);
    expect(props.TerrainMinNearBuilding.NominalValue).toBe(500);
    expect(props.ClearanceMarginBasis.NominalValue).toMatch(/^max\(0\.5, 2 \* sqrt\(0\.3\^2/);
    for (const name of ['ReturnPeriodDE', 'ReturnPeriodEN', 'Licence', 'Attribution', 'LimitsDE', 'LimitsEN', 'DisclaimerDE', 'DisclaimerEN']) {
      expect(props[name], name).toBeDefined();
    }
    expect(elements[0].propertySet.Name).toBe(ELEMENT_PSET);
  });

  // Review finding 3: an element set read on its own must carry the caveat, the source and the dataset date.
  it('gives every element payload the meaning, the caveat, attribution, dataset date and the site set', () => {
    const atGrade = candidate({ expressId: 99, position: { x: E0 + 10, y: N0 + 10 }, level: 500 });
    const window = candidate({ category: 'window', ifcClass: 'IfcWindow', storeyId: 11, position: { x: E0 + 10, y: N0 }, level: 503 });
    const result = checkFloodExposure(boxFacts([window, atGrade]), southRaster(CODE['depth-0-0.1']), flatTerrain(500));
    const set = toPropertySets(result, BAFU_CLASSES).elements[0].propertySet;
    const props = Object.fromEntries(set.Properties.map((p) => [p.Name, p.NominalValue]));
    expect(props.Outcome).toBe('above-mapped-class-range');
    expect(props.OutcomeMeaningEN).toMatch(/This is all it states/);
    expect(props.CaveatEN).toMatch(/Screening result .* not intended for use at building scale; areas it shows as unaffected may still be affected/);
    expect(props.CaveatDE).toMatch(/können dennoch betroffen sein/);
    expect(props.Attribution).toBe('test attribution');
    expect(props.DatasetDate).toBe('2018-05-22');
    expect(props.SitePropertySet).toBe(SITE_PSET);
    expect(props.ResidualRiskEN).toMatch(/cannot be verified from the hazard map.*up to 2\.5 m.*0\.00 m more clearance/);
    expect(props.ResidualRiskDE).toMatch(/aus der Gefährdungskarte nicht prüfen/);
    const site = Object.fromEntries(toPropertySets(result, BAFU_CLASSES).site.Properties.map((p) => [p.Name, p.NominalValue]));
    expect(site.ResidualRiskEN).toBe(props.ResidualRiskEN);
    expect(site).toMatchObject({ HeightReferenceStatus: 'confirmed', HeightReferenceAllowance: 0, HeightReferenceEntryTolerance: 2.5 });
    expect(site.EdgePolicy).toBeUndefined();
    expect(props.DrivingSample).toMatch(/^E 2600\d+\.\d\d, N 1199\d+\.\d\d \(EPSG:2056\)$/);
    expect(Object.values(props)).not.toContain('clear');
  });

  it('writes lengths in the project unit and omits what does not exist', () => {
    const result = checkFloodExposure(boxFacts([door(500)]), southRaster(CODE['depth-gt-0.25']), flatTerrain(500));
    const mm = { ...result, lengthUnitScale: 0.001 };
    const set = toPropertySets(mm, BAFU_CLASSES).elements[0].propertySet;
    const props = Object.fromEntries(set.Properties.map((p) => [p.Name, p]));
    expect(props.ElementLevel).toEqual({ Name: 'ElementLevel', NominalValue: 500_000, Type: 'IfcLengthMeasure' });
    expect(props.ClassLowerBound.NominalValue).toBe(250);
    expect(props.ClassUpperBound).toBeUndefined(); // open-ended: absent, never zero
    expect(props.ClassOpenEnded.NominalValue).toBe(true);
    expect(props.Outcome.NominalValue).toBe('exposed');
    expect(props.UnclassifiedReason).toBeUndefined();
  });
});

describe('disclaimer and attribution', () => {
  it('quotes the publisher in German and English and states the mandatory limits', () => {
    expect(BAFU_DISCLAIMER.de).toContain('Es ist nicht auszuschliessen, dass Oberflächenabfluss auch auf Flächen auftritt');
    expect(BAFU_DISCLAIMER.en).toContain('It cannot be ruled out that areas not affected by the hazard map may be affected.');
    expect(BAFU_DISCLAIMER.de).toContain('1:12`500');
    expect(BAFU_RETURN_PERIOD.en).toMatch(/larger than 100 years/);
    const en = BAFU_LIMITS.map((l) => l.en).join(' ');
    for (const phrase of ['without any verification in the field', 'overflowing watercourses', 'culverts', 'larger than 100 years', 'may be affected', '1: 12,500', 'not legally binding', 'Lucerne']) {
      expect(en).toContain(phrase);
    }
    for (const limit of BAFU_LIMITS) expect(limit.de.length).toBeGreaterThan(20);
    expect(BAFU_ATTRIBUTION).toMatch(/BAFU.*Gefährdungskarte Oberflächenabfluss.*https:\/\/www\.bafu\.admin\.ch\//);
  });
});
