/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { GeometryDiagnostics } from '@ifc-lite/geometry';
import { formatGeometryReport, NO_DIAGNOSTICS_LINE } from './geometry-report.js';

function makeDiagnostics(partial: Partial<GeometryDiagnostics> = {}): GeometryDiagnostics {
  return {
    schemaVersion: 1,
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

describe('NO_DIAGNOSTICS_LINE', () => {
  it('is a stable, human-readable sentinel', () => {
    expect(NO_DIAGNOSTICS_LINE).toMatch(/no.*diagnostics/i);
  });
});

describe('formatGeometryReport', () => {
  it('prints aggregate counts and classification breakdown', () => {
    const report = formatGeometryReport(makeDiagnostics({
      totalCsgFailures: 5,
      productsWithFailures: 2,
      hostsWithOpenings: 3,
      classification: { rectangular: 4, diagonal: 1, nonRectangular: 0, total: 5 },
      silentNoOps: 1,
    }));
    expect(report).toContain('CSG failures:        5 across 2 product(s)');
    expect(report).toContain('Hosts with openings: 3');
    expect(report).toContain('Openings classified: 5 (rectangular 4, diagonal 1, non-rectangular 0)');
    expect(report).toContain('Silent rect no-ops:  1');
  });

  it('lists failures by reason, sorted as given', () => {
    const report = formatGeometryReport(makeDiagnostics({
      failuresByReason: [
        { reason: 'DifferenceEmptiedHost', count: 3 },
        { reason: 'KernelError', count: 1 },
      ],
    }));
    expect(report).toContain('Failures by reason:');
    expect(report).toContain('DifferenceEmptiedHost');
    expect(report).toContain('KernelError');
  });

  it('omits the failures-by-reason section when empty', () => {
    const report = formatGeometryReport(makeDiagnostics());
    expect(report).not.toContain('Failures by reason:');
  });

  it('always prints the rect_fast summary line', () => {
    const report = formatGeometryReport(makeDiagnostics({
      rectFast: {
        fired: 10, openingsCut: 8, deferHostNotBox: 1, deferNotThrough: 2,
        deferOffFace: 0, deferNearEdge: 1, deferNoOpenings: 0, deferTooManyOpenings: 3,
      },
    }));
    expect(report).toContain('rect_fast: fired 10, openings cut 8');
    expect(report).toContain('host-not-box 1');
    expect(report).toContain('too-many 3');
  });

  it('lists worst-failing hosts with productId, ifcType, failures, openings', () => {
    const report = formatGeometryReport(makeDiagnostics({
      worstHosts: [
        { productId: 42, ifcType: 'IfcWall', openings: 2, csgFailures: 3, firstFailureLabel: 'KernelError' },
      ],
    }));
    expect(report).toContain('Worst-failing hosts:');
    expect(report).toContain('#42 IfcWall: 3 failure(s), 2 opening(s) [KernelError]');
  });

  it('omits the worst-hosts section when empty', () => {
    const report = formatGeometryReport(makeDiagnostics());
    expect(report).not.toContain('Worst-failing hosts:');
  });

  it('prints bbox and triangle count when present on a worst host', () => {
    const report = formatGeometryReport(makeDiagnostics({
      worstHosts: [
        {
          productId: 7, ifcType: 'IfcSlab', openings: 1, csgFailures: 1,
          bbox: { min: [-1, -2, 0], max: [3, 4, 5] },
          triangleCount: 1280,
        },
      ],
    }));
    expect(report).toContain('bbox=[-1.00, -2.00, 0.00] – [3.00, 4.00, 5.00]');
    expect(report).toContain('triangles=1,280');
  });

  it('does not crash and prints no bbox/triangle line when a host has neither', () => {
    const report = formatGeometryReport(makeDiagnostics({
      worstHosts: [{ productId: 9, ifcType: 'IfcDoor', openings: 1, csgFailures: 1 }],
    }));
    expect(report).toContain('#9 IfcDoor: 1 failure(s), 1 opening(s)');
    expect(report).not.toContain('undefined');
    expect(report).not.toContain('bbox=');
    expect(report).not.toContain('triangles=');
  });

  it('prints only the triangle count when bbox is absent (and vice versa)', () => {
    const triOnly = formatGeometryReport(makeDiagnostics({
      worstHosts: [{ productId: 1, ifcType: 'IfcWall', openings: 1, csgFailures: 1, triangleCount: 42 }],
    }));
    expect(triOnly).toContain('triangles=42');
    expect(triOnly).not.toContain('bbox=');

    const bboxOnly = formatGeometryReport(makeDiagnostics({
      worstHosts: [{
        productId: 2, ifcType: 'IfcWall', openings: 1, csgFailures: 1,
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      }],
    }));
    expect(bboxOnly).toContain('bbox=');
    expect(bboxOnly).not.toContain('triangles=');
  });
});
