/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * High-level orchestrator over {@link generateSpacesFromWalls}: derive
 * `IfcSpace` across one, several, or all storeys in a model, with
 * auto-escalating snap tolerance and storey-aware heights. This is the engine
 * the CLI (`ifc-lite generate-spaces`) and SDK (`bim.spaces.generate`) share.
 *
 * Footprint comes from the storey's walls (+ other dividers); the vertical
 * extent ("from slabs/roofs") is taken from the storey datums — storeys sit at
 * slab levels, so `height: 'auto'` uses floor-to-floor from `storeyElevations`,
 * and the topmost storey (capped by the roof) falls back to `topStoreyHeight`.
 * Geometry-exact slab/roof undersides are a future refinement.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import {
  generateSpacesFromWalls,
  type GenerateSpacesOptions,
  type GenerateSpacesResult,
  type BoundaryMode,
} from './generate-spaces.js';
import { existingSpaceFootprintsByStorey, type OverlayWallReader } from './extract-walls.js';

/** Snap tolerances tried, in order, when `snap: 'auto'`. First that encloses
 *  rooms wins (least over-merging); else the largest is used. */
const AUTO_SNAP_LADDER = [0.1, 0.25, 0.5] as const;
const DEFAULT_TOP_HEIGHT = 3;

export interface GenerateSpacesAllOptions {
  /** Which storeys: `'all'` (default) or specific express ids. */
  storeys?: 'all' | number[];
  /** Corner-closing tolerance (m), or `'auto'` (default) to escalate the ladder. */
  snap?: number | 'auto';
  /** Drop regions below this area (m²). Default 0.5. */
  minArea?: number;
  /** Space height (m), or `'auto'` (default) = floor-to-floor from storey elevations. */
  height?: number | 'auto';
  /** Height for the topmost storey under `'auto'` (no storey above). Default 3. */
  topStoreyHeight?: number;
  /** Name pattern; `{n}` → 1-based index per storey, `{storey}` → storey name. */
  namePattern?: string;
  /** IfcSpacePredefinedType (default INTERNAL). */
  predefinedType?: string;
  /** Extra divider element types (case-insensitive) beyond the defaults. */
  extraDividerTypes?: string[];
  /** Where the space boundary sits relative to its walls. Default 'inner'. */
  boundaryMode?: BoundaryMode;
  /** Detect + report only; emit no IfcSpace. */
  dryRun?: boolean;
  /**
   * Re-derive even when the model already contains spaces from a prior run.
   * Off by default — the run is skipped so re-processing its own output can't
   * duplicate spaces. `true` bypasses the guard (may duplicate).
   */
  force?: boolean;
  debug?: boolean;
}

export interface StoreyInfo {
  id: number;
  name: string;
  elevation: number;
}

export interface GenerateSpacesStoreyResult extends StoreyInfo {
  /** Height used for this storey's spaces (m). */
  height: number;
  /** Snap tolerance used (m) — the resolved value when `snap: 'auto'`. */
  snapUsed: number;
  result: GenerateSpacesResult;
}

export interface GenerateSpacesAllResult {
  storeys: GenerateSpacesStoreyResult[];
  totalDetected: number;
  totalEmitted: number;
  /**
   * Detected rooms skipped because they overlap an existing space (authored or
   * from a prior run) — per-space, so non-overlapping rooms on the same storey
   * are still emitted. Always 0 when `force` is set.
   */
  skippedExisting: number;
}

/** Every IfcBuildingStorey with resolved name + elevation, low → high. */
export function listStoreys(store: IfcDataStore): StoreyInfo[] {
  const elevs = store.spatialHierarchy?.storeyElevations;
  const list = store.getEntitiesByType('IfcBuildingStorey').map((s) => ({
    id: s.expressId,
    name: store.entities.getName(s.expressId) || `Storey #${s.expressId}`,
    elevation: elevs?.get(s.expressId) ?? 0,
  }));
  list.sort((a, b) => a.elevation - b.elevation);
  return list;
}

export function generateSpaces(
  editor: StoreEditor,
  store: IfcDataStore,
  options: GenerateSpacesAllOptions = {},
  overlay?: OverlayWallReader,
): GenerateSpacesAllResult {
  const all = listStoreys(store);
  const want = options.storeys;
  const selected = want === undefined || want === 'all'
    ? all
    : all.filter((s) => want.includes(s.id));

  // Per-space dedup: skip detected rooms that overlap an existing space, while
  // still emitting non-overlapping rooms on the same storey. `force` opts out.
  const footprintsByStorey = options.force ? new Map() : existingSpaceFootprintsByStorey(store);

  const minArea = options.minArea ?? 0.5;
  const topH = options.topStoreyHeight ?? DEFAULT_TOP_HEIGHT;
  const snapMode = options.snap ?? 'auto';
  const heightMode = options.height ?? 'auto';

  const storeys: GenerateSpacesStoreyResult[] = [];
  let totalDetected = 0;
  let totalEmitted = 0;
  let skippedExisting = 0;

  for (const st of selected) {
    const height = resolveHeight(heightMode, st, all, topH);
    const snapUsed = resolveSnap(snapMode, editor, store, st.id, minArea, overlay);

    const namePattern = (options.namePattern ?? 'Space {n}').replaceAll('{storey}', st.name);
    const result = generateSpacesFromWalls(
      editor,
      store,
      st.id,
      {
        snapTolerance: snapUsed,
        minArea,
        height,
        namePattern,
        predefinedType: options.predefinedType,
        extraDividerTypes: options.extraDividerTypes,
        dryRun: options.dryRun,
        boundaryMode: options.boundaryMode,
        debug: options.debug,
        skipFootprints: footprintsByStorey.get(st.id),
      } satisfies GenerateSpacesOptions,
      overlay,
    );

    totalDetected += result.detected.length;
    totalEmitted += result.emitted.length;
    skippedExisting += result.skippedExisting;
    storeys.push({ ...st, height, snapUsed, result });
  }

  return { storeys, totalDetected, totalEmitted, skippedExisting };
}

function resolveHeight(
  mode: number | 'auto',
  st: StoreyInfo,
  all: StoreyInfo[],
  topH: number,
): number {
  if (typeof mode === 'number') return mode > 0 ? mode : topH;
  const idx = all.findIndex((s) => s.id === st.id);
  const next = idx >= 0 ? all[idx + 1] : undefined;
  const h = next ? next.elevation - st.elevation : topH;
  // Guard against bad/degenerate elevation data.
  return h > 0.1 && h < 50 ? h : topH;
}

function resolveSnap(
  mode: number | 'auto',
  editor: StoreEditor,
  store: IfcDataStore,
  storeyId: number,
  minArea: number,
  overlay?: OverlayWallReader,
): number {
  if (typeof mode === 'number') return mode;
  // Escalate via dry runs (no emission) and take the first tolerance that
  // encloses any room; else the largest tried.
  let used: number = AUTO_SNAP_LADDER[0];
  for (const tol of AUTO_SNAP_LADDER) {
    used = tol;
    const dry = generateSpacesFromWalls(
      editor,
      store,
      storeyId,
      { snapTolerance: tol, minArea, dryRun: true },
      overlay,
    );
    if (dry.detected.length > 0) break;
  }
  return used;
}
