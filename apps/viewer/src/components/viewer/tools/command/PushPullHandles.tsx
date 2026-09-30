/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Push / pull face handles (charter #6232, C4): one arrow on each face of the
 * selected element that a dimension hangs off (`readPushPullTarget`), drawn
 * through the element's storey workplane so it sits on the face on a moved,
 * rotated or georeferenced model too. Pressing one starts the drag
 * (`beginPushPullDrag`).
 *
 * Two mounts share the layer:
 *   - `PushPullHandles`, in the Select tool's scene (`SelectEditScene`) while
 *     the Model workspace is open, for the selected element;
 *   - `PushPullScene`, the running command's scene: every face until one is
 *     grabbed, then that face with the size it now asks for.
 *
 * Re-render wake (#5510): `useProjectorTick`, the scene kernel's one shared
 * projector loop.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { canMutate } from '@/store/mutation-permission';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { useProjectorTick } from '@/components/viewport-ui/scene';
import { useTranslation } from '@/i18n';
import { beginPushPullDrag } from '@/lib/push-pull/push-pull-drag';
import { readPushPullTarget, type PushPullFace, type PushPullTarget } from '@/lib/push-pull/push-pull-target';
import { METRE_SYMBOL, formatMetres } from '../../model-inspector/inspector-fields';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { PushPullGesture } from '@/lib/push-pull/push-pull-gesture';

const HANDLE_RADIUS = 9;
const ARROW_LENGTH = 15;

interface Placed { face: PushPullFace; x: number; y: number; dx: number; dy: number }

/** Each face's handle in screen space: its centre, and the unit direction its normal points on screen. */
function place(
  target: PushPullTarget,
  faces: readonly PushPullFace[],
  project: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null,
): Placed[] {
  const at = (p: readonly [number, number, number]) => {
    const r = target.plane.localToRender([p[0], p[1], p[2]]);
    return project({ x: r[0], y: r[1], z: r[2] });
  };
  const out: Placed[] = [];
  for (const face of faces) {
    const a = at(face.origin);
    const b = at([face.origin[0] + face.normal[0], face.origin[1] + face.normal[1], face.origin[2] + face.normal[2]]);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    // A normal pointing at or away from the camera has no direction to draw: point it up.
    out.push({ face, x: a.x, y: a.y, dx: length > 1 ? (b.x - a.x) / length : 0, dy: length > 1 ? (b.y - a.y) / length : -1 });
  }
  return out;
}

function HandleLayer({ target, faces, armedId, readout }: {
  target: PushPullTarget;
  faces: readonly PushPullFace[];
  armedId: PushPullFace['id'] | null;
  readout: string | null;
}) {
  const { t } = useTranslation();
  const project = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  void useProjectorTick(true);
  if (!project) return null;
  const placed = place(target, faces, project);
  return (
    <svg className="absolute inset-0 pointer-events-none z-(--z-hud-popover)" style={{ overflow: 'visible' }}>
      {placed.map(({ face, x, y, dx, dy }) => {
        const armed = face.id === armedId;
        const tipX = x + dx * ARROW_LENGTH, tipY = y + dy * ARROW_LENGTH;
        return (
          <g
            key={face.id}
            data-push-pull-face={face.id}
            data-armed={armed ? 'true' : undefined}
            style={{ pointerEvents: 'auto', cursor: 'grab' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              beginPushPullDrag(face.id, { x: e.clientX, y: e.clientY });
            }}
          >
            <title>{t('pushPull.handleAria', { face: t(face.labelKey) })}</title>
            <circle cx={x} cy={y} r={HANDLE_RADIUS + 7} fill="transparent" />
            <line x1={x} y1={y} x2={tipX} y2={tipY} className="stroke-overlay-accent" strokeWidth={2.5} strokeLinecap="round" pointerEvents="none" />
            <circle cx={tipX} cy={tipY} r={armed ? 6 : 5} className={armed ? 'fill-overlay-accent stroke-overlay-halo' : 'fill-overlay-halo stroke-overlay-accent'} strokeWidth={2.5} pointerEvents="none" />
            <circle cx={x} cy={y} r={3.5} className="fill-overlay-accent" pointerEvents="none" />
            {armed && readout && (
              <text x={tipX + 10} y={tipY - 8} className="fill-overlay-ink text-2xs font-medium" pointerEvents="none">{readout}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** The Select tool's handles on the selected element, in the Model workspace. */
export function PushPullHandles() {
  const workspaceMode = useViewerStore((s) => s.workspaceMode);
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const activeTool = useViewerStore((s) => s.activeTool);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const multiple = useViewerStore((s) => s.selectedEntityIds.size > 1);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  // A reposition moves the element without touching any field above; the workplane reads it.
  const modelPlacement = useViewerStore((s) => s.modelPlacement);

  const target = useMemo(() => {
    if (workspaceMode !== 'model' || !editEnabled || activeTool !== 'select' || selectedEntityId === null || multiple) return null;
    const state = useViewerStore.getState();
    const { modelId, expressId } = resolveEntityRef(selectedEntityId);
    if (!state.models.has(modelId) || !canMutate(state, modelId)) return null;
    return readPushPullTarget(state, modelId, expressId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceMode, editEnabled, activeTool, selectedEntityId, multiple, models, mutationVersion, modelPlacement]);

  if (!target) return null;
  return <HandleLayer target={target} faces={target.faces} armedId={null} readout={null} />;
}

/** `element.pushPull`'s scene: its faces, or the grabbed one with its live size. */
export function PushPullScene({ gesture }: CommandHudProps<PushPullGesture>) {
  const { target, faceId, size } = gesture;
  if (!target) return null;
  const armed = target.faces.find((f) => f.id === faceId) ?? null;
  const shown = armed ? [armed] : target.faces;
  const readout = armed && size !== null ? `${formatMetres(size)} ${METRE_SYMBOL}` : null;
  return <HandleLayer target={target} faces={shown} armedId={armed?.id ?? null} readout={readout} />;
}
