/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selected element's direct-edit handles in the plan (charter #6232, B3),
 * drawn at a constant screen size over the plan's `Fit`. Display only: the
 * plan grabs them in plan space (`pickPlanHandle`), so they take no pointer
 * events of their own.
 */

import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { Workplane } from '@/lib/commands/modeling/types';
import type { Fit } from '@/lib/space-sketch-geometry';
import type { Vec2 } from '@/lib/snap/types';
import type { PlanCutPolygon } from './usePlanCut';
import { toScreen } from './PlanLayers';
import { PLAN_HANDLE_RADIUS_PX, selectedPlanHandles, type PlanHandle } from './plan-handles';

/** Arrow heads either side of a slide handle, along the wall (screen px). */
function slideArrows(x: number, y: number, ux: number, uy: number): string {
  const r = PLAN_HANDLE_RADIUS_PX;
  const head = (sign: 1 | -1) => {
    const tx = x + sign * ux * (r + 7), ty = y + sign * uy * (r + 7);
    const bx = x + sign * ux * (r + 2), by = y + sign * uy * (r + 2);
    return `M${tx.toFixed(1)} ${ty.toFixed(1)}L${(bx - uy * 4).toFixed(1)} ${(by + ux * 4).toFixed(1)}L${(bx + uy * 4).toFixed(1)} ${(by - ux * 4).toFixed(1)}Z`;
  };
  return head(1) + head(-1);
}

export function HandleLayer({ fit, handles, active }: { fit: Fit; handles: readonly PlanHandle[]; active: PlanHandle | null }) {
  const { t } = useTranslation();
  if (handles.length === 0) return null;
  return (
    <g data-plan-layer="handles" pointerEvents="none">
      {handles.map((handle) => {
        const [x, y] = toScreen(fit, handle.at);
        const hot = active !== null && active.kind === handle.kind && (handle.kind !== 'wallEnd' || (active.kind === 'wallEnd' && active.which === handle.which));
        const key = handle.kind === 'wallEnd' ? `end-${handle.which}` : handle.kind;
        if (handle.kind === 'move') {
          const r = PLAN_HANDLE_RADIUS_PX;
          return (
            <g key={key} data-plan-handle="move" data-plan-handle-hot={hot || undefined}>
              <title>{t('planHandles.handle.move')}</title>
              <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={2} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={hot ? 3 : 2} />
              <path d={`M${x - r + 3} ${y}H${x + r - 3}M${x} ${y - r + 3}V${y + r - 3}`} className="stroke-overlay-accent" strokeWidth={1.5} />
            </g>
          );
        }
        return (
          <g key={key} data-plan-handle={handle.kind === 'wallEnd' ? `wall-${handle.which}` : handle.kind} data-plan-handle-hot={hot || undefined}>
            <title>{t(handle.kind === 'wallEnd' ? 'planHandles.handle.wallEnd' : 'planHandles.handle.slide')}</title>
            {handle.kind === 'slide' && (
              // Screen y runs down: the plan's +y is the screen's -y.
              <path d={slideArrows(x, y, handle.axis[0], -handle.axis[1])} className="fill-overlay-accent" />
            )}
            <circle
              cx={x}
              cy={y}
              r={PLAN_HANDLE_RADIUS_PX}
              className="fill-overlay-halo stroke-overlay-accent"
              strokeWidth={hot ? 3 : 2}
            />
          </g>
        );
      })}
    </g>
  );
}

/** The middle of the bounding box of `globalId`'s cut outlines, or null when the cut does not show it. */
function outlineCentre(polygons: readonly PlanCutPolygon[], globalId: number): Vec2 | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const polygon of polygons) {
    if (polygon.entityId !== globalId) continue;
    for (const [x, y] of polygon.outer) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

/** The selected element's handles in the plan of `plane`, kept current through edits, selection and tool changes. */
export function usePlanHandles(plane: Workplane | null, polygons: readonly PlanCutPolygon[]): PlanHandle[] {
  const selectedId = useViewerStore((s) => s.selectedEntityId);
  const selectedIds = useViewerStore((s) => s.selectedEntityIds);
  const activeTool = useViewerStore((s) => s.activeTool);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const collabRole = useViewerStore((s) => s.collabRole);
  const session = useViewerStore((s) => s.session);
  return useMemo(() => {
    void selectedIds; void activeTool; void mutationVersion; void editEnabled; void collabRole; void session;
    return selectedPlanHandles(useViewerStore.getState(), plane, selectedId === null ? null : outlineCentre(polygons, selectedId));
  }, [plane, polygons, selectedId, selectedIds, activeTool, mutationVersion, editEnabled, collabRole, session]);
}
