/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { serializeScheduleToStep, type IfcDataStore, type ScheduleExtraction } from '@ifc-lite/parser';
import { stripScheduleEntities } from './export-schedule-strip.js';

/**
 * Splice an in-memory `ScheduleExtraction` into a STEP file's DATA section.
 *
 * Three cases:
 *   1. Schedule is purely parsed and untouched — leave the STEP alone.
 *   2. Schedule has generated-only tail (pre-existing behaviour) — append
 *      the generated tasks + sequences + schedules just before ENDSEC.
 *   3. Schedule has been *edited* (rename / reschedule / reassign / delete
 *      on ANY task, generated or parsed) — strip EVERY schedule entity
 *      from the STEP body and re-emit the whole `scheduleData` fresh.
 *      Dependent entities (`IfcTaskTime`, `IfcLagTime`, `IfcRel*`) cascade
 *      cleanly on deletion because we serialize the whole block at once.
 *
 * We also use the source model's existing IfcOwnerHistory (when present)
 * for the inserted entities so they share ownership metadata.
 */
export interface InjectScheduleOptions {
  /**
   * When true, the caller has edited the in-memory schedule — enter
   * rewrite mode (case 3 above). The flag is the scheduleSlice's
   * `scheduleIsEdited` value; threading it here keeps injection logic
   * free of store knowledge.
   */
  scheduleIsEdited?: boolean;
}

export function injectScheduleIntoStep(
  stepContent: string,
  scheduleData: ScheduleExtraction | null,
  ifcDataStore: IfcDataStore,
  options?: InjectScheduleOptions,
): string {
  if (!scheduleData || scheduleData.tasks.length === 0) {
    // No schedule in memory. If the caller flagged "edited", the user
    // deleted every task in what used to be a parsed schedule — we
    // still want to strip the stale entities from the STEP.
    if (options?.scheduleIsEdited) {
      return stripScheduleEntities(stepContent);
    }
    return stepContent;
  }

  const hasGenerated = scheduleData.tasks.some(t => !t.expressId || t.expressId <= 0);
  const edited = options?.scheduleIsEdited === true;

  if (!edited && !hasGenerated) return stepContent;

  // Shared resolution helpers for both injection paths.
  const resolveProduct = (gid: string): number | undefined => {
    if (!gid) return undefined;
    return ifcDataStore.entities?.getExpressIdByGlobalId?.(gid) ?? undefined;
  };

  // ── Rewrite path: strip + re-emit the full schedule ─────────────
  if (edited) {
    const stripped = stripScheduleEntities(stepContent);
    const maxId = findMaxExpressId(stripped);
    const ownerHistoryId = findFirstOwnerHistoryId(stripped) ?? undefined;

    const result = serializeScheduleToStep(scheduleData, {
      nextId: maxId + 1,
      ownerHistoryId,
      resolveProductExpressId: resolveProduct,
    });
    if (result.lines.length === 0) return stripped;
    return spliceBeforeEndSec(stripped, result.lines);
  }

  // ── Append-only path: only generated tasks (legacy behaviour) ───
  const generatedTasks = scheduleData.tasks.filter(t => !t.expressId || t.expressId <= 0);
  const generatedTaskGids = new Set(generatedTasks.map(t => t.globalId));
  const generatedSequences = scheduleData.sequences.filter(
    s => generatedTaskGids.has(s.relatingTaskGlobalId) && generatedTaskGids.has(s.relatedTaskGlobalId),
  );
  const generatedWorkSchedules = scheduleData.workSchedules.filter(ws => !ws.expressId || ws.expressId <= 0);
  // Same rule as the schedules above: a calendar already in the file carries
  // a real expressId and must not be appended twice. Empty in practice today
  // (nothing authors a calendar into the in-memory extraction), but the
  // filter keeps this path correct if something ever does.
  const generatedWorkCalendars = (scheduleData.workCalendars ?? [])
    .filter(cal => !cal.expressId || cal.expressId <= 0);

  const partitioned: ScheduleExtraction = {
    hasSchedule: true,
    workSchedules: generatedWorkSchedules,
    tasks: generatedTasks,
    sequences: generatedSequences,
    workCalendars: generatedWorkCalendars,
  };

  const maxId = findMaxExpressId(stepContent);
  const ownerHistoryId = findFirstOwnerHistoryId(stepContent) ?? undefined;

  const result = serializeScheduleToStep(partitioned, {
    nextId: maxId + 1,
    ownerHistoryId,
    resolveProductExpressId: resolveProduct,
  });
  if (result.lines.length === 0) return stepContent;
  return spliceBeforeEndSec(stepContent, result.lines);
}

/**
 * Splice fresh STEP lines just before the DATA-section's closing
 * `ENDSEC;`. Anchored on the LAST `ENDSEC;` because the header section
 * also ends with one — we want the data end.
 */
function spliceBeforeEndSec(stepContent: string, lines: string[]): string {
  const endSecIdx = stepContent.lastIndexOf('ENDSEC;');
  if (endSecIdx < 0) {
    // Malformed STEP — surface the original file unchanged rather than
    // corrupting it.
    console.warn('[export] schedule injection: ENDSEC not found in STEP output');
    return stepContent;
  }
  const head = stepContent.slice(0, endSecIdx);
  const tail = stepContent.slice(endSecIdx);
  return `${head}${lines.join('\n')}\n${tail}`;
}

/** Scan the STEP body for the highest `#N=` declaration. Returns 0 when none. */
function findMaxExpressId(stepContent: string): number {
  let max = 0;
  // Pattern: line starts with `#NNN=` (newline-anchored to avoid matching
  // refs inside attribute lists).
  const regex = /(?:^|\n)\s*#(\d+)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(stepContent)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Find the first IfcOwnerHistory's express ID in the STEP file, if any. */
function findFirstOwnerHistoryId(stepContent: string): number | null {
  const m = stepContent.match(/(?:^|\n)\s*#(\d+)\s*=\s*IFCOWNERHISTORY\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Trigger a browser file download. Unlike the shared helper this throws
 *  outside the browser, since the SDK's `export.download()` contract promises a
 *  hard failure rather than a silent no-op when there is no DOM. */
