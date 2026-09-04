/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  mergeGeometryDiagnostics,
  buildGeometryWorkerCompleteMessage,
  type GeometryDiagnostics,
} from './diagnostics.js';

function make(partial: Partial<GeometryDiagnostics> = {}): GeometryDiagnostics {
  return {
    // `schemaVersion` is required on the interface. A hand-built fixture
    // carries no producer version, and 0 is exactly what the field documents
    // for that ("`0`/absent means a pre-versioned producer") — which is also
    // what `mergeGeometryDiagnostics`' `?? 0` already resolved these fixtures
    // to before the field was spelled out here.
    schemaVersion: 0,
    totalCsgFailures: 0,
    productsWithFailures: 0,
    hostsWithOpenings: 0,
    classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
    failuresByReason: [],
    silentNoOps: 0,
    rectFast: {
      fired: 0, openingsCut: 0, deferHostNotBox: 0, deferNotThrough: 0,
      deferOffFace: 0, deferNearEdge: 0, deferNoOpenings: 0, deferTooManyOpenings: 0,
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
      rectFast: { fired: 3, openingsCut: 6, deferHostNotBox: 1, deferNotThrough: 0, deferOffFace: 0, deferNearEdge: 2, deferNoOpenings: 0, deferTooManyOpenings: 2 },
    });
    const b = make({
      totalCsgFailures: 3, productsWithFailures: 2, hostsWithOpenings: 1, silentNoOps: 2,
      classification: { rectangular: 1, diagonal: 0, nonRectangular: 1, total: 2 },
      rectFast: { fired: 1, openingsCut: 1, deferHostNotBox: 0, deferNotThrough: 4, deferOffFace: 1, deferNearEdge: 0, deferNoOpenings: 3, deferTooManyOpenings: 5 },
    });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.totalCsgFailures).toBe(5);
    expect(m.productsWithFailures).toBe(3);
    expect(m.hostsWithOpenings).toBe(5);
    expect(m.silentNoOps).toBe(3);
    expect(m.classification).toEqual({ rectangular: 6, diagonal: 1, nonRectangular: 3, total: 10 });
    expect(m.rectFast).toEqual({ fired: 4, openingsCut: 7, deferHostNotBox: 1, deferNotThrough: 4, deferOffFace: 1, deferNearEdge: 2, deferNoOpenings: 3, deferTooManyOpenings: 7 });
  });

  it('sums oversizedRefDrops, treating an absent counter as 0 (pre-#3752 payloads)', () => {
    // The Rust producer always serializes `oversizedRefDrops`, but a payload
    // from a build predating #3752 has no such key. Absent must fold as 0
    // rather than turning the merged value into NaN or dropping the field.
    expect(mergeGeometryDiagnostics(make({ oversizedRefDrops: 2 }), make({ oversizedRefDrops: 3 }))!
      .oversizedRefDrops).toBe(5);
    expect(mergeGeometryDiagnostics(make({ oversizedRefDrops: 4 }), make())!
      .oversizedRefDrops).toBe(4);
    expect(mergeGeometryDiagnostics(make(), make())!.oversizedRefDrops).toBe(0);
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

  it('sums totalUnsupportedItems and merges unsupportedItemsByType by IfcType, re-sorted desc', () => {
    const a = make({
      totalUnsupportedItems: 2,
      unsupportedItemsByType: [{ reason: 'IfcGeometricSet', count: 2 }],
    });
    const b = make({
      totalUnsupportedItems: 4,
      unsupportedItemsByType: [
        { reason: 'IfcGeometricSet', count: 1 },
        { reason: 'IfcAnnotationFillArea', count: 3 },
      ],
    });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.totalUnsupportedItems).toBe(6);
    expect(m.unsupportedItemsByType).toEqual([
      { reason: 'IfcAnnotationFillArea', count: 3 },
      { reason: 'IfcGeometricSet', count: 3 },
    ]);
  });

  it('treats totalUnsupportedItems/unsupportedItemsByType as absent-safe (pre-schemaVersion-3 payloads)', () => {
    const a = make();
    const b = make({ totalUnsupportedItems: 1, unsupportedItemsByType: [{ reason: 'IfcGeometricSet', count: 1 }] });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.totalUnsupportedItems).toBe(1);
    expect(m.unsupportedItemsByType).toEqual([{ reason: 'IfcGeometricSet', count: 1 }]);
  });

  it('folds worstHosts by productId across operands (no duplicate rows, no mutation)', () => {
    const a = make({ worstHosts: [{ productId: 5, ifcType: 'IfcWall', openings: 1, csgFailures: 2, firstFailureLabel: 'KernelError' }] });
    const b = make({ worstHosts: [{ productId: 5, ifcType: 'IfcWall', openings: 2, csgFailures: 3 }] });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.worstHosts).toHaveLength(1);
    expect(m.worstHosts[0]).toMatchObject({ productId: 5, csgFailures: 5, openings: 3, firstFailureLabel: 'KernelError' });
    expect(a.worstHosts[0].csgFailures).toBe(2); // operand a not mutated
  });

  it('keeps the first-captured bbox/triangleCount when folding worstHosts (not summed)', () => {
    const a = make({
      worstHosts: [{
        productId: 5, ifcType: 'IfcWall', openings: 1, csgFailures: 2,
        bbox: { min: [0, 0, 0], max: [1, 2, 3] }, triangleCount: 120,
      }],
    });
    const b = make({
      worstHosts: [{
        productId: 5, ifcType: 'IfcWall', openings: 2, csgFailures: 3,
        bbox: { min: [9, 9, 9], max: [10, 10, 10] }, triangleCount: 999,
      }],
    });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.worstHosts[0].bbox).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
    expect(m.worstHosts[0].triangleCount).toBe(120);
  });

  it('leaves bbox/triangleCount undefined when neither operand captured them', () => {
    const a = make({ worstHosts: [{ productId: 5, ifcType: 'IfcWall', openings: 1, csgFailures: 2 }] });
    const b = make({ worstHosts: [{ productId: 5, ifcType: 'IfcWall', openings: 1, csgFailures: 1 }] });
    const m = mergeGeometryDiagnostics(a, b)!;
    expect(m.worstHosts[0].bbox).toBeUndefined();
    expect(m.worstHosts[0].triangleCount).toBeUndefined();
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

describe('the streaming `complete` event payload (buildGeometryWorkerCompleteMessage, used by geometry.worker.ts emitSessionEnd)', () => {
  // The worker builds its `complete` event via `buildGeometryWorkerCompleteMessage`
  // (extracted from geometry.worker.ts's emitSessionEnd so it can be exercised
  // directly here — the worker module itself assigns `self.onmessage` at import
  // time and cannot be loaded outside a Worker/browser-like global). It spreads
  // diagnostics conditionally so a clean load (no CSG issues) omits the field
  // entirely rather than sending an all-zero object — callers must gate on
  // presence (`if (event.diagnostics)`), not just truthy counts. These tests
  // call the real production function and pin the full field shape (including
  // the per-product bbox/triangleCount detail).
  function buildCompleteEvent(diagnostics: GeometryDiagnostics | null) {
    return buildGeometryWorkerCompleteMessage(10, diagnostics);
  }

  it('omits `diagnostics` entirely on a clean load', () => {
    const event = buildCompleteEvent(null);
    expect(event).not.toHaveProperty('diagnostics');
  });

  it('attaches the full GeometryDiagnostics contract, including per-product bbox/triangleCount, when populated', () => {
    const diagnostics = make({
      totalCsgFailures: 1,
      productsWithFailures: 1,
      hostsWithOpenings: 1,
      classification: { rectangular: 1, diagonal: 0, nonRectangular: 0, total: 1 },
      worstHosts: [{
        productId: 42,
        ifcType: 'IfcWall',
        openings: 1,
        csgFailures: 1,
        firstFailureLabel: 'KernelError',
        bbox: { min: [0, 0, 0], max: [2, 3, 4] },
        triangleCount: 256,
      }],
    });

    const event = buildCompleteEvent(diagnostics);
    expect(event).toHaveProperty('diagnostics');
    const wh = event.diagnostics!.worstHosts[0];
    expect(wh).toMatchObject({
      productId: 42,
      ifcType: 'IfcWall',
      openings: 1,
      csgFailures: 1,
      firstFailureLabel: 'KernelError',
    });
    expect(wh.bbox).toEqual({ min: [0, 0, 0], max: [2, 3, 4] });
    expect(wh.triangleCount).toBe(256);
    expect(typeof wh.productId).toBe('number');
    expect(typeof wh.ifcType).toBe('string');
  });

  it('does NOT fabricate a counted zero when merging two pre-v3 payloads', () => {
    // Both operands predate the drop counter, so neither field is present and the
    // merged schemaVersion stays 2. Writing `totalUnsupportedItems: 0` here would
    // say "we counted, nothing was dropped" on a payload that never counted —
    // absence has to stay distinguishable from a real zero, which is the whole
    // reason v3 was a version bump rather than a silent additive field.
    const merged = mergeGeometryDiagnostics(
      make({ schemaVersion: 2, totalCsgFailures: 1 }),
      make({ schemaVersion: 2, totalCsgFailures: 2 }),
    )!;
    expect(merged.schemaVersion).toBe(2);
    expect('totalUnsupportedItems' in merged).toBe(false);
    expect('unsupportedItemsByType' in merged).toBe(false);
  });

  it('keeps a real zero from a v3 producer that counted and found nothing', () => {
    // The mirror case: a v3 operand DID count. Its 0 is a measurement and must
    // survive, so the field is present and the merge stays additive.
    const merged = mergeGeometryDiagnostics(
      make({ schemaVersion: 3, totalUnsupportedItems: 0, unsupportedItemsByType: [] }),
      make({ schemaVersion: 2 }),
    )!;
    expect(merged.schemaVersion).toBe(3);
    expect(merged.totalUnsupportedItems).toBe(0);
    expect(merged.unsupportedItemsByType).toEqual([]);
  });

  it('leaves bbox/triangleCount absent on a worstHosts entry that never captured a cut effect', () => {
    const diagnostics = make({
      worstHosts: [{ productId: 7, ifcType: 'IfcSlab', openings: 1, csgFailures: 1 }],
    });
    const event = buildCompleteEvent(diagnostics);
    const wh = event.diagnostics!.worstHosts[0];
    expect(wh.bbox).toBeUndefined();
    expect(wh.triangleCount).toBeUndefined();
  });
});
