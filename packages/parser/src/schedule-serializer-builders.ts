/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP-line builders for `schedule-serializer.ts` — the low-level string
 * encoding helpers (`escStr`, `optStr`, `optEnum`, `optBool`, `optReal`,
 * `ownerRef`, `refList`, `ensureGlobalId`) and the per-entity builders that
 * turn one `WorkScheduleInfo` / `ScheduleTaskInfo` record into its
 * `#N=IFC...(...);` line (`buildWorkControl`, `buildTaskTime`, `buildTask`,
 * plus the small predicates/resolvers those two lean on).
 *
 * `schedule-serializer.ts` owns the orchestration — which entities to emit,
 * in what order, and how their cross-references (`IFCRELNESTS`,
 * `IFCRELASSIGNSTOCONTROL`, `IFCRELASSIGNSTOPROCESS`, `IFCRELSEQUENCE`) wire
 * together — and calls into this module for "how does one entity's own
 * attribute line get written". Same split as `schedule-types.ts` on the
 * read side: single-entity encoding kept apart from cross-entity wiring.
 */

import type { ScheduleTaskInfo, WorkScheduleInfo } from './schedule-extractor.js';
import { deterministicGlobalId } from './deterministic-global-id.js';

export function escStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

export function optStr(v: string | undefined | null): string {
  return v === undefined || v === null || v === '' ? '$' : `'${escStr(v)}'`;
}

export function optEnum(v: string | undefined | null): string {
  return v === undefined || v === null || v === '' ? '$' : `.${v}.`;
}

function optBool(v: boolean | undefined | null): string {
  return v === undefined || v === null ? '$' : v ? '.T.' : '.F.';
}

function optReal(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '$';
  // Integer-format avoids "1.0" → "1." re-import differences across viewers.
  return Number.isInteger(v) ? `${v}.` : String(v);
}

export function ownerRef(ownerHistoryId: number | undefined): string {
  return ownerHistoryId !== undefined ? `#${ownerHistoryId}` : '$';
}

export function refList(ids: number[]): string {
  return ids.length === 0 ? '$' : `(${ids.map(id => `#${id}`).join(',')})`;
}

export function ensureGlobalId(existing: string | undefined, seed: string): string {
  // Round-tripping should preserve whatever GlobalId the upstream extraction
  // saw, even when it isn't exactly 22 chars (some authoring tools emit
  // shorter ids). Only invent a deterministic value when the input is empty.
  if (existing && existing.length > 0) return existing;
  return deterministicGlobalId(seed);
}

export function buildWorkControl(id: number, ws: WorkScheduleInfo, owner: string): string {
  const entity = ws.kind === 'WorkPlan' ? 'IFCWORKPLAN' : 'IFCWORKSCHEDULE';
  const globalId = ensureGlobalId(ws.globalId, `ws|${ws.kind}|${ws.name}`);
  // Deterministic fallback ordering — don't touch `Date.now()` here, it would
  // give identical inputs different STEP output and break diff-based export
  // round-trips. Anchor on whatever the upstream extractor already picked,
  // then on the schedule's own start/finish time.
  const creationDate = ws.creationDate ?? ws.startTime ?? ws.finishTime ?? '1970-01-01T00:00:00';
  // `StartTime` is REQUIRED on IfcWorkControl in IFC4 (ENTITY IfcWorkControl
  // ... StartTime : IfcDateTime) — emitting `$` would fail schema
  // validation on strict viewers. Fall back through the same deterministic
  // chain as `creationDate`. `FinishTime` IS optional, but writing a real
  // value is still friendlier than `$` when the schedule's own `startTime`
  // is the only datum we have.
  const startTime = ws.startTime ?? ws.finishTime ?? creationDate;
  const finishTime = ws.finishTime ?? startTime;
  // IFC4: GlobalId, OwnerHistory, Name, Description, ObjectType,
  //       Identification, CreationDate, Creators, Purpose,
  //       Duration, TotalFloat, StartTime, FinishTime, PredefinedType
  return [
    `#${id}=${entity}(`,
    `'${globalId}',`,
    `${owner},`,
    `'${escStr(ws.name)}',`,
    `${optStr(ws.description)},`,
    `$,`,
    `${optStr(ws.identification)},`,
    `'${escStr(creationDate)}',`,
    `$,`,
    `${optStr(ws.purpose)},`,
    `${optStr(ws.duration)},`,
    `$,`,
    `'${escStr(startTime)}',`,
    `'${escStr(finishTime)}',`,
    `${optEnum(ws.predefinedType)});`,
  ].join('');
}

