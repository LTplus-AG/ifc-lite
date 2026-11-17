/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The buildings layer on exact synthetic prisms (ECEF tiles built from LV95
 * rings, every second triangle wound the wrong way, as the swisstopo tiles
 * are): winding and normals, subject matching, whole-building clipping,
 * caps and the honesty rules.
 */

import { describe, expect, it } from 'vitest';
import { buildSiteContext } from '../src/build.js';
import { SUBJECT_MIN_OVERLAP } from '../src/buildings-footprint.js';
import { BUILDING_SET } from '../src/buildings-layer.js';
import type { BuildingsOptions, MapPoint, SiteContextFeature, SiteContextLayer } from '../src/types.js';
import { stubGeodata } from './stub-geodata.js';
import { prismFeature, stubReader, type BoxSpec } from './tiles-support.js';

const C = { x: 2_600_000, y: 1_200_000 };

function rect(x0: number, y0: number, w: number, h: number): Array<[number, number]> {
  return [[C.x + x0, C.y + y0], [C.x + x0 + w, C.y + y0], [C.x + x0 + w, C.y + y0 + h], [C.x + x0, C.y + y0 + h]];
}

const BOX: BoxSpec = { ring: rect(-10, -5, 20, 10), base: 500, top: 512, attributes: { EGID: 111, UUID: 'BOX', OBJEKTART: 'Gebaeude Einzelhaus', DACH_MAX: 512, DACH_MIN: 512, GELAENDEPUNKT: 500, GESAMTHOEHE: 12 } };
// An L: the inner corner's walls face the building's centre region, which a centroid test alone gets wrong.
const L: BoxSpec = { ring: [[C.x + 30, C.y], [C.x + 60, C.y], [C.x + 60, C.y + 10], [C.x + 40, C.y + 10], [C.x + 40, C.y + 30], [C.x + 30, C.y + 30]], base: 501, top: 508, attributes: { EGID: 222 } };

async function layerOf(specs: BoxSpec[], options: { radius?: number; subject?: { egid?: string; footprint?: MapPoint[][] }; buildings?: Partial<BuildingsOptions> } = {}): Promise<SiteContextLayer> {
  const doc = await buildSiteContext({
    centre: C,
    radius: options.radius ?? 100,
    layers: ['buildings'],
    geodata: stubGeodata(),
    subject: options.subject,
    buildings: { reader: stubReader(specs.map((s, i) => prismFeature(s, i))), ...options.buildings },
  });
  return doc.layers[0];
}

function triangles(f: SiteContextFeature): Array<{ centre: number[]; normal: number[]; part: string }> {
  const { positions: p, normals: n, parts } = f.mesh!;
  const out = [];
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    const part = parts!.find((q) => t * 3 >= q.firstIndex && t * 3 < q.firstIndex + q.indexCount)!.name;
    out.push({ centre: [0, 1, 2].map((d) => f.origin[d] + (p[o + d] + p[o + 3 + d] + p[o + 6 + d]) / 3), normal: [n[o], n[o + 1], n[o + 2]], part });
  }
  return out;
}

