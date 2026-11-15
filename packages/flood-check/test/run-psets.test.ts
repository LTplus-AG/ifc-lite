/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
import { planSamples, resolveSampling, terrainSamplerFromGrid } from '../src/check/sampling.js';
import { ELEMENT_PSET, SITE_PSET, toPropertySets } from '../src/psets.js';
import type { HazardProvider, MapPoint } from '../src/types.js';
import { boxFacts, candidate, CODE, E0, flatTerrain, N0, syntheticRaster } from './helpers.js';

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
    const facts = boxFacts([door(500), candidate({ expressId: 2, position: { x: E0 + 10, y: N0 }, level: 501 })]);
    const result = await runFloodCheck(facts, stubProvider(), {
      crs: 'EPSG:2056',
      verticalReference: 'LN02',
      heightAt: (p) => {
        asked.push(p);
        return 500;
      },
    });
    // Both candidates share one anchor, so one set of 12 ring points.
    expect(asked).toHaveLength(planSamples(door(500), facts.footprint, resolveSampling()).points.length);
    expect(result.results.map((r) => r.outcome)).toEqual(['exposed', 'clear']);
  });

  it('requests one raster covering every ring point', async () => {
    const provider = stubProvider();
    const facts = boxFacts([door(500)]);
    await runFloodCheck(facts, provider, { crs: 'EPSG:2056', verticalReference: 'LN02', heightAt: () => 500 });
    expect(provider.requests).toHaveLength(1);
    const box = checkBBox(facts);
    expect(box.minY).toBeLessThanOrEqual(N0 - 3);
    expect(box.maxX).toBeGreaterThanOrEqual(E0 + 23);
  });

  it('refuses before fetching: no candidates, outside the extent, wrong datum', async () => {
    const provider = stubProvider();
    const terrain = { crs: 'EPSG:2056', verticalReference: 'LN02', heightAt: () => 500 };
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
});

describe('terrainSamplerFromGrid', () => {
  it('interpolates between cell centres and returns null off the grid or next to no-data', () => {
    const sampler = terrainSamplerFromGrid({
      crs: 'EPSG:2056',
      verticalReference: 'LN02',
      width: 2,
      height: 2,
      cellSize: 2,
      origin: { x: 0, y: 4 },
      heights: new Float32Array([10, 12, 14, NaN]),
    });
    expect(sampler.heightAt({ x: 1, y: 3 })).toBe(10); // centre of the top-left cell
    expect(sampler.heightAt({ x: 2, y: 3 })).toBe(11); // halfway to the top-right cell centre
    expect(sampler.heightAt({ x: 3, y: 1 })).toBeNull(); // no-data cell
    expect(sampler.heightAt({ x: 9, y: 9 })).toBeNull();
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
    expect(props.VerticalDatumBasis.NominalValue).toBe('not-stated-assumed-equal');
    for (const name of ['ReturnPeriodDE', 'ReturnPeriodEN', 'Licence', 'Attribution', 'LimitsDE', 'LimitsEN', 'DisclaimerDE', 'DisclaimerEN']) {
      expect(props[name], name).toBeDefined();
    }
    expect(elements[0].propertySet.Name).toBe(ELEMENT_PSET);
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
