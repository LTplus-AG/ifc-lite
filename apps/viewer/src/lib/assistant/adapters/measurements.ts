/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Finished 3D Measure tool readings (#6833): distances, polylines, angles and
 * radius fits from `measurementSlice`, each in its own kind. The angle and
 * radius values are derived by the same pure functions the Measurements
 * panel renders with, so the evidence and the list cannot disagree. Values
 * of different kinds (and units) are never summed together.
 */

import type { ViewerState } from '@/store';
import { distanceComponents } from '@/components/viewer/tools/measure-modes/components';
import { angleMeasurementOutcome } from '@/components/viewer/tools/measure-modes/readouts';
import { fitRadius } from '@/components/viewer/tools/measure-modes/radius';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const LIMITATIONS = 'Measurements are workspace points picked in the viewer (Y-up renderer frame, metres) without a model or element anchor, so modelId/globalId are unknown. '
  + 'Values of different kinds and units are never summed. A stale row was picked before a model was moved; its value describes the old placement. '
  + 'In-progress gestures are excluded. Radius values are circle fits through user picks, not authored profile radii.';

function populationOf(s: ViewerState): number {
  return s.measurements.length + s.polylineMeasurements.length + s.angleMeasurements.length + s.radiusMeasurements.length;
}

function* measurementRows(s: ViewerState) {
  const stale = s.placementStaleMeasurements;
  for (const m of s.measurements) {
    const c = distanceComponents(m.start, m.end);
    yield evidenceRow({ kind: 'distance', modelId: null, unit: 'm', status: stale.has(m.id) ? 'stale' : 'current' },
      { id: m.id, value: m.distance, horizontal: c.horizontal, vertical: c.vertical, stale: stale.has(m.id) });
  }
  for (const p of s.polylineMeasurements) {
    yield evidenceRow({ kind: 'polyline', modelId: null, unit: 'm', status: stale.has(p.id) ? 'stale' : 'current' },
      { id: p.id, value: p.length, closed: p.closed, basis: p.closed ? 'closed perimeter' : 'open length',
        pointCount: p.points.length, stale: stale.has(p.id) });
  }
  for (const a of s.angleMeasurements) {
    const measured = angleMeasurementOutcome(a);
    const { outcome } = measured;
    const measuredValue = outcome.kind === 'degenerate' ? null : outcome.degrees;
    yield evidenceRow({ kind: 'angle', modelId: null, unit: 'deg', status: stale.has(a.id) ? 'stale' : 'current' },
      { id: a.id, angleKind: a.kind, value: measuredValue, outcome: outcome.kind,
        ...(outcome.kind === 'degenerate' && 'reason' in outcome ? { reason: outcome.reason } : {}),
        range: measured.family === 'apex' ? '0-180 (unsigned, at the picked apex)' : '0-90 (undirected lines/planes)',
        stale: stale.has(a.id) });
  }
  for (const r of s.radiusMeasurements) {
    const fit = fitRadius(r.points);
    const fitted = fit.kind === 'fitted';
    yield evidenceRow({ kind: 'radius', modelId: null, unit: 'm', status: stale.has(r.id) ? 'stale' : 'current' },
      { id: r.id, value: fitted ? fit.radiusM : null, diameter: fitted ? fit.diameterM : null, outcome: fit.kind,
        ...(fit.kind === 'refused' ? { reason: fit.reason } : {}),
        ...(fit.kind === 'insufficient-points' ? {} : { sagittaM: fit.sagittaM, residualM: fit.residualM ?? null }),
        pointCount: r.points.length, stale: stale.has(r.id) });
  }
}

function staleCount(items: readonly { id: string }[], stale: ReadonlySet<string>): number {
  let count = 0;
  for (const item of items) if (stale.has(item.id)) count++;
  return count;
}

export const measurementsAdapter: EvidenceAdapter = {
  id: 'measurements', group: 'quantities', panelIds: ['measurements'],
  titleKey: 'measure.panel.title', descriptionKey: 'assistantSources.measurements.description',
  rowMeaningKey: 'assistantSources.measurements.rows', unavailableKey: 'assistantSources.measurements.unavailable',
  suggestionKeys: ['assistantSources.measurements.suggestExplain', 'assistantSources.measurements.suggestStale'],
  readiness: s => {
    const count = populationOf(s);
    return count > 0
      ? { status: { labelKey: 'assistantSources.measurements.ready', params: { count } }, ready: true }
      : { status: { labelKey: 'assistantSources.measurements.none' }, ready: false };
  },
  identity: s => [s.measurements, s.polylineMeasurements, s.angleMeasurements, s.radiusMeasurements, s.placementStaleMeasurements],
  capture: (s, limit) => {
    const total = populationOf(s);
    if (total === 0) return unavailableCapture({ kind: 'measurements', measurementCount: 0 });
    const stale = s.placementStaleMeasurements;
    let currentDistanceTotal = 0;
    for (const m of s.measurements) if (!stale.has(m.id)) currentDistanceTotal += m.distance;
    const rows: unknown[] = [];
    for (const row of measurementRows(s)) {
      if (rows.length >= limit) break;
      rows.push(row);
    }
    return {
      summary: {
        kind: 'measurements', measurementCount: total,
        byKind: {
          distance: { count: s.measurements.length, stale: staleCount(s.measurements, stale), unit: 'm',
            // The panel's own "Total (current)": drag distances only, stale ones excluded.
            currentTotal: s.measurements.length > 0 ? currentDistanceTotal : null },
          polyline: { count: s.polylineMeasurements.length, stale: staleCount(s.polylineMeasurements, stale), unit: 'm' },
          angle: { count: s.angleMeasurements.length, stale: staleCount(s.angleMeasurements, stale), unit: 'deg' },
          radius: { count: s.radiusMeasurements.length, stale: staleCount(s.radiusMeasurements, stale), unit: 'm' },
        },
        inProgressExcluded: Boolean(s.activeMeasurement || s.activePolyline || s.activeAngle || s.activeRadius),
        limitations: LIMITATIONS,
      },
      rows, totalRows: total, availability: 'available',
    };
  },
};
