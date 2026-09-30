/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's editable plan (charter #6232, M2 §1.5): the session
 * storey cut 1.2 m above its floor (`usePlanCut`), drawn in workplane-local
 * metres beside the 3D view.
 *
 * - A running command takes the pointer: the plan cursor goes through the
 *   shared solver into the same runtime 3D feeds (`PlanPointer.ts`), so the
 *   ghost shows in both views and a commit is one undo step either way.
 * - In Select, a click selects the smallest cut outline under it (both
 *   selection channels, like a 3D click); Shift toggles, an empty click
 *   clears, double-click frames the selection in 3D, right-click opens the
 *   entity menu. A 3D selection highlights here from the same global ids
 *   the renderer highlights (`selectedEntityIds` plus `selectedEntityId`).
 * - In Select, the selected element shows its direct-edit handles
 *   (`plan-handles.ts`): a wall's ends (the command its 3D end handle
 *   starts), a door's, window's or opening's slide along its wall, a move. A
 *   press on one starts its command; the drag feeds it through the shared
 *   solver, release commits one undo step.
 * - Wheel zooms, a middle or Ctrl drag pans (a plain drag too in Select).
 * Other tools do nothing here.
 */

import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useViewerStore } from '@/store';
import type { ModelLayout } from '@/store/slices/authoringSessionSidebar';
import { useTranslation } from '@/i18n';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';
import { commandPointerCancel, getCommandRuntime, useCommandRuntime } from '@/lib/commands/modeling/runtime';
import type { Workplane } from '@/lib/commands/modeling/types';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import type { WallAxis } from '@/lib/snap/sources/semantic';
import { createGridSource } from '@/lib/snap/sources/grid';
import type { Vec2 } from '@/lib/snap/types';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';
import { usePlanCut } from './usePlanCut';
import { fitPlan, pickPlanEntity, planGrid, screenToLocal } from './plan-fit';
import { createPlanCutSource, planCutLinework } from './plan-cut-source';
import { ghostFootprints } from './plan-ghost';
import { beginPlanHandleDrag, routePlanPointer, selectFromPlan } from './PlanPointer';
import { pickPlanHandle, type PlanHandle } from './plan-handles';
import { HandleLayer, usePlanHandles } from './PlanHandles';
import { usePlanViewport } from './usePlanViewport';
import { PlanHeader } from './PlanHeader';
import { usePlanGridAxes } from './usePlanGridAxes';
import { DesignGridLayer, gridLabelRadius } from './DesignGridLayer';
import { CutLayer, GhostLayer, GridLayer, HighlightLayer, SnapLayer, toScreen } from './PlanLayers';

/** A press that moves further than this (px) is a drag, not a click. */
const CLICK_SLOP_PX = 4;
/** Two presses this close in time and space are a double-click (the 3D click's rule, selectionHandlers.ts). */
const DOUBLE_CLICK_MS = 300;
const DOUBLE_CLICK_PX = 5;

/** A press in Select; `handle`: the selected element's handle it landed on (a drag grabs it, a click still selects). */
interface Press { x: number; y: number; pan: boolean; moved: boolean; handle: PlanHandle | null }

/** Read live in handlers: a command can start between a render and the next event. */
function commandRunsOnPlane(): boolean {
  const { command, ctx } = getCommandRuntime();
  return command !== null && ctx?.workplane != null;
}

/** Only Select acts on the plan besides a command; other tools do nothing here. */
const selecting = () => useViewerStore.getState().activeTool === 'select';

/** The session's resolved workplane and its storey's wall axes, kept current through edits. */
function usePlanFrame(): { plane: Workplane | null; axes: WallAxis[] } {
  const session = useViewerStore((s) => s.session);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const placement = useViewerStore((s) => s.modelPlacement);
  const plane = useMemo(() => {
    void models; void placement; // a reload or a model move re-resolves the frame
    if (!session?.workplane) return null;
    const built = resolveWorkplane(useViewerStore.getState(), session.modelId, session.workplane);
    return 'refused' in built ? null : built;
  }, [session?.modelId, session?.workplane, models, placement]);
  const axes = useMemo(() => {
    void mutationVersion; // walls drawn or moved
    if (!session || session.storeyId === null) return [];
    const s = useViewerStore.getState();
    const store = s.models.get(session.modelId)?.ifcDataStore;
    const view = s.mutationViews.get(session.modelId);
    if (!store || !view) return [];
    return storeyWallAxes(store, view, session.storeyId);
  }, [session?.modelId, session?.storeyId, models, mutationVersion]);
  return { plane, axes };
}

