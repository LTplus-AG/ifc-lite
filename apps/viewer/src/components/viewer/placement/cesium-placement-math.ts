/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure number-formatting/angle helpers shared between the georeference
 * gizmo (`CesiumPlacementGizmo.tsx`, the scene-mounted drag handles) and its
 * side-panel controller (`useCesiumPlacementController.ts`, the docked
 * `placement` panel's Georeference tab, #5505). Split out of the former
 * `CesiumPlacementEditor.tsx` monolith so both halves depend on one copy.
 */
import type { MapConversion } from '@ifc-lite/parser';

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Round a value expressed in map units to the nearest millimetre in metres,
 * regardless of what unit the map CRS uses. Keeps the gizmo precision stable
 * when the resolved map unit flips between mm (legacy spec-strict fallback)
 * and m (resolveMapUnitToMetreScale heuristic): a sub-cm drag was previously
 * lost to `round2()`'s 0.01-unit floor as soon as map units became metres,
 * making the vertical handle appear frozen on small movements.
 */
export function roundToMm(value: number, mapUnitScale: number): number {
  const mmInMapUnits = 0.001 / (mapUnitScale > 0 ? mapUnitScale : 1);
  return Math.round(value / mmInMapUnits) * mmInMapUnits;
}

export function formatSigned(value: number, suffix: string): string {
  const rounded = Math.abs(value) < 0.005 ? 0 : round2(value);
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(2)} ${suffix}`;
}

export function normalizeDegrees(value: number): number {
  let normalized = value % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;
  return normalized;
}

export function axisAngleDegrees(conversion: Pick<MapConversion, 'xAxisAbscissa' | 'xAxisOrdinate'>): number {
  return normalizeDegrees(
    Math.atan2(conversion.xAxisOrdinate ?? 0, conversion.xAxisAbscissa ?? 1) * 180 / Math.PI,
  );
}

export function axisFromAngleDegrees(angleDegrees: number): Pick<MapConversion, 'xAxisAbscissa' | 'xAxisOrdinate'> {
  const radians = angleDegrees * Math.PI / 180;
  return {
    xAxisAbscissa: Math.round(Math.cos(radians) * 1_000_000) / 1_000_000,
    xAxisOrdinate: Math.round(Math.sin(radians) * 1_000_000) / 1_000_000,
  };
}
