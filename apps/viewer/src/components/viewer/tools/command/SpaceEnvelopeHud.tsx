/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { useProjectorTick } from '@/components/viewport-ui/scene';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { envelopeHandlePoints, setEnvelopeMode, type EnvelopeMode, type SpaceEnvelopeGesture } from '@/lib/commands/modeling/commands/space-envelope';

export function SpaceEnvelopeBar({ gesture }: CommandHudProps<SpaceEnvelopeGesture>) {
  const { t } = useTranslation();
  return <><HudDivider /><HudSegmented
    aria-label={t('spaceEnvelope.mode')}
    options={(['flat', 'slope', 'pitched'] as const).map(value => ({ value, label: t(`spaceEnvelope.${value}`) }))}
    value={gesture.mode}
    onChange={(mode: EnvelopeMode) => updateCommandGesture(g => setEnvelopeMode(g as SpaceEnvelopeGesture, mode))}
  /></>;
}

/** The envelope's actual heights in the elevation. Pointer events reach the
 * viewport router, so handles and roof targets use the same snap solver. */
export function SpaceEnvelopeScene({ gesture, ctx }: CommandHudProps<SpaceEnvelopeGesture>) {
  const { t } = useTranslation();
  const project = useViewerStore(s => s.cameraCallbacks.projectToScreen);
  void useProjectorTick(true);
  if (!ctx.workplane || !project || !gesture.target) return null;
  const points = envelopeHandlePoints(gesture).map(([u, z]) => {
    const p = ctx.workplane!.localToRender([u, z, 0]);
    return project({ x: p[0], y: p[1], z: p[2] });
  });
  if (points.some(p => !p)) return null;
  const roof = points.slice(1).map(p => p!);
  const floorAt = (u: number) => {
    const p = ctx.workplane!.localToRender([u, gesture.floor, 0]);
    return project({ x: p[0], y: p[1], z: p[2] });
  };
  const leftFloor = floorAt(gesture.points[0][0]), rightFloor = floorAt(gesture.points[gesture.points.length - 1][0]);
  if (!leftFloor || !rightFloor) return null;
  const path = `M ${leftFloor.x} ${leftFloor.y} L ${roof.map(p => `${p.x} ${p.y}`).join(' L ')} L ${rightFloor.x} ${rightFloor.y} Z`;
  return <svg aria-label={t('spaceEnvelope.label')} className="absolute inset-0 pointer-events-none" style={{ overflow: 'visible' }}>
    <path d={path} className="stroke-overlay-accent" fill="none" strokeWidth={2} />
    {points.map((p, i) => <circle key={i} cx={p!.x} cy={p!.y} r={gesture.active === i - 1 ? 7 : 5}
      className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />)}
  </svg>;
}
