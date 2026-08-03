/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * {@link ImportedTaskRow}s → `ScheduleExtraction` (issue #1890).
 *
 * The output is exactly the structure `generate-schedule.ts` produces, so an
 * imported schedule flows through the existing Gantt panel, 4D animator and
 * IFC serializer with no downstream changes: `commitGeneratedSchedule` is the
 * same entry point for both.
 *
 * Two things this deliberately does *not* do:
 *
 *  - **Assign elements.** `productExpressIds`/`productGlobalIds` come back
 *    empty. A Gantt-tool export knows nothing about IFC entities, and the
 *    issue's own remedy for that — predefined filters per task rather than
 *    GlobalId lists — is a separate change with its own data-model decision.
 *  - **Recompute the critical path.** Dates are taken as authored. The source
 *    tool already levelled them, and silently re-deriving would make the
 *    imported schedule disagree with the file the planner is looking at.
 */

import type {
  ScheduleExtraction,
  ScheduleSequenceInfo,
  ScheduleTaskInfo,
  WorkScheduleInfo,
} from '@ifc-lite/parser';
import { deterministicGlobalId, secondsToIso8601Duration } from '@ifc-lite/parser';
import type { ImportedTaskRow, ParsedScheduleSource, ScheduleImportWarning } from './types.js';

export interface BuildScheduleOptions {
  /**
   * Seed for deterministic GlobalIds. Re-importing the same file yields the
   * same ids, which keeps repeat imports idempotent rather than accumulating
   * duplicate tasks.
   */
  seed: string;
  /** Falls back to the file's project name, then a generic label. */
  scheduleName?: string;
}

/**
 * Resolve each row's parent from its outline level using a stack of the most
 * recent task at each depth.
 *
 * A level that jumps by more than one (1 → 3, which some exports produce when
 * a level is filtered out) is clamped to parent + 1 and reported, rather than
 * left to dangle without a parent.
 */
function resolveHierarchy(
  rows: ImportedTaskRow[],
  globalIdOf: (row: ImportedTaskRow) => string,
  warnings: ScheduleImportWarning[],
): Map<string, string | undefined> {
  const parentBySourceId = new Map<string, string | undefined>();
  /** Index = depth (1-based); value = that depth's most recent task globalId. */
  const openAtDepth: string[] = [];

  for (const row of rows) {
    const maxAllowed = openAtDepth.length + 1;
    let level = row.outlineLevel;
    if (level > maxAllowed) {
      warnings.push({
        code: 'outline-level-jump',
        message: `Task "${row.name}" is at outline level ${level} but its parent chain only reaches ${
          maxAllowed - 1
        }, treated as level ${maxAllowed}.`,
      });
      level = maxAllowed;
    }
    parentBySourceId.set(row.sourceId, level > 1 ? openAtDepth[level - 2] : undefined);
    openAtDepth.length = level - 1;
    openAtDepth.push(globalIdOf(row));
  }
  return parentBySourceId;
}

/** Earliest start / latest finish across the imported tasks, for the WorkSchedule. */
function scheduleBounds(tasks: ScheduleTaskInfo[]): { start?: string; finish?: string } {
  let start: string | undefined;
  let finish: string | undefined;
  for (const task of tasks) {
    const s = task.taskTime?.scheduleStart;
    const f = task.taskTime?.scheduleFinish;
    // ISO datetimes of identical shape compare correctly as strings, which
    // avoids constructing Dates (and re-introducing a timezone shift) here.
    if (s && (start === undefined || s < start)) start = s;
    if (f && (finish === undefined || f > finish)) finish = f;
  }
  return { start, finish };
}

export function buildScheduleExtraction(
  source: ParsedScheduleSource,
  options: BuildScheduleOptions,
): { extraction: ScheduleExtraction; warnings: ScheduleImportWarning[] } {
  const warnings = [...source.warnings];
  const { rows } = source;

  const taskGlobalIdOf = (row: ImportedTaskRow) =>
    deterministicGlobalId(`${options.seed}|task|${row.sourceId}`);
  const globalIdBySourceId = new Map<string, string>();
  for (const row of rows) globalIdBySourceId.set(row.sourceId, taskGlobalIdOf(row));

  const parentBySourceId = resolveHierarchy(rows, taskGlobalIdOf, warnings);
  const scheduleGlobalId = deterministicGlobalId(`${options.seed}|schedule`);

  const tasks: ScheduleTaskInfo[] = rows.map(row => {
    const globalId = globalIdBySourceId.get(row.sourceId)!;
    const hasTime = Boolean(row.start || row.finish || row.durationIso || row.percentComplete !== undefined);
    return {
      expressId: 0,
      globalId,
      name: row.name,
      identification: row.wbs,
      longDescription: row.notes,
      objectType: 'Imported',
      isMilestone: row.isMilestone,
      taskTime: hasTime
        ? {
            scheduleStart: row.start,
            scheduleFinish: row.finish,
            scheduleDuration: row.durationIso,
            durationType: 'WORKTIME',
            completion: row.percentComplete,
          }
        : undefined,
      parentGlobalId: parentBySourceId.get(row.sourceId),
      childGlobalIds: [],
      productExpressIds: [],
      productGlobalIds: [],
      controllingScheduleGlobalIds: [scheduleGlobalId],
    };
  });

  // Backfill childGlobalIds from the resolved parents so the tree is navigable
  // in both directions, matching what the IFC extractor produces from IfcRelNests.
  const taskByGlobalId = new Map(tasks.map(t => [t.globalId, t]));
  for (const task of tasks) {
    if (!task.parentGlobalId) continue;
    taskByGlobalId.get(task.parentGlobalId)?.childGlobalIds.push(task.globalId);
  }

  const sequences: ScheduleSequenceInfo[] = [];
  // Two dependency edges with the same (predecessor, successor, type) —
  // e.g. a CSV cell like "5FS+2d, 5", or a duplicated MSPDI PredecessorLink —
  // hash to the SAME deterministic GlobalId (the seed doesn't include the
  // lag), so pushing both would emit two IfcRelSequence entities with an
  // identical GlobalId, violating IfcRoot GUID uniqueness on export. Track
  // one sequence per key and dedupe here instead.
  const sequenceByKey = new Map<string, ScheduleSequenceInfo>();
  for (const row of rows) {
    const relatedTaskGlobalId = globalIdBySourceId.get(row.sourceId)!;
    for (const dep of row.dependencies) {
      const relatingTaskGlobalId = globalIdBySourceId.get(dep.predecessorSourceId);
      if (!relatingTaskGlobalId) {
        warnings.push({
          code: 'unknown-predecessor',
          message: `Task "${row.name}" depends on "${dep.predecessorSourceId}", which is not in the file, link dropped.`,
        });
        continue;
      }
      if (relatingTaskGlobalId === relatedTaskGlobalId) {
        warnings.push({
          code: 'unparsable-predecessor',
          message: `Task "${row.name}" lists itself as a predecessor, link dropped.`,
        });
        continue;
      }
      const lagSeconds = dep.lagSeconds === undefined ? undefined : Math.round(dep.lagSeconds);
      const key = `${relatingTaskGlobalId}|${relatedTaskGlobalId}|${dep.type}`;
      const existing = sequenceByKey.get(key);
      if (existing) {
        // Fully identical (same pred/succ/type/lag): a harmless duplicate
        // edge, deduped silently — the first-seen entry already carries
        // everything the second would add.
        if (existing.timeLagSeconds !== lagSeconds) {
          // Same edge, different lag: genuine ambiguity in the source file.
          // Keep the first-seen lag (matches "first occurrence wins" used
          // elsewhere in this file, e.g. duplicate-source-id) and say which
          // lags conflicted rather than silently picking one.
          warnings.push({
            code: 'duplicate-dependency',
            message:
              `Task "${row.name}" has more than one ${dep.type} dependency from ` +
              `"${dep.predecessorSourceId}" with conflicting lags (${existing.timeLagSeconds ?? 0}s vs ` +
              `${lagSeconds ?? 0}s), kept the first, dropped the duplicate.`,
          });
        }
        continue;
      }
      // A negative lag (a lead — the successor may start before the
      // predecessor finishes, e.g. "12SS-1 day") round-trips through the
      // signed ISO 8601 duration codec (`@ifc-lite/parser`'s
      // `secondsToIso8601Duration` / `parseIso8601Duration`) the same way a
      // positive lag does: `timeLagSeconds` (signed) stays the source of
      // truth, and `timeLagDuration` is its encoded form, sign included, so
      // the two fields can never disagree. That is true by construction, not
      // coincidence: `timeLagDuration` below encodes the already-rounded
      // `lagSeconds`, not `dep.lagSeconds` — otherwise a fractional lag would
      // round into `timeLagSeconds` but not into `timeLagDuration`,
      // producing the same duration under two different representations
      // (e.g. `timeLagSeconds: 86400` alongside `PT86400.4S`). See
      // `iso8601-duration.ts` for the interop tradeoff this accepts, and
      // docs/guide/schedule-import.md.
      const sequence: ScheduleSequenceInfo = {
        globalId: deterministicGlobalId(
          `${options.seed}|seq|${dep.predecessorSourceId}|${row.sourceId}|${dep.type}`,
        ),
        relatingTaskGlobalId,
        relatedTaskGlobalId,
        sequenceType: dep.type,
        timeLagSeconds: lagSeconds,
        timeLagDuration: lagSeconds === undefined ? undefined : secondsToIso8601Duration(lagSeconds),
      };
      sequenceByKey.set(key, sequence);
      sequences.push(sequence);
    }
  }

  const bounds = scheduleBounds(tasks);
  const workSchedule: WorkScheduleInfo = {
    expressId: 0,
    globalId: scheduleGlobalId,
    kind: 'WorkSchedule',
    name: options.scheduleName || source.projectName || 'Imported schedule',
    description: 'Imported from an external planning file',
    // Deterministic: anchored on the schedule's own start rather than a
    // wall-clock stamp, so re-importing the same file exports identically.
    creationDate: bounds.start,
    startTime: bounds.start,
    finishTime: bounds.finish,
    predefinedType: 'PLANNED',
    taskGlobalIds: tasks.map(t => t.globalId),
  };

  return {
    extraction: { workSchedules: [workSchedule], tasks, sequences, hasSchedule: tasks.length > 0 },
    warnings,
  };
}
