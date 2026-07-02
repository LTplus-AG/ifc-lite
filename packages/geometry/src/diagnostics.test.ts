/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { mergeGeometryDiagnostics, type GeometryDiagnostics } from './diagnostics.js';

function make(partial: Partial<GeometryDiagnostics> = {}): GeometryDiagnostics {
  return {
    totalCsgFailures: 0,
    productsWithFailures: 0,
    hostsWithOpenings: 0,
    classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
    failuresByReason: [],
    silentNoOps: 0,
    rectFast: {
      fired: 0, openingsCut: 0, deferHostNotBox: 0, deferNotThrough: 0,
      deferOffFace: 0, deferNearEdge: 0, deferNoOpenings: 0,
    },
    worstHosts: [],
    ...partial,
  };
}

describe('mergeGeometryDiagnostics', () => {
  it('passes null operands through', () => {
    expect(mergeGeometryDiagnostics(null, null)).toBeNull();
    const a = make({ totalCsgFailures: 3 });
    expect(mergeGeometryDiagnostics(a, null)).toBe(a);
    expect(mergeGeometryDiagnostics(null, a)).toBe(a);
    expect(mergeGeometryDiagnostics(undefined, undefined)).toBeNull();
  });

  it('sums scalar + classification + rectFast fields', () => {
    const a = make({
      totalCsgFailures: 2, productsWithFailures: 1, hostsWithOpenings: 4, silentNoOps: 1,
      classification: { rectangular: 5, diagonal: 1, nonRectangular: 2, total: 8 },
      rectFast: { fired: 3, openingsCut: 6, deferHostNotBox: 1, deferNotThrough: 0, deferOffFace: 0, deferNearEdge: 2, deferNoOpenings: 0 },
    });
    const b = make({
      totalCsgFailures: 3, productsWithFailures: 2, hostsWithOpenings: 1, silentNoOps: 2,
      classification: { rectangular: 1, diagonal: 0, nonRectangular: 1, total: 2 },
      rectFast: { fired: 1, openingsCut: 1, deferHostNotBox: 0, deferNotThrough: 4, deferOffFace: 1, deferNearEdge: 0, deferNoOpenings: 3 },
    });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.totalCsgFailures).toBe(5);
    expect(m.productsWithFailures).toBe(3);
    expect(m.hostsWithOpenings).toBe(5);
    expect(m.silentNoOps).toBe(3);
    expect(m.classification).toEqual({ rectangular: 6, diagonal: 1, nonRectangular: 3, total: 10 });
    expect(m.rectFast).toEqual({ fired: 4, openingsCut: 7, deferHostNotBox: 1, deferNotThrough: 4, deferOffFace: 1, deferNearEdge: 2, deferNoOpenings: 3 });
  });

  it('merges failuresByReason by reason and re-sorts desc by count', () => {
    const a = make({ failuresByReason: [{ reason: 'DifferenceEmptiedHost', count: 2 }, { reason: 'KernelError', count: 1 }] });
    const b = make({ failuresByReason: [{ reason: 'DifferenceEmptiedHost', count: 3 }, { reason: 'NoBoundsOverlap', count: 5 }] });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.failuresByReason).toEqual([
      { reason: 'DifferenceEmptiedHost', count: 5 },
      { reason: 'NoBoundsOverlap', count: 5 },
      { reason: 'KernelError', count: 1 },
    ]);
  });

  it('folds worstHosts by productId across operands (no duplicate rows, no mutation)', () => {
    const a = make({ worstHosts: [{ productId: 5, ifcType: 'IfcWall', openings: 1, csgFailures: 2, firstFailureLabel: 'KernelError' }] });
    const b = make({ worstHosts: [{ productId: 5, ifcType: 'IfcWall', openings: 2, csgFailures: 3 }] });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.worstHosts).toHaveLength(1);
    expect(m.worstHosts[0]).toMatchObject({ productId: 5, csgFailures: 5, openings: 3, firstFailureLabel: 'KernelError' });
    expect(a.worstHosts[0].csgFailures).toBe(2); // operand a not mutated
  });

  it('concatenates + ranks + caps worstHosts at 16', () => {
    const aHosts = Array.from({ length: 10 }, (_, i) => ({
      productId: i, ifcType: 'IfcWall', openings: 1, csgFailures: i,
    }));
    const bHosts = Array.from({ length: 10 }, (_, i) => ({
      productId: 100 + i, ifcType: 'IfcSlab', openings: 1, csgFailures: 100 + i,
    }));
    const m = mergeGeometryDiagnostics(make({ worstHosts: aHosts }), make({ worstHosts: bHosts }))!;
    expect(m.worstHosts).toHaveLength(16);
    // highest csgFailures first
    expect(m.worstHosts[0].csgFailures).toBe(109);
    // every kept entry outranks every dropped one
    expect(Math.min(...m.worstHosts.map((h) => h.csgFailures))).toBeGreaterThan(3);
  });
});