/** Outward for a wall: the point just outside along the normal lies outside the ring, the point just inside lies in it. */
function inside(ring: Array<[number, number]>, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

describe('winding and normals', () => {
  for (const [name, spec] of [['box', BOX], ['L-shaped prism', L]] as const) {
    it(`points every roof normal up, the base down and every wall outward for a ${name}`, async () => {
      const layer = await layerOf([spec]);
      const f = layer.features[0];
      expect(f.mesh!.parts!.map((p) => p.name)).toEqual(['roof', 'wall']);
      const tris = triangles(f);
      const n = spec.ring.length;
      expect(tris.filter((t) => t.part === 'roof')).toHaveLength(n - 2);
      expect(tris.filter((t) => t.part === 'wall')).toHaveLength(2 * n + n - 2);
      for (const t of tris) {
        expect(Math.hypot(t.normal[0], t.normal[1], t.normal[2])).toBeCloseTo(1, 6);
        if (t.part === 'roof') expect(t.normal[2]).toBeCloseTo(1, 6);
        else if (Math.abs(t.normal[2]) > 0.5) expect(t.normal[2]).toBeCloseTo(-1, 6);
        else {
          expect(Math.abs(t.normal[2])).toBeLessThan(1e-6);
          expect(inside(spec.ring, t.centre[0] + 0.01 * t.normal[0], t.centre[1] + 0.01 * t.normal[1])).toBe(false);
          expect(inside(spec.ring, t.centre[0] - 0.01 * t.normal[0], t.centre[1] - 0.01 * t.normal[1])).toBe(true);
        }
      }
    });
  }

  it('gives each building its own whole-metre origin at its base, with small float32 offsets', async () => {
    const layer = await layerOf([BOX]);
    const f = layer.features[0];
    expect(f.origin).toEqual([C.x, C.y, 500]);
    expect(Math.max(...f.mesh!.positions.map(Math.abs))).toBeLessThan(13);
    expect(f.mesh!.positions).toBeInstanceOf(Float32Array);
  });
});

describe('the subject building', () => {
  it('is matched by EGID first, even when a footprint overlapping another building is given', async () => {
    const layer = await layerOf([BOX, L], { subject: { egid: '222', footprint: [rect(-10, -5, 20, 10).map(([x, y]) => ({ x, y }))] } });
    expect(layer.features.filter((f) => f.subject).map((f) => f.id)).toEqual(['building:egid:222']);
    expect(layer.provenance!.subjectMatch).toEqual({ method: 'egid', egid: '222' });
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-subject-matched', severity: 'info' }));
    expect(layer.features).toHaveLength(2);
  });

  it('is matched by footprint overlap without an EGID match, with the overlap and threshold reported', async () => {
    // The model's footprint: 16 × 8 m reaching 1 m past the box's east wall (overlap 15 × 8 of the smaller 128 m²).
    const footprint = [rect(-5, -4, 16, 8).map(([x, y]) => ({ x, y }))];
    const layer = await layerOf([BOX, L], { subject: { egid: '999', footprint } });
    const subject = layer.features.find((f) => f.subject)!;
    expect(subject.id).toBe('building:egid:111');
    expect(subject.provenance.subjectMatch).toEqual({ method: 'footprint', overlap: Math.round((120 / 128) * 1000) / 1000, threshold: SUBJECT_MIN_OVERLAP, otherCandidatesAboveThreshold: 0 });
  });

  it('reports that nothing matched below the threshold, and marks nothing', async () => {
    const footprint = [rect(5, -5, 20, 10).map(([x, y]) => ({ x, y }))]; // 5 m of 20 overlap the box: 25 %
    const layer = await layerOf([BOX], { subject: { footprint } });
    expect(layer.features.some((f) => f.subject)).toBe(false);
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-subject-not-found', message: expect.stringContaining('best 25.0 %') }));
  });

  it('reports an EGID with no building and no footprint to fall back on', async () => {
    const layer = await layerOf([BOX], { subject: { egid: '5' } });
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-subject-not-found', message: expect.stringContaining('EGID 5') }));
  });
});

describe('clipping, caps and honesty', () => {
  it('keeps a building that crosses the site edge whole, and leaves out one wholly outside', async () => {
    const crossing: BoxSpec = { ring: rect(35, -5, 20, 10), base: 500, top: 505 };
    const outside: BoxSpec = { ring: rect(70, -5, 10, 10), base: 500, top: 505 };
    const layer = await layerOf([crossing, outside], { radius: 40 });
    expect(layer.features).toHaveLength(1);
    const xs = triangles(layer.features[0]).map((t) => t.centre[0] - C.x);
    expect(Math.max(...xs)).toBeGreaterThan(40);
    expect(layer.provenance).toMatchObject({ outsideSite: 1, kept: 1, readerFeatures: 2 });
    expect(layer.complete).toBe(true);
  });

  it('caps the building count nearest-first, keeps the subject, and says what it left out', async () => {
    const specs = [0, 1, 2, 3].map((i): BoxSpec => ({ ring: rect(-5 + 20 * i, -5, 10, 10), base: 500, top: 505, attributes: { EGID: 10 + i } }));
    const layer = await layerOf(specs, { subject: { egid: '13' }, buildings: { maxFeatures: 2 } });
    expect(layer.features.map((f) => f.id)).toEqual(['building:egid:13', 'building:egid:10']);
    expect(layer.complete).toBe(false);
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-truncated', count: 2, message: expect.stringContaining('building cap (2)') }));
    expect(layer.provenance).toMatchObject({ truncated: true, kept: 2 });
  });

  it('caps the triangle count too', async () => {
    const specs = [0, 1, 2].map((i): BoxSpec => ({ ring: rect(-5 + 20 * i, -5, 10, 10), base: 500, top: 505 }));
    const layer = await layerOf(specs, { buildings: { maxTriangles: 25 } }); // 12 per box
    expect(layer.features).toHaveLength(2);
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-truncated', count: 1, message: expect.stringContaining('triangle cap (25)') }));
  });

  it('flags a top that disagrees with DACH_MAX: the dataset no longer stores LN02 heights', async () => {
    const ellipsoidal: BoxSpec = { ...BOX, attributes: { ...BOX.attributes, DACH_MAX: 512 - 49.5 } };
    const layer = await layerOf([ellipsoidal]);
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-height-check', severity: 'error', count: 1 }));
    expect(layer.complete).toBe(false);
  });

  it('marks the layer incomplete when the tile read was truncated or partly failed, and keeps what was read', async () => {
    const reader = stubReader([prismFeature(BOX)], {
      truncated: true,
      complete: false,
      truncation: { reason: 'requests', pendingUrls: ['a', 'b'] },
      issues: [{ url: 'https://x/1.b3dm', severity: 'error', message: 'HTTP 503 for https://x/1.b3dm' }],
    });
    const doc = await buildSiteContext({ centre: C, radius: 50, layers: ['buildings'], geodata: stubGeodata(), buildings: { reader } });
    const layer = doc.layers[0];
    expect(layer.features).toHaveLength(1);
    expect(layer.complete).toBe(false);
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-read-truncated', count: 2 }));
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'tiles-http-503', severity: 'error', count: 1 }));
  });

  it('counts buildings without EGID or heights, and keeps them', async () => {
    const bare: BoxSpec = { ring: rect(20, 20, 5, 5), base: 500, top: 503, attributes: { UUID: 'U-1' } };
    const layer = await layerOf([BOX, bare]);
    expect(layer.features).toHaveLength(2);
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-missing-egid', count: 1 }));
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-missing-heights', count: 1 }));
    expect(layer.features[1].id).toBe('building:uuid:U-1');
  });
});

