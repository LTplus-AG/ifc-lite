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
} from './generate-spaces.js';
import { spaceCountByStorey, type OverlayWallReader } from './extract-walls.js';

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

export interface GenerateSpacesStoreySkip extends StoreyInfo {
  /** Existing IfcSpace already on the storey (why it was skipped). */
  existingSpaces: number;
}

export interface GenerateSpacesAllResult {
  storeys: GenerateSpacesStoreyResult[];
  totalDetected: number;
  totalEmitted: number;
  /**
   * Storeys skipped because they already contain IfcSpace (authored or from a
   * prior run) — generation there would duplicate/overlap them. Empty when
   * `force` is set. Sum of their `existingSpaces` is the total skipped.
   */
  skippedStoreys: GenerateSpacesStoreySkip[];
  /** Total existing spaces across skipped storeys. */
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
  let selected = want === undefined || want === 'all'
    ? all
    : all.filter((s) => want.includes(s.id));

  // Skip storeys that already contain IfcSpace (authored or from a prior run)
  // so we don't create duplicates overlapping them — unless `force` or a
  // detect-only dry run. Per-storey, so empty floors still generate.
  const skippedStoreys: GenerateSpacesStoreySkip[] = [];
  if (!options.force && !options.dryRun) {
    const existing = spaceCountByStorey(store);
    if (existing.size > 0) {
      selected = selected.filter((s) => {
        const n = existing.get(s.id);
        if (n) {
          skippedStoreys.push({ ...s, existingSpaces: n });
          return false;
        }
        return true;
      });
    }
  }

  const minArea = options.minArea ?? 0.5;
  const topH = options.topStoreyHeight ?? DEFAULT_TOP_HEIGHT;
  const snapMode = options.snap ?? 'auto';
  const heightMode = options.height ?? 'auto';

  const storeys: GenerateSpacesStoreyResult[] = [];
  let totalDetected = 0;
  let totalEmitted = 0;

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
        debug: options.debug,
      } satisfies GenerateSpacesOptions,
      overlay,
    );

    totalDetected += result.detected.length;
    totalEmitted += result.emitted.length;
    storeys.push({ ...st, height, snapUsed, result });
  }

  return {
    storeys,
    totalDetected,
    totalEmitted,
    skippedStoreys,
    skippedExisting: skippedStoreys.reduce((s, x) => s + x.existingSpaces, 0),
  };
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