export function taskHasTimeData(task: ScheduleTaskInfo): boolean {
  const t = task.taskTime;
  if (!t) return false;
  return Boolean(
    t.scheduleStart || t.scheduleFinish || t.scheduleDuration
    || t.actualStart || t.actualFinish || t.actualDuration
    || t.earlyStart || t.earlyFinish || t.lateStart || t.lateFinish
    || t.freeFloat || t.totalFloat || t.remainingTime || t.statusTime
    || t.durationType || t.isCritical !== undefined || t.completion !== undefined,
  );
}

export function buildTaskTime(id: number, task: ScheduleTaskInfo): string {
  const t = task.taskTime!;
  // IFC4: Name, DataOrigin, UDDataOrigin, DurationType,
  //       ScheduleDuration, ScheduleStart, ScheduleFinish,
  //       Early/Late Start/Finish, FreeFloat, TotalFloat, IsCritical,
  //       StatusTime, ActualDuration, ActualStart, ActualFinish,
  //       RemainingTime, Completion
  return [
    `#${id}=IFCTASKTIME(`,
    `$,$,$,`,
    `${optEnum(t.durationType)},`,
    `${optStr(t.scheduleDuration)},`,
    `${optStr(t.scheduleStart)},`,
    `${optStr(t.scheduleFinish)},`,
    `${optStr(t.earlyStart)},`,
    `${optStr(t.earlyFinish)},`,
    `${optStr(t.lateStart)},`,
    `${optStr(t.lateFinish)},`,
    `${optStr(t.freeFloat)},`,
    `${optStr(t.totalFloat)},`,
    `${optBool(t.isCritical)},`,
    `${optStr(t.statusTime)},`,
    `${optStr(t.actualDuration)},`,
    `${optStr(t.actualStart)},`,
    `${optStr(t.actualFinish)},`,
    `${optStr(t.remainingTime)},`,
    `${optReal(t.completion)});`,
  ].join('');
}

export function buildTask(
  id: number,
  task: ScheduleTaskInfo,
  owner: string,
  taskTimeId: number | undefined,
): string {
  const globalId = ensureGlobalId(task.globalId, `task|${task.name}`);
  const taskTimeRef = taskTimeId !== undefined ? `#${taskTimeId}` : '$';
  // IFC4: GlobalId, OwnerHistory, Name, Description, ObjectType,
  //       Identification, LongDescription, Status, WorkMethod, IsMilestone,
  //       Priority, TaskTime, PredefinedType
  return [
    `#${id}=IFCTASK(`,
    `'${globalId}',`,
    `${owner},`,
    `'${escStr(task.name)}',`,
    `${optStr(task.description)},`,
    `${optStr(task.objectType)},`,
    `${optStr(task.identification)},`,
    `${optStr(task.longDescription)},`,
    `${optStr(task.status)},`,
    `${optStr(task.workMethod)},`,
    `${task.isMilestone ? '.T.' : '.F.'},`,
    `${task.priority !== undefined ? Math.trunc(task.priority) : '$'},`,
    `${taskTimeRef},`,
    `${optEnum(task.predefinedType)});`,
  ].join('');
}

export function resolveProductIds(
  task: ScheduleTaskInfo,
  resolver?: (gid: string) => number | undefined,
): number[] {
  // Prefer expressIds when they're present and non-zero (the in-memory schedule
  // path). When only globalIds are known (e.g. round-tripping through the SDK
  // boundary), use the caller-supplied resolver to look them up against the
  // current model — falls back to expressIds whenever the resolver returns
  // undefined.
  //
  // Walk the union of both arrays so global-id-only entries (common for
  // generated schedules where expressId was never filled in) still hit the
  // resolver instead of being silently dropped.
  const out: number[] = [];
  const count = Math.max(task.productExpressIds.length, task.productGlobalIds.length);
  for (let i = 0; i < count; i++) {
    const expressId = task.productExpressIds[i];
    const globalId = task.productGlobalIds[i];
    if (resolver && globalId) {
      const resolved = resolver(globalId);
      if (resolved !== undefined && resolved > 0) {
        out.push(resolved);
        continue;
      }
    }
    if (expressId !== undefined && expressId > 0) out.push(expressId);
  }
  return out;
}
