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
 * - Wheel zooms, a middle or Ctrl drag pans (a plain drag too in Select).
 * Other tools do nothing here.
 */

import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';
import { getCommandRuntime, useCommandRuntime } from '@/lib/commands/modeling/runtime';
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
import { routePlanPointer, selectFromPlan } from './PlanPointer';
import { usePlanViewport } from './usePlanViewport';
import { PlanHeader } from './PlanHeader';
import { CutLayer, GhostLayer, GridLayer, HighlightLayer, SnapLayer, toScreen } from './PlanLayers';

/** A press that moves further than this (px) is a drag, not a click. */
const CLICK_SLOP_PX = 4;

interface Press { x: number; y: number; pan: boolean; moved: boolean }

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
    const editor = s.storeEditors.get(session.modelId) ?? new StoreEditor(store, view);
    return storeyWallAxes(store, view, editor, session.storeyId);
  }, [session?.modelId, session?.storeyId, models, mutationVersion]);
  return { plane, axes };
}

export function PlanView() {
  const { t } = useTranslation();
  const session = useViewerStore((s) => s.session);
  const selectedIds = useViewerStore((s) => s.selectedEntityIds);
  const selectedId = useViewerStore((s) => s.selectedEntityId);
  // The renderer highlights both: the global-id set and the scalar selection.
  const selected = useMemo(() => (selectedId === null || selectedIds.has(selectedId) ? selectedIds : new Set([...selectedIds, selectedId])), [selectedIds, selectedId]);
  const runtime = useCommandRuntime();
  const { plane, axes } = usePlanFrame();
  const cut = usePlanCut(session?.modelId ?? null, session?.storeyId ?? null, plane);
  const [grid, setGrid] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const press = useRef<Press | null>(null);

  const frame = useCallback((w: number, h: number) => fitPlan(cut.polygons, cut.lines, axes, w, h), [cut.polygons, cut.lines, axes]);
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

  const feedCommand = (kind: 'move' | 'down', e: ReactPointerEvent): boolean => {
    const at = localAt(e);
    if (!at || !fit) return false;
    return routePlanPointer(kind, {
      local: at.local,
      metresPerPixel: 1 / fit.scale,
      mods: { shiftKey: e.shiftKey, altKey: e.altKey },
      snapping: useViewerStore.getState().snapEnabled,
      planSources,
    });
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pan = e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey));
    if (e.button !== 0 && !pan) return;
    if (!pan && commandRunsOnPlane()) {
      feedCommand('down', e);
      return;
    }
    press.current = { x: e.clientX, y: e.clientY, pan, moved: false };
    capturePointer(e.currentTarget, e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = press.current;
    if (p) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (!p.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
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
    setHovered(at ? pickPlanEntity(cut.polygons, at.local) : null);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
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
      <PlanHeader grid={grid} onToggleGrid={() => setGrid((g) => !g)} onFit={refit} loading={cut.loading} simplified={cut.simplified} />
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        <svg
          ref={svgRef}
          data-plan-canvas
          width={size.width}
          height={size.height}
          className={commandOnPlane ? 'absolute inset-0 cursor-crosshair touch-none select-none' : 'absolute inset-0 cursor-default touch-none select-none'}
          onDragStart={(e) => e.preventDefault()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHovered(null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        >
          {fit && (
            <>
              <GridLayer grid={gridLines} width={size.width} height={size.height} />
              <CutLayer fit={fit} polygons={cut.polygons} lines={cut.lines} axes={axes} />
              <HighlightLayer fit={fit} polygons={cut.polygons} selected={selected} hovered={hovered} />
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
