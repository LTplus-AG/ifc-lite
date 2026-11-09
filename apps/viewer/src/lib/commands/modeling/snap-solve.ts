/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one snap resolution every command pointer shares (charter #6232, M2
 * §1.5): the 3D viewport (`commandPointer.ts`, cursor from a pick or the ray
 * ∩ the workplane) and the 2D plan (`PlanPointer.ts`, cursor from the inverse
 * Fit) both hand a workplane-local cursor and their snap sources here.
 *
 * It asks the running command what to constrain against (anchor, chain,
 * typed locks), runs the WP3 solver with the modifiers (Shift = angle step,
 * Alt = suspend snapping), and lifts the solved point back onto the plane in
 * render space. Nothing here knows about the DOM or the renderer.
 *
 * It also decides how a pointer aims (`pointerAim`), so both views suspend
 * snapping the same way and the HUD can say so.
 */

import { remapWallBodySnap } from './wall-axis-snap';
import { nearestGridNode } from '@/lib/snap/grid';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import { solveSnap } from '@/lib/snap/solve';
import type { SnapProfile, SnapResult, SnapSource, Vec2 } from '@/lib/snap/types';
import { createSemanticSource, type SemanticSource } from '@/lib/snap/sources/semantic';
import { modelWallAxes } from './model-wall-axes';
import { createIfcGridSource, type IfcGridSource } from '@/lib/snap/sources/ifc-grid';
import { storeyGridAxes } from '@/lib/snap/sources/ifc-grid-store';
import { useViewerStore } from '@/store';
import type { CommandRuntimeState } from './runtime.js';
import type { ModelingCommand, Workplane } from './types.js';

/** `detail` is the click count: the second click of a double-click has 2. */
export interface PointerModifiers { shiftKey: boolean; altKey: boolean; detail?: number }

export const NO_MODIFIERS: PointerModifiers = { shiftKey: false, altKey: false };

/**
 * How the pointer reads the model at this moment.
 * - `snap`: under what you see, onto the targets nearby.
 * - `region`: on the plane, unsnapped and unmarked (`aimsAtRegion`).
 * - `surface`: snapping suspended, still under what you see (`aimsAtElement`).
 * - `through`: snapping suspended, pure ray ∩ workplane, past anything in front (#9201).
 */
export type PointerAim = 'snap' | 'region' | 'surface' | 'through';

export function pointerAim<G>(
  command: ModelingCommand<G>,
  gesture: G,
  plane: Workplane,
  snapEnabled: boolean,
  altKey: boolean,
): PointerAim {
  if (command.aimsAtRegion?.(gesture) === true) return 'region';
  if (snapEnabled && !altKey) return 'snap';
  // A section plane stands upright, so a pointer on it is already past nothing.
  return plane.spec.kind === 'section' || command.aimsAtElement?.(gesture) === true ? 'surface' : 'through';
}

export function profileOf(command: ModelingCommand): SnapProfile {
  // Every command today snaps as 'modeling'.
  return typeof command.snap === 'string' ? MODELING_SNAP_PROFILE : command.snap;
}

/** One semantic (wall-axis) source per session model; it rebuilds itself on edits and storey changes. */
let semantic: { modelId: string; source: SemanticSource } | null = null;

function semanticSource(modelId: string): SemanticSource {
  if (semantic?.modelId === modelId) return semantic.source;
  const source = createSemanticSource({
    modelId,
    // Wall lines passing near the cursor feed extension / intersection guides.
    extensions: true,
    version: () => useViewerStore.getState().mutationVersion,
    storeyId: () => useViewerStore.getState().session?.storeyId ?? null,
    loadAxes: (storeyId) => [...modelWallAxes(modelId, storeyId).values()],
  });
  semantic = { modelId, source };
  return source;
}

/** One design-grid source per session model, rebuilt like the semantic one. */
let designGrid: { modelId: string; source: IfcGridSource } | null = null;

export function ifcGridSource(modelId: string): IfcGridSource {
  if (designGrid?.modelId === modelId) return designGrid.source;
  const source = createIfcGridSource({
    modelId,
    version: () => useViewerStore.getState().mutationVersion,
    storeyId: () => useViewerStore.getState().session?.storeyId ?? null,
    loadAxes: (storeyId) => {
      const s = useViewerStore.getState();
      const store = s.models.get(modelId)?.ifcDataStore;
      const view = s.mutationViews.get(modelId);
      return store && view ? storeyGridAxes(store, view, storeyId) : [];
    },
  });
  designGrid = { modelId, source };
  return source;
}

/** The store-backed sources every command pointer consults, 3D and plan alike. */
export function modelSnapSources(modelId: string): SnapSource[] {
  return [semanticSource(modelId), ifcGridSource(modelId)];
}

export interface CommandSnapInput {
  /** The raw cursor on the workplane, local metres. */
  cursor: Vec2;
  /** Screen-to-world scale at the cursor (0 disables snapping radii). */
  metresPerPixel: number;
  sources: readonly SnapSource[];
  mods: PointerModifiers;
  /** Overrides the command's profile (the plan adds its own source ids). */
  profile?: SnapProfile;
  /** How the pointer aims; the default is `snap`. */
  aim?: PointerAim;
}

/** Solve `input` for the running command on `plane`; the result carries `render`. */
export function solveCommandSnap(runtime: CommandRuntimeState, plane: Workplane, input: CommandSnapInput): SnapResult | null {
  const { command } = runtime;
  if (!command) return null;
  const query = command.snapQuery?.(runtime.gesture) ?? { anchor: null, chain: [], locks: {} };
  // Suspended by the snap toggle as well as Alt: the chain's inferred guides stop too.
  const suspended = input.aim === 'through' || input.aim === 'surface';
  let solved = solveSnap(
    {
      cursor: input.cursor,
      metresPerPixel: input.metresPerPixel,
      ...query,
      modifiers: { shift: input.mods.shiftKey, alt: input.mods.altKey || suspended },
    },
    [...input.sources, {
      id: 'grid',
      collect(q, _radius, out) {
        // Host/region picks are not free points; move and copy targets are.
        if (command.aimsAtElement?.(runtime.gesture) === true || command.aimsAtRegion?.(runtime.gesture) === true) return;
        if (input.aim && input.aim !== 'snap') return;
        // A decimal increment around 1–10px, down to micrometre precision.
        const spacing = Math.max(1e-6, 10 ** Math.floor(Math.log10(q.metresPerPixel * 10) + 1e-9));
        const local = nearestGridNode(q.cursor, { origin: query.anchor ?? [0, 0], spacing });
        if (local) out.push({ kind: 'grid', source: 'grid', local, increment: spacing });
      },
    }],
    input.profile ?? profileOf(command),
    runtime.snap ?? undefined,
  );
  if (command.id === 'wall.place' && runtime.ctx && !input.mods.altKey && !suspended) {
    solved = remapWallBodySnap(solved, plane, query, input);
  }
  return {
    ...solved,
    // The HUD's mark: the plane itself is what this point landed on.
    winner: input.aim === 'through' ? { kind: 'workplane', local: solved.local, source: 'workplane' } : solved.winner,
    render: plane.localToRender([solved.local[0], solved.local[1], 0]),
    modifiers: { shift: input.mods.shiftKey, alt: input.mods.altKey },
    metresPerPixel: input.metresPerPixel,
  };
}
