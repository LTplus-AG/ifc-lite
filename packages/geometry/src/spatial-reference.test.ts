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
    expect(resolveSpatialPlacement(reference(), reference({ vertical: undefined }))).toMatchObject({ ok: false, refusal: 'vertical-crs-unknown' });
    expect(resolveSpatialPlacement(reference({ vertical: undefined }), reference({ vertical: undefined }))).toMatchObject({ ok: false, refusal: 'vertical-crs-unknown' });
  });

  it('converts declared source units and axis order without changing the map operation', () => {
    const source = reference({
      source: { axes: ['north', 'east', 'down'], horizontalUnitToMetres: 0.3048, verticalUnitToMetres: 0.3048 },
      localToProjected: { ...reference().localToProjected!, xAxisAbscissa: 1, xAxisOrdinate: 0 },
    });
    // Native point is North/East/Down feet. The map operation receives the
    // renderer's East/Up/South metre frame: 20, -10, -30 respectively.
    expect(localViewerToProjected(source, [30 / 0.3048, 20 / 0.3048, 10 / 0.3048]))
      .toEqual([2_600_020, 1_200_030, 440]);
    expect(projectedToLocalViewer(source, [2_600_020, 1_200_030, 440]))
      .toEqual([30 / 0.3048, 20 / 0.3048, 10 / 0.3048]);
  });

  it('round-trips native non-metre axes with a nonzero native frame offset (#5048)', () => {
    const source = reference({
      source: { axes: ['north', 'east', 'down'], horizontalUnitToMetres: 0.3048, verticalUnitToMetres: 0.3048 },
      localToProjected: { ...reference().localToProjected!, xAxisAbscissa: 1, xAxisOrdinate: 0 },
    });
    // Both the input point and the offset are North/East/Down FEET. This is
    // deliberately unlike IFC's East/Up/South metre adapter, where applying
    // a viewer-axis conversion to the offset is accidentally invisible.
    const nativePoint: [number, number, number] = [750, 1_200, -80];
    const nativeOffset = { x: 500, y: 900, z: -30 };
    const projected = localViewerToProjected(source, nativePoint, nativeOffset);
    expect(projected).not.toBeNull();
    const restored = projectedToLocalViewer(source, projected!, nativeOffset);
    expect(restored?.[0]).toBeCloseTo(nativePoint[0], 9);
    expect(restored?.[1]).toBeCloseTo(nativePoint[1], 9);
    expect(restored?.[2]).toBeCloseTo(nativePoint[2], 9);
  });

  it('rejects malformed units and incomplete source axes rather than guessing', () => {
    expect(resolveSpatialPlacement(reference({ localToProjected: { ...reference().localToProjected!, xAxisAbscissa: 0, xAxisOrdinate: 0 } }), reference()))
      .toMatchObject({ ok: false, refusal: 'invalid-axis-or-unit' });
    for (const source of [
      { ...reference().source, horizontalUnitToMetres: 0 },
      { ...reference().source, verticalUnitToMetres: -0.3048 },
      { ...reference().source, axes: ['east', 'west', 'up'] as const },
    ]) {
      const invalid = reference({ source });
      expect(resolveSpatialPlacement(invalid, reference())).toMatchObject({ ok: false, refusal: 'invalid-axis-or-unit' });
      expect(localViewerToProjected(invalid, [1, 2, 3])).toBeNull();
    }
  });

  it('derives placement in native source coordinates across units, axes, and vertical scale', () => {
    const source = reference({
      source: { axes: ['north', 'east', 'down'], horizontalUnitToMetres: 0.3048, verticalUnitToMetres: 0.3048 },
      localToProjected: {
        ...reference().localToProjected!, eastings: 2_600_120, northings: 1_200_050,
        orthogonalHeight: 600, xAxisAbscissa: 0, xAxisOrdinate: 4,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    });
    const target = reference({
      localToProjected: {
        ...reference().localToProjected!, eastings: 2_600_000, northings: 1_200_000,
        orthogonalHeight: 450, xAxisAbscissa: 3, xAxisOrdinate: 0,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    });
    // Frame offsets carry the same native coordinate order/units as their
    // reference. This models an RTC shift before its source adapter turns the
    // data into renderer metres.
    const sourceFrameOffset = { x: 100, y: -50, z: 25 };
    const targetFrameOffset = { x: -10, y: 20, z: -5 };
    const resolved = resolveSpatialPlacement(source, target, { sourceFrameOffset, targetFrameOffset });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const point: [number, number, number] = [2000, 30, -500];
    const projected = localViewerToProjected(source, point, sourceFrameOffset);
    expect(projected).not.toBeNull();
    const expected = projectedToLocalViewer(target, projected!, targetFrameOffset);
    const actual = applySpatialPlacement(resolved.placement.sourceToFederation, ...point);
    expect(actual[0]).toBeCloseTo(expected![0], 9);
    expect(actual[1]).toBeCloseTo(expected![1], 9);
    expect(actual[2]).toBeCloseTo(expected![2], 9);
  });
});
