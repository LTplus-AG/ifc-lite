/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  applySpatialPlacement,
  localViewerToProjected,
  projectedToLocalViewer,
  resolveSpatialPlacement,
  type ModelSpatialReference,
} from './spatial-reference.js';

function reference(overrides: Partial<ModelSpatialReference> = {}): ModelSpatialReference {
  return {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: 'EPSG:2056' },
    vertical: { id: 'EPSG:5729' },
    localToProjected: {
      kind: 'local-projected-affine', eastings: 2_600_000, northings: 1_200_000,
      orthogonalHeight: 450, xAxisAbscissa: 2, xAxisOrdinate: 2,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    confidence: 'declared',
    ...overrides,
  };
}

describe('format-neutral spatial placement (#5048)', () => {
  it('round-trips source viewer coordinates through projected coordinates in f64', () => {
    const source = reference();
    const projected = localViewerToProjected(source, [12.5, 8, -4.25], { x: 100, y: 20, z: -10 });
    expect(projected).not.toBeNull();
    const restored = projectedToLocalViewer(source, projected!, { x: 100, y: 20, z: -10 });
    expect(restored).not.toBeNull();
    expect(restored?.[0]).toBeCloseTo(12.5, 9);
    expect(restored?.[1]).toBeCloseTo(8, 9);
    expect(restored?.[2]).toBeCloseTo(-4.25, 9);
  });

  it('derives a placement from immutable source/reference metadata rather than prior vertices', () => {
    const source = reference({ localToProjected: { ...reference().localToProjected!, eastings: 2_600_100 } });
    const target = reference();
    const resolved = resolveSpatialPlacement(source, target);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(applySpatialPlacement(resolved.placement.sourceToFederation, 0, 0, 0)[0]).toBeCloseTo(70.710678, 6);
    expect(source.localToProjected?.eastings).toBe(2_600_100);
  });

  it('fails closed for missing or mismatched horizontal/vertical CRS', () => {
    expect(resolveSpatialPlacement(reference({ horizontal: undefined }), reference())).toMatchObject({ ok: false, refusal: 'missing-horizontal-crs' });
    expect(resolveSpatialPlacement(reference({ horizontal: { id: 'EPSG:4326' } }), reference())).toMatchObject({ ok: false, refusal: 'crs-mismatch' });
    expect(resolveSpatialPlacement(reference({ vertical: { id: 'EPSG:5703' } }), reference())).toMatchObject({ ok: false, refusal: 'vertical-crs-mismatch' });
    expect(resolveSpatialPlacement(reference({ vertical: undefined }), reference())).toMatchObject({ ok: false, refusal: 'vertical-crs-unknown' });
    expect(resolveSpatialPlacement(reference({ vertical: undefined }), reference(), { unknownVertical: 'assume-compatible' }).ok).toBe(true);
  });

  it('rejects degenerate source operations rather than inventing an axis', () => {
    expect(resolveSpatialPlacement(reference({ localToProjected: { ...reference().localToProjected!, xAxisAbscissa: 0, xAxisOrdinate: 0 } }), reference()))
      .toMatchObject({ ok: false, refusal: 'invalid-axis-or-unit' });
  });
});
