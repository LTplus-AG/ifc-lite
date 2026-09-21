/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LandXmlPlanGeometry, LandXmlPlanPoint } from './landXmlSemantics.js';

export function planPolyline(
  geometry: LandXmlPlanGeometry,
  resolved: { start: LandXmlPlanPoint | null; end: LandXmlPlanPoint | null; center: LandXmlPlanPoint | null },
): LandXmlPlanPoint[] | null {
  const { start, end, center } = resolved;
  if (!start || !end) return null;
  if (geometry.kind === 'curve') return tessellateCurve(geometry, { start, end, center });
  return [start, ...(geometry.kind === 'irregular_line' ? geometry.intermediatePoints : []), end];
}

/** Match Rust's bounded curve-topology partition without replacing its analytics. */
function tessellateCurve(
  geometry: LandXmlPlanGeometry,
  resolved: { start: LandXmlPlanPoint; end: LandXmlPlanPoint; center: LandXmlPlanPoint | null },
): LandXmlPlanPoint[] | null {
  const center = resolved.center;
  if (!center || (geometry.rotation !== 'cw' && geometry.rotation !== 'ccw')) return null;
  const radius = geometry.radius ?? Math.hypot(
    resolved.start.northing - center.northing,
    resolved.start.easting - center.easting,
  );
  if (!Number.isFinite(radius) || radius <= 1e-9) return null;
  const endRadius = Math.hypot(resolved.end.northing - center.northing, resolved.end.easting - center.easting);
  if (!Number.isFinite(endRadius) || Math.abs(endRadius - radius) > 1e-9) return null;
  const startAngle = Math.atan2(resolved.start.northing - center.northing, resolved.start.easting - center.easting);
  const endAngle = Math.atan2(resolved.end.northing - center.northing, resolved.end.easting - center.easting);
  const tau = Math.PI * 2;
  const delta = geometry.rotation === 'ccw'
    ? (endAngle - startAngle + tau) % tau
    : -((startAngle - endAngle + tau) % tau);
  if (Math.abs(delta) <= 1e-9) return null;
  if (geometry.declaredLength !== null) {
    // Exporters commonly round authored lengths to millimetres. Preserve that
    // ordinary survey precision while still refusing a real topology mismatch.
    const tolerance = Math.max(1e-3, 1e-6 * Math.max(radius, geometry.declaredLength, 1));
    if (Math.abs(radius * Math.abs(delta) - geometry.declaredLength) > tolerance) return null;
  }
  const count = Math.min(64, Math.max(1, Math.ceil(Math.abs(delta) / tau * 64)));
  const points = [resolved.start];
  for (let index = 1; index < count; index++) {
    const fraction = index / count;
    points.push({
      northing: center.northing + radius * Math.sin(startAngle + delta * fraction),
      easting: center.easting + radius * Math.cos(startAngle + delta * fraction),
      elevation: resolved.start.elevation !== null && resolved.end.elevation !== null
        ? resolved.start.elevation + (resolved.end.elevation - resolved.start.elevation) * fraction
        : null,
    });
  }
  points.push(resolved.end);
  return points;
}
