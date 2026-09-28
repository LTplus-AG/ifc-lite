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
 */

import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import { solveSnap } from '@/lib/snap/solve';
import type { SnapProfile, SnapResult, SnapSource, Vec2 } from '@/lib/snap/types';
import { createSemanticSource, type SemanticSource } from '@/lib/snap/sources/semantic';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import { useViewerStore } from '@/store';
import type { CommandRuntimeState } from './runtime.js';
import type { ModelingCommand, Workplane } from './types.js';

export interface PointerModifiers { shiftKey: boolean; altKey: boolean }

export const NO_MODIFIERS: PointerModifiers = { shiftKey: false, altKey: false };

export function profileOf(command: ModelingCommand): SnapProfile {
  // Space Sketch's profile arrives with WP3 PR3.2; every command today snaps as 'modeling'.
  return typeof command.snap === 'string' ? MODELING_SNAP_PROFILE : command.snap;
}

/** One semantic (wall-axis) source per session model; it rebuilds itself on edits and storey changes. */
let semantic: { modelId: string; source: SemanticSource } | null = null;

export function semanticSource(modelId: string): SemanticSource {
  if (semantic?.modelId === modelId) return semantic.source;
  const source = createSemanticSource({
    modelId,
    version: () => useViewerStore.getState().mutationVersion,
    storeyId: () => useViewerStore.getState().session?.storeyId ?? null,
    loadAxes: (storeyId) => {
      const s = useViewerStore.getState();
      const store = s.models.get(modelId)?.ifcDataStore;
      const view = s.mutationViews.get(modelId);
      return store && view ? storeyWallAxes(store, view, storeyId) : [];
    },
  });
  semantic = { modelId, source };
  return source;
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
}

/** Solve `input` for the running command on `plane`; the result carries `render`. */
export function solveCommandSnap(runtime: CommandRuntimeState, plane: Workplane, input: CommandSnapInput): SnapResult | null {
  const { command } = runtime;
  if (!command) return null;
  const query = command.snapQuery?.(runtime.gesture) ?? { anchor: null, chain: [], locks: {} };
  const solved = solveSnap(
    {
      cursor: input.cursor,
      metresPerPixel: input.metresPerPixel,
      ...query,
      modifiers: { shift: input.mods.shiftKey, alt: input.mods.altKey },
    },
    input.sources,
    input.profile ?? profileOf(command),
    runtime.snap ?? undefined,
  );
  return { ...solved, render: plane.localToRender([solved.local[0], solved.local[1], 0]) };
}
