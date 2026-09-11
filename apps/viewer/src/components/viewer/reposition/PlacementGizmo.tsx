/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useRef, type PointerEvent } from 'react';
import { useViewerStore } from '@/store';
import { useCameraTickSubscription } from '@/hooks/useCameraTickSubscription';
import { modelCenter } from '@/lib/model-placement/scene';
import { addTranslation, constrainTranslation, orthogonalAxis, toRenderTranslation, type Translation, type MoveConstraint } from '@/lib/model-placement/translation';
import { dragTranslation, type DragBasis, type ScreenVector } from '@/lib/model-placement/drag';

const AXES = ['x', 'y', 'z'] as const;
const COLORS = ['#ef4444', '#10b981', '#3b82f6'];
interface Drag { start: ScreenVector; basis: DragBasis; before: Translation; constraint: MoveConstraint; ids: readonly string[]; ortho?: 'x' | 'y' | 'z' }

/** Uses the existing gizmo's projection callback and camera tick subscription.
 * All pointer samples preview against the starting displacement; Apply makes one command. */
export function PlacementGizmo({ disabled, onError }: { disabled: boolean; onError: (message: string) => void }) {
  const preview = useViewerStore((state) => state.modelPlacement.preview);
  const project = useViewerStore((state) => state.cameraCallbacks.projectToScreen);
  const viewpoint = useViewerStore((state) => state.cameraCallbacks.getViewpoint);
  const drag = useRef<Drag | null>(null);
  useCameraTickSubscription(viewpoint, Boolean(preview) && !disabled);
  if (!preview || !project || disabled) return null;
  const center = preview.source ? addTranslation(preview.source.point, preview.delta) : modelCenter(preview.modelIds[0]);
  if (!center) return null;
  const projectPoint = (value: Translation) => { const [x, y, z] = toRenderTranslation(value); return project({ x, y, z }); };
  const origin = projectPoint(center);
  if (!origin) return null;
  const vectors = AXES.map((_, axis) => {
    const probe: [number, number, number] = [...center]; probe[axis] += 1;
    const tip = projectPoint(probe);
    return tip ? { x: tip.x - origin.x, y: tip.y - origin.y } : null;
  });
  const tips = vectors.map((vector) => {
    if (!vector) return null;
    const length = Math.hypot(vector.x, vector.y);
    return length < 1e-3 ? null : { x: origin.x + vector.x * 80 / length, y: origin.y + vector.y * 80 / length };
  });
  const start = (axes: readonly (0 | 1 | 2)[], event: PointerEvent<SVGElement>) => {
    if (event.button !== 0) return;
    const basis = axes.flatMap((axis) => vectors[axis] ? [{ axis, screen: vectors[axis]! }] : []);
    if (basis.length !== axes.length || !dragTranslation(basis, { x: 0, y: 0 })) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const constraint = axes.map((axis) => AXES[axis]).join('') as MoveConstraint;
    useViewerStore.getState().setMoveConstraint(constraint);
    drag.current = { start: { x: event.clientX, y: event.clientY }, basis,
      before: useViewerStore.getState().modelPlacement.preview!.delta, constraint, ids: preview.modelIds };
  };
  const move = (event: PointerEvent<SVGElement>) => {
    const active = drag.current;
    if (!active || active.ids !== useViewerStore.getState().modelPlacement.preview?.modelIds) return;
    const movement = dragTranslation(active.basis, { x: event.clientX - active.start.x, y: event.clientY - active.start.y });
    if (!movement) return;
    try {
      let next = movement;
      if (event.shiftKey) {
        active.ortho = orthogonalAxis(movement, active.constraint, active.ortho);
        next = constrainTranslation(movement, active.ortho);
      } else active.ortho = undefined;
      useViewerStore.getState().previewModelTranslation(addTranslation(active.before, next));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  const end = (event: PointerEvent<SVGElement>, cancel = false) => {
    const active = drag.current; drag.current = null;
    if (cancel && active && active.ids === useViewerStore.getState().modelPlacement.preview?.modelIds) {
      useViewerStore.getState().previewModelTranslation(active.before);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handlers = { onPointerMove: move, onPointerUp: (event: PointerEvent<SVGElement>) => end(event),
    onPointerCancel: (event: PointerEvent<SVGElement>) => end(event, true), onLostPointerCapture: () => { drag.current = null; } };
  return <svg aria-label="Model movement handles" className="absolute inset-0 w-full h-full pointer-events-none z-30" style={{ overflow: 'visible' }}>
    {([[0, 1], [0, 2], [1, 2]] as const).map((axes) => {
      const a = tips[axes[0]], b = tips[axes[1]];
      if (!a || !b || !dragTranslation(axes.map((axis) => ({ axis, screen: vectors[axis]! })), { x: 0, y: 0 })) return null;
      const points = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]].map(([u, v]) =>
        `${origin.x + (a.x - origin.x) * u + (b.x - origin.x) * v},${origin.y + (a.y - origin.y) * u + (b.y - origin.y) * v}`).join(' ');
      const name = axes.map((axis) => AXES[axis]).join('').toUpperCase();
      return <polygon key={name} aria-label={`Drag ${name} plane`} points={points} fill="#14b8a655" stroke="#14b8a6"
        style={{ pointerEvents: 'auto', cursor: 'grab' }} onPointerDown={(event) => start(axes, event)} {...handlers} />;
    })}
    {tips.map((tip, axis) => tip && <g key={axis}>
      <line x1={origin.x} y1={origin.y} x2={tip.x} y2={tip.y} stroke={COLORS[axis]} strokeWidth={3} />
      <circle aria-label={`Drag ${AXES[axis].toUpperCase()} axis`} cx={tip.x} cy={tip.y} r={8} fill={COLORS[axis]}
        style={{ pointerEvents: 'auto', cursor: 'grab' }} onPointerDown={(event) => start([axis as 0 | 1 | 2], event)} {...handlers} />
      <text x={tip.x + 10} y={tip.y} fill={COLORS[axis]}>{AXES[axis].toUpperCase()}</text>
    </g>)}
    <text x={origin.x + 12} y={origin.y + 24} fill="currentColor" className="text-xs">{Math.hypot(...preview.delta).toFixed(4)} m</text>
  </svg>;
}
