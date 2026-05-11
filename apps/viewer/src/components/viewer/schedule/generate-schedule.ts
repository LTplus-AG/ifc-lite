/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate a `ScheduleExtraction` from an IFC model's spatial hierarchy.
 *
 * The UI lives in `GenerateScheduleDialog.tsx`; this module keeps the pure
 * logic so we can unit-test the schedule shape without mounting the UI.
 *
 * Strategies supported today:
 *   • `storey` — one task per IfcBuildingStorey, controlling every product
 *     contained in that storey (transitively through spaces, via
 *     `spatialHierarchy.byStorey` which the parser already flattens).
 *   • `building` — one task per IfcBuilding, rolling up every storey's
 *     products into a single task.
 *
 * All identifiers used downstream (globalIds, durations) are kept synthetic
 * but stable — re-running the generator with the same inputs produces the
 * same extraction so consumers don't see playback jitter.
 */

import type {
  ScheduleExtraction,
  ScheduleTaskInfo,
  ScheduleSequenceInfo,
  WorkScheduleInfo,
} from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import { deterministicGlobalId } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Exposed strategy values use the exact IFC EXPRESS entity names per AGENTS.md
 * §1 (Mandatory Schema Compliance). UI layers map these to friendly labels.
 *
 * `IfcBuildingStorey` / `IfcBuilding` — trust the model's spatial hierarchy.
 * `IfcElement` — ignore spatial hierarchy, slice the model by the actual
 *   geometric Z elevation of each meshed element. A rescue hatch for IFCs
 *   with broken hierarchies (a common authoring issue where structural
 *   elements all end up assigned to the ground floor even though they're
 *   physically on floors 10-20).
 */
export type SpatialGroupStrategy = 'IfcBuildingStorey' | 'IfcBuilding' | 'IfcElement';
export type GenerateOrder = 'bottom-up' | 'top-down';

/**
 * For the `IfcElement` strategy, how to further subdivide elements that
 * fall into the same Z slice.
 *
 *   `none`  — one task per Z slice, every element inside it goes to that task.
 *   `class` — split each Z slice by IFC class (IfcWall, IfcSlab, …), so a
 *             20-floor model with 5 classes yields up to 100 tasks.
 *   `type`  — split by the element's resolved type name (IfcRelDefinesByType
 *             target's Name, or ObjectType attribute fallback).
 *   `name`  — split by the element's own Name attribute.
 */
export type ElementZSubgroup = 'none' | 'class' | 'type' | 'name';

export interface GenerateScheduleOptions {
  /** Which source to derive tasks from. */
  strategy: SpatialGroupStrategy;
  /** ISO 8601 datetime for the first task's start (e.g. "2024-05-01T08:00:00"). */
  startDate: string;
  /** Days per task. Each group gets the same duration. */
  daysPerGroup: number;
  /** Lag between groups in days (≥ 0). Applied both to dates and IfcLagTime. */
  lagDays: number;
  /**
   * Order to visit groups when the strategy allows it. "bottom-up" goes by
   * ascending elevation (site → G → 1 → …); "top-down" reverses.
   */
  order: GenerateOrder;
  /** Skip groups whose product count is zero. */
  skipEmptyGroups: boolean;
  /** Create IfcRelSequence edges between consecutive groups. */
  linkSequences: boolean;
  /** Human name shown on the parent IfcWorkSchedule. */
  scheduleName: string;
  /** PredefinedType stamped on each task. */
  predefinedType: string;
  /**
   * `IfcElement` only: height of each Z slice in metres. Typical storey
   * heights are 3–4 m, so 3.0 is a sensible default. Must be positive.
   * Ignored by spatial strategies.
   */
  heightTolerance: number;
  /**
   * `IfcElement` only: how to subdivide elements sharing a Z slice into
   * separate tasks. Ignored by spatial strategies.
   */
  elementZSubgroup: ElementZSubgroup;
}

