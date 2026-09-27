/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Finished angle and fitted-radius picks, shared by the tool and scene layer. */
import type { AngleMeasurement, RadiusMeasurement } from '@/store/types';
import { overlayColor } from '@/lib/viewport-ui/overlay-theme';
import { OVERLAY_GLOW_FILTER, WorldLabel } from '../../viewport-ui/scene';
import { formatAngleMeasurement, formatRadiusPoints } from './measure-modes/readouts';

const INK = overlayColor('overlay-ink');
const HALO = overlayColor('overlay-halo');
const LABEL_OFFSET = { dx: 0, dy: -6 };

type Point = { x: number; y: number; z: number; screenX: number; screenY: number };

function centroid(points: readonly Point[]) {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    z: points.reduce((sum, p) => sum + p.z, 0) / points.length,
  };
}

function PickVisual({ points, label, breakAfter = -1 }: { points: Point[]; label: string; breakAfter?: number }) {
  if (points.length === 0) return null;
  const path = points.map((p, i) => `${i === 0 || i === breakAfter + 1 ? 'M' : 'L'} ${p.screenX} ${p.screenY}`).join(' ');
  return (
    <div className="pointer-events-none">
      <svg className="absolute inset-0 pointer-events-none" style={{ overflow: 'visible', pointerEvents: 'none' }}>
        {points.length > 1 && <path d={path} fill="none" stroke={INK} strokeWidth="2" strokeDasharray="6,3" filter={OVERLAY_GLOW_FILTER} />}
        {points.map((p, i) => <circle key={i} cx={p.screenX} cy={p.screenY} r="4" fill={HALO} stroke={INK} strokeWidth="2" />)}
      </svg>
      <WorldLabel worldPoint={centroid(points)} offset={LABEL_OFFSET} className="-translate-x-1/2 -translate-y-full leading-tight">
        <div className="font-medium">{label}</div>
      </WorldLabel>
    </div>
  );
}

export function AngleRadiusVisuals({ angles, radii, unitDisplayOverrides }: {
  angles: AngleMeasurement[];
  radii: RadiusMeasurement[];
  unitDisplayOverrides: Record<string, string>;
}) {
  return (
    <>
      {angles.map((angle) => {
        // Point angles have their vertex at pick 2. Edge angles contain two
        // separate picked segments; avoid drawing a fictitious connecting edge.
        const points = angle.kind === 'points'
          ? [angle.picks[0].point, angle.picks[1].point, angle.picks[2].point]
          : angle.picks.map((pick) => pick.point);
        return <PickVisual key={angle.id} points={points} label={formatAngleMeasurement(angle)} breakAfter={angle.kind === 'edges' ? 1 : -1} />;
      })}
      {radii.map((radius) => <PickVisual key={radius.id} points={radius.points} label={formatRadiusPoints(radius.points, unitDisplayOverrides)} />)}
    </>
  );
}
