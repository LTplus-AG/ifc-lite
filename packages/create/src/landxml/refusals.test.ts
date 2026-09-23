/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for `collectRefusals`, `isMappableSurface` and `refusalReason`
 * (`docs/architecture/landxml-to-ifc-mapping.md` §5, §6).
 */

import { describe, it, expect } from 'vitest';
import { collectRefusals, isMappableSurface, refusalReason } from './refusals.js';
import type { LandXmlIfcPoint, LandXmlIfcSource, LandXmlIfcSurface } from './source-types.js';
import type { LandXmlRefusal } from './result-types.js';

const A_POINT: LandXmlIfcPoint = {
  sourceId: 'landxml:surface:1:point:1', id: 'p1', northing: 0, easting: 0, elevation: 0,
};
const A_FACE: [string, string, string] = ['p1', 'p1', 'p1'];

function renderedSurface(overrides: Partial<LandXmlIfcSurface> = {}): LandXmlIfcSurface {
  return {
    sourceId: 'landxml:surface:1',
    name: 'Existing Ground',
    kind: 'existing ground',
    renderState: 'rendered',
    points: [A_POINT],
    faces: [A_FACE],
    ...overrides,
  };
}

function minimalSource(overrides: Partial<LandXmlIfcSource> = {}): LandXmlIfcSource {
  return {
    schema: 'LandXML',
    version: '1.2',
    units: {
      linearUnit: 'metre', elevationUnit: 'metre', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
    },
    surfaces: [],
    ...overrides,
  };
}

describe('collectRefusals', () => {
  // A family the source carries zero records of must be absent from the
  // result entirely — never present as `{ count: 0 }`. §5's rationale: "0
  // parcels were not exported" is noise, not something an operator can act on.
  it('omits every family the source carries zero records of, for none of the twelve refused families', () => {
    const source = minimalSource({
      surfaces: [renderedSurface()], // one mappable surface: not a non-rendered-surfaces refusal
      // Every other family left undefined/empty on purpose.
    });
    const refusals = collectRefusals(source);

    expect(refusals).toHaveLength(0);
    expect(refusals.every((r) => r.count > 0)).toBe(true);
  });

  it('reports the count for each family the source actually carries, including per-surface boundaries/breaklines/contours summed across surfaces', () => {
    const surfaceA = renderedSurface({
      sourceId: 'landxml:surface:1',
      boundaries: [{}, {}],
      breaklines: [{}],
      contours: [],
    });
    const surfaceB = renderedSurface({
      sourceId: 'landxml:surface:2',
      boundaries: [{}, {}, {}],
      breaklines: [],
      contours: [{}, {}, {}, {}],
    });
    const source = minimalSource({
      surfaces: [surfaceA, surfaceB],
      profiles: [{}],
      // alignments, roadways, parcels, monuments, plan-features, pipe-networks
      // are all left absent, to prove the omission rule and the counting rule
      // operate side by side in one source.
    });
    const refusals = collectRefusals(source);

    // boundaries: 2 (A) + 3 (B) = 5; breaklines: 1 (A) + 0 (B) = 1;
    // contours: 0 (A) + 4 (B) = 4 — summed ACROSS surfaces, not per-surface.
    expect(refusals).toContainEqual(expect.objectContaining({ family: 'surface-boundaries', count: 5 }));
    expect(refusals).toContainEqual(expect.objectContaining({ family: 'surface-breaklines', count: 1 }));
    expect(refusals).toContainEqual(expect.objectContaining({ family: 'surface-contours', count: 4 }));
    expect(refusals).toContainEqual(expect.objectContaining({ family: 'profiles', count: 1 }));

    // Families absent from the source must not appear at all.
    expect(refusals.some((r) => r.family === 'alignments')).toBe(false);
    expect(refusals.some((r) => r.family === 'roadways')).toBe(false);
    expect(refusals.some((r) => r.family === 'non-rendered-surfaces')).toBe(false);
    expect(refusals.every((r) => r.count > 0)).toBe(true);
  });

  // §5 lists cross sections as one family in the export UI even though the
  // source carries them as two separate LandXML record kinds.
  it('sums crossSections and crossSectionSurfaces into one cross-sections family', () => {
    const source = minimalSource({
      surfaces: [renderedSurface()],
      crossSections: [{}, {}],
      crossSectionSurfaces: [{}],
    });
    const refusals = collectRefusals(source);

    expect(refusals).toContainEqual(expect.objectContaining({ family: 'cross-sections', count: 3 }));
  });
});

describe('isMappableSurface', () => {
  it('is true only for a rendered surface with at least one point and one face', () => {
    expect(isMappableSurface(renderedSurface())).toBe(true);
  });

  // Three independent ways a surface can fail to be mappable — each asserted
  // on its own so a regression in any one condition is pinned to its own case.
  it('is false when renderState is not "rendered"', () => {
    const surface = renderedSurface({ renderState: 'preserved_only' });
    expect(isMappableSurface(surface)).toBe(false);
  });

  it('is false when the surface has no points', () => {
    const surface = renderedSurface({ points: [] });
    expect(isMappableSurface(surface)).toBe(false);
  });

  it('is false when the surface has no faces', () => {
    const surface = renderedSurface({ faces: [] });
    expect(isMappableSurface(surface)).toBe(false);
  });
});

describe('refusalReason', () => {
  it('names the families and counts when refusals exist', () => {
    const refusals: LandXmlRefusal[] = [
      { family: 'alignments', count: 3, message: 'placeholder' },
      { family: 'parcels', count: 2, message: 'placeholder' },
    ];
    const reason = refusalReason(refusals);

    expect(reason).toContain('3 alignments');
    expect(reason).toContain('2 parcels');
    expect(reason).toContain('none of which has a v1 mapping');
  });

  // A distinct sentence from the "refusals exist" case — an operator seeing
  // this must be told the file is genuinely empty of in-scope AND
  // out-of-scope records, not just that nothing was exported.
  it('gives a distinct sentence naming neither family nor count when there are no refusals', () => {
    const reason = refusalReason([]);

    expect(reason).toBe(
      'This LandXML file carries no triangulated surface and no CgPoints, so there is nothing the IFC mapping can write.',
    );
    expect(reason).not.toContain('none of which has a v1 mapping');
  });
});