export interface GeneratePreview {
  /** The extraction as it will be pushed into the viewer store. */
  extraction: ScheduleExtraction;
  /** Number of containers visited. */
  groupCount: number;
  /** Total products assigned across all groups. */
  productCount: number;
  /** ISO datetime of the overall schedule finish (after lag, last group end). */
  finishDate: string;
  /** When true, spatialHierarchy was missing/empty — preview is empty. */
  empty: boolean;
}

export const DEFAULT_OPTIONS: GenerateScheduleOptions = {
  strategy: 'IfcBuildingStorey',
  startDate: defaultStartDate(),
  daysPerGroup: 5,
  lagDays: 0,
  order: 'bottom-up',
  skipEmptyGroups: true,
  linkSequences: true,
  scheduleName: 'Construction schedule',
  predefinedType: 'CONSTRUCTION',
  heightTolerance: 3.0,
  elementZSubgroup: 'none',
};

/**
 * Optional geometry context the `IfcElement` strategy needs to partition
 * elements by their actual Z elevation. Meshes carry GLOBAL expressIds
 * (post-federation offset); the generator converts back to LOCAL ids
 * using `idOffset` so downstream task.productExpressIds match the
 * animator's local-space expectations.
 */
export interface GenerateModelContext {
  meshes: MeshData[];
  idOffset: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compute a reasonable default start time — today at 08:00 local — evaluated
 * at call time (not module load) so dialog re-opens reflect the current day.
 */
export function defaultStartDate(): string {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  return toLocalIso(d);
}

/** Emit a local-timezone ISO datetime without the trailing Z. */
export function toLocalIso(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

function addMs(iso: string, ms: number): string {
  const d = new Date(iso);
  // Millisecond arithmetic preserves fractional days — `setDate()` with a
  // fractional argument silently truncates.
  d.setTime(d.getTime() + ms);
  return toLocalIso(d);
}

/**
 * Format a millisecond duration as ISO 8601. Prefers whole days when the
 * value divides cleanly, then whole hours, else whole minutes, else
 * whole seconds. Crucially, the *input* and the returned string describe
 * the same number of milliseconds — so callers that emit `timeLagSeconds`
 * alongside this string (the IfcRelSequence → IfcLagTime chain) never
 * drift when `durationDays` / `lagDays` is fractional.
 */
function msToIso8601Duration(ms: number): string {
  if (ms <= 0) return 'PT0S';
  if (ms % MS_PER_DAY === 0) return `P${ms / MS_PER_DAY}D`;
  if (ms % MS_PER_HOUR === 0) return `PT${ms / MS_PER_HOUR}H`;
  if (ms % 60_000 === 0) return `PT${ms / 60_000}M`;
  return `PT${Math.round(ms / 1000)}S`;
}

/**
 * Resolve the active IfcDataStore in federation-aware order:
 *   1. explicit legacy single-model `ifcDataStore`
 *   2. the user's current `activeModelId` selection
 *   3. only when exactly one model is loaded → take it
 * Declines to guess in ambiguous multi-model cases so we never operate on
 * an arbitrary insertion-order pick.
 */
export function resolveActiveDataStore(
  ifcDataStore: IfcDataStore | null | undefined,
  activeModelId: string | null | undefined,
  models: Map<string, { ifcDataStore: IfcDataStore | null }>,
): IfcDataStore | null {
  if (ifcDataStore) return ifcDataStore;
  if (activeModelId) {
    const active = models.get(activeModelId);
    if (active?.ifcDataStore) return active.ifcDataStore;
  }
  if (models.size === 1) {
    return models.values().next().value?.ifcDataStore ?? null;
  }
  return null;
}

/** Resolve a spatial-container expressId → friendly name for the task label. */
function resolveName(store: IfcDataStore, expressId: number, fallback: string): string {
  const name = store.entities?.getName?.(expressId);
  return typeof name === 'string' && name.length > 0 ? name : fallback;
}

/** Read the entry's elevation from the hierarchy. Falls back to 0 when absent. */
function storeyElevation(store: IfcDataStore, storeyId: number): number {
  return store.spatialHierarchy?.storeyElevations?.get(storeyId) ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────

export function canGenerateScheduleFrom(
  store: IfcDataStore | null | undefined,
  /** Geometry is required only for the `IfcElement` strategy. */
  modelContext?: GenerateModelContext | null,
): boolean {
  if (!store) return false;
  const byStorey = store.spatialHierarchy?.byStorey;
  const byBuilding = store.spatialHierarchy?.byBuilding;
  const hasSpatial = (byStorey?.size ?? 0) > 0 || (byBuilding?.size ?? 0) > 0;
  const hasMeshes = (modelContext?.meshes?.length ?? 0) > 0;
  return hasSpatial || hasMeshes;
}

/**
 * Build a schedule extraction from the model's spatial hierarchy *or* (when
 * the strategy is `IfcElement`) from element geometry Z slices. Returns an
 * `empty` preview when the chosen strategy has no data to work with.
 */
export function generateScheduleFromSpatialHierarchy(
  store: IfcDataStore | null | undefined,
  options: GenerateScheduleOptions,
  /** Required when `options.strategy === 'IfcElement'`. */
  modelContext?: GenerateModelContext | null,
): GeneratePreview {
  if (!store) {
    return emptyPreview(options);
  }
  if (options.strategy !== 'IfcElement' && !canGenerateScheduleFrom(store)) {
    return emptyPreview(options);
  }
  if (options.strategy === 'IfcElement' && !modelContext?.meshes?.length) {
    return emptyPreview(options);
  }

  const containers = options.strategy === 'IfcElement'
    ? collectZSliceContainers(store, modelContext!, options)
    : collectContainers(store, options);

  if (containers.length === 0) {
    return emptyPreview(options);
  }

  // Deterministic seeds: every generated GlobalId hashes the strategy + the
  // involved containers' real IFC GlobalIds, so two models never collide.
  const generatedSeed = `gen-${options.strategy}`;
  const taskGlobalIdFor = (group: GroupEntry) =>
    deterministicGlobalId(`${generatedSeed}|task|${group.sourceGlobalId}`);
  const sequenceGlobalIdFor = (predecessor: GroupEntry, successor: GroupEntry) =>
    deterministicGlobalId(
      `${generatedSeed}|seq|${predecessor.sourceGlobalId}|${successor.sourceGlobalId}`,
    );
  const scheduleGlobalIdFor = (groups: GroupEntry[]) =>
    deterministicGlobalId(
      `${generatedSeed}|schedule|${groups.map(g => g.sourceGlobalId).join('|')}`,
    );

  // Layout the tasks on a calendar. The first group starts at `startDate`;
  // every subsequent group begins `daysPerGroup + lagDays` after the prior
  // group's start.
  //
  // Work in milliseconds and derive *everything else* (task dates, ISO
  // durations, `timeLagSeconds`) from those same ms values. Earlier iterations
  // computed `timeLagSeconds` exactly (`lagDays * 86_400`) while the ISO
  // string rounded fractional days to hours — a 0.3-day lag came out as 25920
  // seconds next to `PT7H` (25200 seconds). Using one ms quantity everywhere
  // keeps the schedule dates and IFC durations byte-consistent.
  const durationMs = Math.max(MS_PER_HOUR, Math.round(options.daysPerGroup * MS_PER_DAY));
  const lagMs = Math.max(0, Math.round(options.lagDays * MS_PER_DAY));
  const strideMs = durationMs + lagMs;
  const durationIso = msToIso8601Duration(durationMs);
  const lagIso = lagMs > 0 ? msToIso8601Duration(lagMs) : undefined;

  const tasks: ScheduleTaskInfo[] = [];
  const sequences: ScheduleSequenceInfo[] = [];
  let productCount = 0;
  let prevGroup: GroupEntry | null = null;
  let prevTaskGlobalId: string | null = null;

  containers.forEach((group, index) => {
    const groupStart = addMs(options.startDate, index * strideMs);
    const groupFinish = addMs(groupStart, durationMs);
    const taskGlobalId = taskGlobalIdFor(group);

    tasks.push({
      expressId: 0,
      globalId: taskGlobalId,
      name: group.name,
      identification: group.identification,
      longDescription: group.description,
      objectType: 'Generated',
      isMilestone: false,
      predefinedType: options.predefinedType,
      taskTime: {
        scheduleStart: groupStart,
        scheduleFinish: groupFinish,
        scheduleDuration: durationIso,
        durationType: 'WORKTIME',
      },
      childGlobalIds: [],
      productExpressIds: group.productExpressIds,
      productGlobalIds: group.productGlobalIds,
      controllingScheduleGlobalIds: [],
    });

    productCount += group.productExpressIds.length;

    if (options.linkSequences && prevGroup && prevTaskGlobalId) {
      sequences.push({
        globalId: sequenceGlobalIdFor(prevGroup, group),
        relatingTaskGlobalId: prevTaskGlobalId,
        relatedTaskGlobalId: taskGlobalId,
        sequenceType: 'FINISH_START',
        timeLagSeconds: lagMs > 0 ? Math.round(lagMs / 1000) : undefined,
        timeLagDuration: lagIso,
      });
    }
    prevGroup = group;
    prevTaskGlobalId = taskGlobalId;
  });

  const scheduleGlobalId = scheduleGlobalIdFor(containers);
  const scheduleFinish = addMs(
    options.startDate,
    Math.max(0, containers.length - 1) * strideMs + durationMs,
  );
  const taskGlobalIds = tasks.map(t => t.globalId);
  for (const task of tasks) task.controllingScheduleGlobalIds = [scheduleGlobalId];

  const workSchedule: WorkScheduleInfo = {
    expressId: 0,
    globalId: scheduleGlobalId,
    kind: 'WorkSchedule',
    name: options.scheduleName,
    description: describeStrategy(options),
    // Deterministic — exports must be reproducible. Anchoring on `startDate`
    // reflects "this schedule was authored for that start" without smearing a
    // `new Date()` wall-clock stamp across re-runs.
    creationDate: options.startDate,
    startTime: options.startDate,
    finishTime: scheduleFinish,
    predefinedType: 'PLANNED',
    taskGlobalIds,
  };

  return {
    extraction: {
      workSchedules: [workSchedule],
      tasks,
      sequences,
      hasSchedule: true,
    },
    groupCount: containers.length,
    productCount,
    finishDate: scheduleFinish,
    empty: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Container collection
// ─────────────────────────────────────────────────────────────────────────

interface GroupEntry {
  /** Display name from the spatial entity's Name attribute. */
  name: string;
  /** Falls back to '—' when absent. */
  identification?: string;
  /** Longer description, if the spatial hierarchy knows it. */
  description?: string;
  /** Local expressIds of all products contained by this group. */
  productExpressIds: number[];
  /** globalIds aligned with expressIds (empty string when unknown). */
  productGlobalIds: string[];
  /**
   * The spatial container's own IFC GlobalId (falls back to `type#expressId`).
   * Seeds the deterministic generated GlobalIds so two different models never
   * emit colliding task IDs.
   */
  sourceGlobalId: string;
}

function collectContainers(
  store: IfcDataStore,
  options: GenerateScheduleOptions,
): GroupEntry[] {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return [];

  let groups: Array<{ expressId: number; entry: GroupEntry; elevation: number }> = [];

  if (options.strategy === 'IfcBuildingStorey') {
    for (const [storeyId, elementIds] of hierarchy.byStorey) {
      if (options.skipEmptyGroups && elementIds.length === 0) continue;
      groups.push({
        expressId: storeyId,
        entry: makeGroupEntry(store, storeyId, elementIds, 'Storey'),
        elevation: storeyElevation(store, storeyId),
      });
    }
  } else {
    for (const [buildingId, elementIds] of hierarchy.byBuilding) {
      if (options.skipEmptyGroups && elementIds.length === 0) continue;
      groups.push({
        expressId: buildingId,
        entry: makeGroupEntry(store, buildingId, elementIds, 'Building'),
        elevation: 0,
      });
    }
  }

  // Deterministic ordering: bottom-up by elevation (storeys) / insertion
  // order (buildings); top-down reverses.
  groups.sort((a, b) => {
    if (options.strategy === 'IfcBuildingStorey') return a.elevation - b.elevation;
    return 0;
  });
  if (options.order === 'top-down') groups.reverse();

  return groups.map(g => g.entry);
}

function makeGroupEntry(
  store: IfcDataStore,
  containerId: number,
  elementIds: number[],
  fallbackPrefix: string,
): GroupEntry {
  const name = resolveName(store, containerId, `${fallbackPrefix} #${containerId}`);
  const containerGlobalId = store.entities?.getGlobalId?.(containerId) ?? '';
  const productGlobalIds: string[] = new Array(elementIds.length);
  for (let i = 0; i < elementIds.length; i++) {
    const gid = store.entities?.getGlobalId?.(elementIds[i]) ?? '';
    productGlobalIds[i] = gid;
  }
  return {
    name,
    identification: undefined,
    description: undefined,
    productExpressIds: [...elementIds],
    productGlobalIds,
    // Always include the container's expressId so the seed is unique even
    // if two storeys happen to report the same IFC GlobalId (seen in the
    // wild with a malformed parser state — duplicates collapsed every
    // storey to the same task globalId and cross-mapped products into the
    // wrong task). expressId is authoritative per model; concatenating it
    // with the GlobalId keeps the seed human-readable for debugging.
    sourceGlobalId: `${containerGlobalId || fallbackPrefix}#${containerId}`,
  };
}

/**
 * Collect groups by slicing the model's meshed elements into Z bands of
 * `options.heightTolerance` metres. Optionally subdivides each band by
 * element name / IFC class / type so schedules like "Floor 10 walls"
 * and "Floor 10 slabs" are separate tasks.
 *
 * Why this exists: real IFC models frequently misattribute elements to the
 * wrong storey in the spatial hierarchy (authoring tools pool everything
 * under the ground-floor container). This path ignores the hierarchy
 * entirely and partitions elements by their actual geometry — the only
 * 100 %-reliable source of truth for where something physically is.
 */
function collectZSliceContainers(
  store: IfcDataStore,
  modelContext: GenerateModelContext,
  options: GenerateScheduleOptions,
): GroupEntry[] {
  const meshes = modelContext.meshes;
  if (meshes.length === 0) return [];

  const bandMetres = Math.max(0.1, options.heightTolerance);
  const idOffset = modelContext.idOffset || 0;

  // Scan every mesh once: compute min+max vertical, derive a centroid,
  // keep the ifcType in hand. O(total vertex count) but cache-friendly
  // because positions are a typed array.
  //
  // Vertical axis note: mesh positions are in WebGL Y-up space (the
  // parser runs `convertZUpToYUp` on every mesh during collection, so
  // IFC-native Z maps onto WebGL Y and what used to be IFC Y is now
  // negated into WebGL Z). Reading the Y component (index 1) gives us
  // the real "up" — reading Z here would bin by depth, not elevation,
  // which looks like random noise at schedule time.
  interface MeshMeta {
    localId: number;
    centroidY: number;
    ifcType: string;
  }
  const meta: MeshMeta[] = [];
  for (const mesh of meshes) {
    if (!mesh.positions || mesh.positions.length < 3) continue;
    let minY = Infinity;
    let maxY = -Infinity;
    // Vertical (Y in WebGL space) is every 3rd float starting at index 1.
    for (let i = 1; i < mesh.positions.length; i += 3) {
      const v = mesh.positions[i];
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) continue;
    meta.push({
      localId: mesh.expressId - idOffset,
      centroidY: (minY + maxY) * 0.5,
      ifcType: mesh.ifcType ?? 'IfcElement',
    });
  }
  if (meta.length === 0) return [];

  // Bin by vertical coordinate. Bin indices are integers so two elements
  // at identical height always land in the same bin regardless of
  // floating-point drift.
  const binOfY = (y: number) => Math.floor(y / bandMetres);

  // Primary bin + optional sub-key → list of mesh metas.
  // Bin key is "<bin> <subkey>" so we can sort lexicographically
  // after the bin portion is zero-padded to a fixed width.
  const BIN_WIDTH = 8; // enough for 10^8 bins × 0.1 m = 10^7 m of range
  const padBin = (b: number): string => {
    const sign = b < 0 ? '-' : '+';
    const abs = Math.abs(b).toString().padStart(BIN_WIDTH, '0');
    return `${sign}${abs}`;
  };

  const subgroupKeyFor = (m: MeshMeta): string => {
    switch (options.elementZSubgroup) {
      case 'class':
        return m.ifcType;
      case 'type': {
        const tn = store.entities?.getTypeName?.(m.localId) ?? '';
        return tn || m.ifcType;
      }
      case 'name':
        return store.entities?.getName?.(m.localId) ?? '';
      default:
        return '';
    }
  };

  const groups = new Map<string, { bin: number; subkey: string; metas: MeshMeta[] }>();
  for (const m of meta) {
    const bin = binOfY(m.centroidY);
    const subkey = subgroupKeyFor(m);
    const key = `${padBin(bin)} ${subkey}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { bin, subkey, metas: [] };
      groups.set(key, bucket);
    }
    bucket.metas.push(m);
  }

  // Deterministic order: ascending bin, then lexicographic subkey. Reverse
  // for top-down.
  const sortedKeys = [...groups.keys()].sort();
  if (options.order === 'top-down') sortedKeys.reverse();

  const entries: GroupEntry[] = [];
  for (const key of sortedKeys) {
    const bucket = groups.get(key)!;
    if (options.skipEmptyGroups && bucket.metas.length === 0) continue;

    const localIds = bucket.metas.map(m => m.localId);
    const productGlobalIds = localIds.map(id => store.entities?.getGlobalId?.(id) ?? '');

    const zFrom = bucket.bin * bandMetres;
    const zTo = zFrom + bandMetres;
    const zLabel = `${formatZ(zFrom)} – ${formatZ(zTo)}`;
    const displayName = bucket.subkey
      ? `${bucket.subkey} · ${zLabel}`
      : `Elements ${zLabel}`;

    entries.push({
      name: displayName,
      identification: undefined,
      description: `Elements with geometry Z in ${zLabel} (${localIds.length} item${localIds.length === 1 ? '' : 's'})`,
      productExpressIds: localIds,
      productGlobalIds,
      // Seed for the deterministic task globalId — bin+subkey uniquely
      // identifies the bucket across runs of the same model.
      sourceGlobalId: `IfcElement#bin${padBin(bucket.bin)}|sub:${bucket.subkey}`,
    });
  }
  return entries;
}

function formatZ(z: number): string {
  // Two decimals is plenty for metre-scale bins; trims trailing zeros so
  // "+3.00 m" reads as "+3 m" but "+3.25 m" keeps its precision.
  const sign = z >= 0 ? '+' : '';
  const rounded = Math.round(z * 100) / 100;
  return `${sign}${rounded.toString()} m`; // NBSP to keep units together
}

function describeStrategy(options: GenerateScheduleOptions): string {
  switch (options.strategy) {
    case 'IfcBuildingStorey':
      return 'Generated from building storeys';
    case 'IfcBuilding':
      return 'Generated from buildings';
    case 'IfcElement': {
      const subBy = options.elementZSubgroup === 'none'
        ? ''
        : `, grouped by ${options.elementZSubgroup}`;
      return `Generated from element Z slices (${options.heightTolerance} m bands${subBy})`;
    }
  }
}

function emptyPreview(options: GenerateScheduleOptions): GeneratePreview {
  return {
    extraction: {
      workSchedules: [],
      tasks: [],
      sequences: [],
      hasSchedule: false,
    },
    groupCount: 0,
    productCount: 0,
    finishDate: options.startDate,
    empty: true,
  };
}