describe('#10480 review: one building split into several objects, caps and the height check', () => {
  // swissBUILDINGS3D splits some buildings: two objects, two UUIDs, one EGID.
  const PART_A: BoxSpec = { ring: rect(-10, -5, 10, 10), base: 500, top: 512, attributes: { EGID: 333, UUID: 'PART-A' } };
  const PART_B: BoxSpec = { ring: rect(0, -5, 10, 10), base: 500, top: 509, attributes: { EGID: 333, UUID: 'PART-B' } };

  it('gives every emitted object its own id, keeping the shared EGID in the attributes', async () => {
    const layer = await layerOf([PART_A, PART_B, L]);
    const ids = layer.features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['building:egid:333:uuid:PART-A', 'building:egid:333:uuid:PART-B', 'building:egid:222']));
    expect(layer.features.filter((f) => (f.attributes[BUILDING_SET] as { EGID: unknown }).EGID === '333')).toHaveLength(2);
  });

  it('marks every object of the subject building, by EGID and by footprint', async () => {
    const byEgid = await layerOf([PART_A, PART_B, L], { subject: { egid: '333' } });
    expect(byEgid.features.filter((f) => f.subject).map((f) => f.id).sort()).toEqual(['building:egid:333:uuid:PART-A', 'building:egid:333:uuid:PART-B']);
    const byFootprint = await layerOf([PART_A, PART_B, L], { subject: { footprint: [rect(-10, -5, 9, 10).map(([x, y]) => ({ x, y }))] } });
    expect(byFootprint.features.filter((f) => f.subject)).toHaveLength(2);
  });

  it('keeps the subject even when it alone exceeds the triangle cap, so a reported match has its building', async () => {
    const layer = await layerOf([BOX, L], { subject: { egid: '111' }, buildings: { maxTriangles: 1 } });
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-subject-matched' }));
    expect(layer.features.filter((f) => f.subject).map((f) => f.id)).toEqual(['building:egid:111']);
  });

  it('runs the height check on the buildings kept, not on those the cap left out', async () => {
    // BOX is near the centre and consistent; the far one has a top 3 m off its DACH_MAX and is capped out.
    const far: BoxSpec = { ring: rect(60, 60, 5, 5), base: 500, top: 505, attributes: { EGID: 444, DACH_MAX: 508 } };
    const layer = await layerOf([BOX, far], { buildings: { maxFeatures: 1 } });
    expect(layer.features.map((f) => f.id)).toEqual(['building:egid:111']);
    expect(layer.issues.map((i) => i.code)).not.toContain('buildings-height-check');
    expect(layer.issues.map((i) => i.code)).toContain('buildings-truncated');
  });
});
