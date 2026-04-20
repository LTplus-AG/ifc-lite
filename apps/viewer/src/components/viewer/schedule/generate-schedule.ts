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

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Exposed strategy values use the exact IFC EXPRESS entity names per AGENTS.md
 * §1 (Mandatory Schema Compliance). UI layers map these to friendly labels.
 */
export type SpatialGroupStrategy = 'IfcBuildingStorey' | 'IfcBuilding';
export type GenerateOrder = 'bottom-up' | 'top-down';

export interface GenerateScheduleOptions {
  /** Which spatial container to treat as one task. */
  strategy: SpatialGroupStrategy;
  /** ISO 8601 datetime for the first task's start (e.g. "2024-05-01T08:00:00"). */
  startDate: string;
  /** Days per task. Each group gets the same duration. */
  daysPerGroup: number;
  /** Lag between groups in days (≥ 0). Applied both to dates and IfcLagTime. */
  lagDays: number;
  /**
   * Order to visit groups when both strategy allows it. "bottom-up" goes by
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
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function defaultStartDate(): string {
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

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return toLocalIso(d);
}

function daysToIso8601Duration(days: number): string {
  // Integer-day durations stay compact ("P5D"); fractional days drop down to
  // hours so we don't emit "P1.5D" (valid ISO but uncommon in Gantt exports).
  if (Number.isInteger(days)) return `P${days}D`;
  const hours = Math.round(days * 24);
  return `PT${hours}H`;
}

/**
 * Derive a deterministic, pseudo-IFC 22-char GlobalId from an arbitrary seed.
 *
 * Seeds typically encode the container's real IFC GlobalId (+ a role suffix
 * like 'task' / 'seq' / 'schedule'), so two different models that share the
 * same strategy/order still produce distinct generated IDs — and re-running
 * the generator on the same model produces the same IDs, which keeps unit
 * tests and playback state stable.
 */
function deterministicGlobalId(seed: string): string {
  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let acc = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    acc ^= seed.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 22; i++) {
    out += CHARS[acc & 0x3f];
    // Advance the state so each of the 22 characters depends on the whole seed.
    acc = Math.imul(acc ^ (i * 0x45d9f3b), 0x01000193) >>> 0;
  }
  return out;
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

export function canGenerateScheduleFrom(store: IfcDataStore | null | undefined): boolean {
  if (!store?.spatialHierarchy) return false;
  const byStorey = store.spatialHierarchy.byStorey;
  const byBuilding = store.spatialHierarchy.byBuilding;
  return (byStorey?.size ?? 0) > 0 || (byBuilding?.size ?? 0) > 0;
}

/**
 * Build a schedule extraction from the model's spatial hierarchy. Returns an
 * `empty` preview when no storeys / buildings exist.
 */
export function generateScheduleFromSpatialHierarchy(
  store: IfcDataStore | null | undefined,
  options: GenerateScheduleOptions,
): GeneratePreview {
  if (!store || !canGenerateScheduleFrom(store)) {
    return emptyPreview(options);
  }

  const containers = collectContainers(store, options);

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
  const strideDays = Math.max(0.1, options.daysPerGroup) + Math.max(0, options.lagDays);
  const durationIso = daysToIso8601Duration(Math.max(0.1, options.daysPerGroup));
  const lagIso = options.lagDays > 0 ? daysToIso8601Duration(options.lagDays) : undefined;

  const tasks: ScheduleTaskInfo[] = [];
  const sequences: ScheduleSequenceInfo[] = [];
  let productCount = 0;
  let prevGroup: GroupEntry | null = null;
  let prevTaskGlobalId: string | null = null;

  containers.forEach((group, index) => {
    const groupStart = addDays(options.startDate, index * strideDays);
    const groupFinish = addDays(groupStart, options.daysPerGroup);
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
        timeLagSeconds: options.lagDays > 0 ? options.lagDays * 86_400 : undefined,
        timeLagDuration: lagIso,
      });
    }
    prevGroup = group;
    prevTaskGlobalId = taskGlobalId;
  });

  const scheduleGlobalId = scheduleGlobalIdFor(containers);
  const scheduleFinish = addDays(
    options.startDate,
    Math.max(0, containers.length - 1) * strideDays + options.daysPerGroup,
  );
  const taskGlobalIds = tasks.map(t => t.globalId);
  for (const task of tasks) task.controllingScheduleGlobalIds = [scheduleGlobalId];

  const workSchedule: WorkScheduleInfo = {
    expressId: 0,
    globalId: scheduleGlobalId,
    kind: 'WorkSchedule',
    name: options.scheduleName,
    description: `Generated from ${options.strategy === 'IfcBuildingStorey' ? 'building storeys' : 'buildings'}`,
    creationDate: toLocalIso(new Date()),
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
    sourceGlobalId: containerGlobalId || `${fallbackPrefix}#${containerId}`,
  };
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