export function PlanView({ layout }: { layout: ModelLayout }) {
  const { t } = useTranslation();
  const session = useViewerStore((s) => s.session);
  const selectedIds = useViewerStore((s) => s.selectedEntityIds);
  const selectedId = useViewerStore((s) => s.selectedEntityId);
  // The renderer highlights both: the global-id set and the scalar selection.
  const selected = useMemo(() => (selectedId === null || selectedIds.has(selectedId) ? selectedIds : new Set([...selectedIds, selectedId])), [selectedIds, selectedId]);
  const runtime = useCommandRuntime();
  const { plane, axes } = usePlanFrame();
  const designGrids = usePlanGridAxes();
  const cut = usePlanCut(session?.modelId ?? null, session?.storeyId ?? null, plane);
  const handles = usePlanHandles(plane, cut.polygons);
  const [grid, setGrid] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<PlanHandle | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const press = useRef<Press | null>(null);
  /** A command's press is down: its release, or its loss, belongs to the command. */
  const commandPress = useRef(false);
  const lastDown = useRef<{ t: number; x: number; y: number } | null>(null);
  /**
   * The click count of a press: `pointerdown.detail` is 0 in Chrome (Pointer
   * Events), so the plan counts itself, as the 3D click does.
   */
  const clickCount = (e: { clientX: number; clientY: number; timeStamp: number }): number => {
    const prev = lastDown.current;
    const double = prev !== null && e.timeStamp - prev.t < DOUBLE_CLICK_MS
      && Math.abs(e.clientX - prev.x) < DOUBLE_CLICK_PX && Math.abs(e.clientY - prev.y) < DOUBLE_CLICK_PX;
    lastDown.current = double ? null : { t: e.timeStamp, x: e.clientX, y: e.clientY };
    return double ? 2 : 1;
  };

  const gridMargin = useMemo(() => designGrids.reduce((margin, axis) => Math.max(margin, gridLabelRadius(axis.AxisTag) + 2), 0), [designGrids]);
  const frame = useCallback((w: number, h: number) => fitPlan(cut.polygons, cut.lines, [...axes, ...designGrids], w, h, gridMargin), [cut.polygons, cut.lines, axes, designGrids, gridMargin]);
  const { size, fit, refit, panBy } = usePlanViewport(hostRef, svgRef, frame, `${session?.modelId}:${session?.storeyId}`, cut.settled);
  const gridLines = useMemo(() => (grid && fit ? planGrid(fit, size.width, size.height) : null), [grid, fit, size.width, size.height]);

  // Snap sources read the latest drawing through refs: no rebuild per render.
  const linework = useMemo(() => planCutLinework(cut.polygons, cut.lines), [cut.polygons, cut.lines]);
  const latest = useRef({ linework, gridLines });
  latest.current = { linework, gridLines };
  const planSources = useMemo(() => [
    createPlanCutSource(() => latest.current.linework),
    createGridSource(() => (latest.current.gridLines ? { origin: [0, 0] as Vec2, spacing: latest.current.gridLines.spacing } : null)),
  ], []);

  const { command, ctx, gesture } = runtime;
  const commandOnPlane = command !== null && ctx?.workplane != null;
  const footprints = useMemo(
    () => (command?.ghost && ctx?.workplane ? ghostFootprints(command.ghost(gesture, ctx), ctx.workplane) : []),
    [command, ctx, gesture],
  );

  const localAt = (e: { clientX: number; clientY: number }): { local: Vec2; sx: number; sy: number } | null => {
    const svg = svgRef.current;
    if (!svg || !fit) return null;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    return { local: screenToLocal(fit, sx, sy), sx, sy };
  };

  const feedCommand = (kind: 'move' | 'down' | 'up', e: ReactPointerEvent): boolean => {
    const at = localAt(e);
    if (!at || !fit) return false;
    return routePlanPointer(kind, {
      local: at.local,
      metresPerPixel: 1 / fit.scale,
      mods: { shiftKey: e.shiftKey, altKey: e.altKey, detail: kind === 'down' ? clickCount(e) : 1 },
      snapping: useViewerStore.getState().snapEnabled,
      planSources,
    });
  };

  /** The handle under the pointer, decided in plan space. */
  const handleAt = (e: { clientX: number; clientY: number }): PlanHandle | null => {
    const at = localAt(e);
    return at && fit ? pickPlanHandle(handles, at.local, 1 / fit.scale) : null;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pan = e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey));
    if (e.button !== 0 && !pan) return;
    if (!pan && commandRunsOnPlane()) {
      // Captured, so a release outside the plan (a dragged corner) still reaches `onPointerUp`.
      capturePointer(e.currentTarget, e.pointerId);
      commandPress.current = true;
      feedCommand('down', e);
      return;
    }
    // Shift-click toggles the selection, even on a handle.
    const handle = !pan && !e.shiftKey && selecting() ? handleAt(e) : null;
    press.current = { x: e.clientX, y: e.clientY, pan, moved: false, handle };
    capturePointer(e.currentTarget, e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    // A release outside the plan (capture refused, or lost) never reaches
    // onPointerUp: a move with no button held ends the press, so hover never pans.
    if (press.current && e.buttons === 0) press.current = null;
    // Same for a command's press: a move with no button held means its release was lost.
    if (commandPress.current && e.buttons === 0) endCommandPress();
    const p = press.current;
    if (p) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (!p.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
      if (p.handle) {
        // A drag off a handle runs its command; the drag's moves feed it (below)
        // and a window pointerup ends it. The pointer stays captured.
        press.current = null;
        setHoveredHandle(null);
        if (beginPlanHandleDrag(p.handle)) feedCommand('move', e);
        return;
      }
      // Select: a plain drag pans too; a command's drag never reaches here.
      p.moved = true;
      panBy(dx, dy);
      p.x = e.clientX; p.y = e.clientY;
      return;
    }
    if (commandRunsOnPlane()) {
      feedCommand('move', e);
      return;
    }
    if (!selecting()) return;
    const at = localAt(e);
    setHoveredHandle(handleAt(e));
    setHovered(at ? pickPlanEntity(cut.polygons, at.local) : null);
  };

  /** A command press that ends without a release (cancelled, or its capture taken away) drops what it started. */
  const endCommandPress = () => {
    if (!commandPress.current) return;
    commandPress.current = false;
    commandPointerCancel();
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    // A command's press never set `press`: its release is the command's (a dragged corner drops).
    if (!press.current && e.button === 0 && commandRunsOnPlane()) {
      commandPress.current = false;
      releasePointer(e.currentTarget, e.pointerId);
      feedCommand('up', e);
      return;
    }
    const p = press.current;
    press.current = null;
    releasePointer(e.currentTarget, e.pointerId);
    if (!p || p.moved || p.pan || !selecting()) return;
    const at = localAt(e);
    if (at) selectFromPlan(pickPlanEntity(cut.polygons, at.local), e.shiftKey);
  };

  const onDoubleClick = () => {
    if (!commandRunsOnPlane() && selecting()) useViewerStore.getState().cameraCallbacks.frameSelection?.();
  };

  const onContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    if (commandRunsOnPlane()) return;
    const at = localAt(e);
    const id = at ? pickPlanEntity(cut.polygons, at.local) : null;
    useViewerStore.getState().openContextMenu(id, e.clientX, e.clientY);
  };

  const Plan = command?.hud.Plan;
  const project = useCallback((p: Vec2) => (fit ? toScreen(fit, p) : ([0, 0] as const)), [fit]);

  return (
    <section data-plan-view data-plan-cut-ms={cut.ms === null ? undefined : Math.round(cut.ms)} aria-label={t('modelWorkspace.plan.title')} className="flex h-full w-full flex-col bg-background">
      <PlanHeader layout={layout} grid={grid} onToggleGrid={() => setGrid((g) => !g)} onFit={refit} loading={cut.loading} simplified={cut.simplified} failed={cut.failed} onRetry={cut.retry} />
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        <svg
          ref={svgRef}
          data-plan-canvas
          width={size.width}
          height={size.height}
          className={`absolute inset-0 touch-none select-none ${commandOnPlane ? 'cursor-crosshair' : hoveredHandle ? 'cursor-grab' : 'cursor-default'}`}
          onDragStart={(e) => e.preventDefault()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { setHovered(null); setHoveredHandle(null); }}
          onPointerCancel={(e) => { press.current = null; endCommandPress(); releasePointer(e.currentTarget, e.pointerId); }}
          onLostPointerCapture={() => { press.current = null; endCommandPress(); }}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        >
          {fit && (
            <>
              <GridLayer grid={gridLines} width={size.width} height={size.height} />
              {fit && <DesignGridLayer axes={designGrids} fit={fit} />}
              <CutLayer fit={fit} polygons={cut.polygons} lines={cut.lines} axes={axes} />
              <HighlightLayer fit={fit} polygons={cut.polygons} selected={selected} hovered={hovered} />
              {!commandOnPlane && <HandleLayer fit={fit} handles={handles} active={hoveredHandle} />}
              {commandOnPlane && <GhostLayer fit={fit} footprints={footprints} />}
              {commandOnPlane && Plan && ctx && <Plan gesture={gesture} ctx={ctx} toScreen={project} />}
              {commandOnPlane && <SnapLayer fit={fit} snap={runtime.snap} />}
            </>
          )}
        </svg>
        {!plane && (
          <p className="pointer-events-none absolute inset-x-0 top-1/3 px-6 text-center text-xs text-muted-foreground">
            {t('modelWorkspace.plan.noPlane')}
          </p>
        )}
      </div>
    </section>
  );
}
