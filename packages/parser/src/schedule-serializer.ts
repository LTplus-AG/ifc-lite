/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialize a `ScheduleExtraction` to IFC4-conformant STEP entity lines.
 *
 * The output is a list of `#N=IFC...(...);` lines (no preamble, no
 * `DATA;`/`ENDSEC;` framing) ready to be spliced into an existing STEP file
 * just before its terminating `ENDSEC;`. Every emitted entity carries:
 *
 *   • a freshly minted express ID starting at `nextId` (the caller computes
 *     `max(existing IDs) + 1`),
 *   • a 22-character GlobalId — the one already on the `ScheduleExtraction`
 *     when set, otherwise generated,
 *   • a reference to the supplied `ownerHistoryId` for IfcRoot ownership
 *     (pass `undefined` to emit `$`),
 *   • IFC4-correct attribute counts and ordering — IfcWorkSchedule,
 *     IfcTask + IfcTaskTime, IfcRelSequence + IfcLagTime, and the
 *     IfcRelAssignsToControl / IfcRelAssignsToProcess / IfcRelNests edges.
 *
 * The function is pure — it doesn't mutate the input and never touches the
 * STEP source buffer. Re-running it with the same inputs produces the same
 * output (deterministic), which keeps round-trip exports stable and makes
 * unit tests simple.
 */

import type {
  ScheduleExtraction,
  ScheduleTaskInfo,
  ScheduleSequenceInfo,
  WorkScheduleInfo,
} from './schedule-extractor.js';
import { deterministicGlobalId } from './deterministic-global-id.js';

export interface SerializeScheduleOptions {
  /** First free express ID for the synthesized entities. */
  nextId: number;
  /**
   * Express ID of an existing `IfcOwnerHistory` to reference, if the host
   * file has one. When omitted, every emitted entity uses `$` for ownership.
   */
  ownerHistoryId?: number;
  /**
   * Look up an existing express ID for a product GlobalId (for binding
   * `IfcRelAssignsToProcess.RelatedObjects`). When omitted, the relationship
   * is skipped — the schedule is still valid IFC, just without product links.
   */
  resolveProductExpressId?: (productGlobalId: string) => number | undefined;
}

export interface SerializeScheduleResult {
  /** STEP entity lines (each terminated with `;`). */
  lines: string[];
  /** First express ID after the last entity emitted. */
  nextId: number;
  /** Statistics for diagnostics / preview UI. */
  stats: {
    workSchedules: number;
    tasks: number;
    taskTimes: number;
    sequences: number;
    lagTimes: number;
    assignsToControl: number;
    assignsToProcess: number;
    relNests: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// STEP encoding helpers (kept local — same convention as @ifc-lite/create)
// ─────────────────────────────────────────────────────────────────────────

function escStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function optStr(v: string | undefined | null): string {
  return v === undefined || v === null || v === '' ? '$' : `'${escStr(v)}'`;
}

function optEnum(v: string | undefined | null): string {
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

function ownerRef(ownerHistoryId: number | undefined): string {
  return ownerHistoryId !== undefined ? `#${ownerHistoryId}` : '$';
}

/**
 * Format seconds as an ISO 8601 duration string suitable for IfcDuration.
 * Prefers the coarsest integer unit that divides cleanly to avoid noisy
 * "PT432000S" style output for round values like "P5D".
 */
function secondsToIso8601Duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'PT0S';
  if (seconds % 86_400 === 0) return `P${seconds / 86_400}D`;
  if (seconds % 3_600 === 0) return `PT${seconds / 3_600}H`;
  if (seconds % 60 === 0) return `PT${seconds / 60}M`;
  return `PT${Math.round(seconds)}S`;
}

function refList(ids: number[]): string {
  return ids.length === 0 ? '$' : `(${ids.map(id => `#${id}`).join(',')})`;
}

function ensureGlobalId(existing: string | undefined, seed: string): string {
  // Round-tripping should preserve whatever GlobalId the upstream extraction
  // saw, even when it isn't exactly 22 chars (some authoring tools emit
  // shorter ids). Only invent a deterministic value when the input is empty.
  if (existing && existing.length > 0) return existing;
  return deterministicGlobalId(seed);
}

// ─────────────────────────────────────────────────────────────────────────
// Public — serializeScheduleToStep
// ─────────────────────────────────────────────────────────────────────────

export function serializeScheduleToStep(
  data: ScheduleExtraction,
  options: SerializeScheduleOptions,
): SerializeScheduleResult {
  let nextId = options.nextId;
  const lines: string[] = [];
  const owner = ownerRef(options.ownerHistoryId);
  const stats = {
    workSchedules: 0,
    tasks: 0,
    taskTimes: 0,
    sequences: 0,
    lagTimes: 0,
    assignsToControl: 0,
    assignsToProcess: 0,
    relNests: 0,
  };

  /** ScheduleTaskInfo.globalId → fresh express ID we just allocated. */
  const taskExpressIdByGlobalId = new Map<string, number>();
  /** WorkScheduleInfo.globalId → fresh express ID we just allocated. */
  const scheduleExpressIdByGlobalId = new Map<string, number>();

  // ── 1. Work schedules / work plans ────────────────────────────────
  for (const ws of data.workSchedules) {
    const id = nextId++;
    scheduleExpressIdByGlobalId.set(ws.globalId, id);
    lines.push(buildWorkControl(id, ws, owner));
    stats.workSchedules += 1;
  }

  // ── 2. Task times + tasks ─────────────────────────────────────────
  for (const task of data.tasks) {
    let taskTimeId: number | undefined;
    if (taskHasTimeData(task)) {
      taskTimeId = nextId++;
      lines.push(buildTaskTime(taskTimeId, task));
      stats.taskTimes += 1;
    }
    const id = nextId++;
    taskExpressIdByGlobalId.set(task.globalId, id);
    lines.push(buildTask(id, task, owner, taskTimeId));
    stats.tasks += 1;
  }

  // ── 3. Schedule → tasks (IfcRelAssignsToControl) ──────────────────
  for (const ws of data.workSchedules) {
    const controlId = scheduleExpressIdByGlobalId.get(ws.globalId);
    if (controlId === undefined) continue;
    const taskIds: number[] = [];
    for (const taskGid of ws.taskGlobalIds) {
      const tid = taskExpressIdByGlobalId.get(taskGid);
      if (tid !== undefined) taskIds.push(tid);
    }
    if (taskIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-control|${ws.globalId}`);
    lines.push(
      `#${relId}=IFCRELASSIGNSTOCONTROL('${relGid}',${owner},$,$,${refList(taskIds)},$,#${controlId});`,
    );
    stats.assignsToControl += 1;
  }

  // ── 4. Task hierarchy (IfcRelNests) ──────────────────────────────
  for (const parent of data.tasks) {
    if (parent.childGlobalIds.length === 0) continue;
    const parentId = taskExpressIdByGlobalId.get(parent.globalId);
    if (parentId === undefined) continue;
    const childIds: number[] = [];
    for (const childGid of parent.childGlobalIds) {
      const cid = taskExpressIdByGlobalId.get(childGid);
      if (cid !== undefined) childIds.push(cid);
    }
    if (childIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-nests|${parent.globalId}`);
    lines.push(
      `#${relId}=IFCRELNESTS('${relGid}',${owner},$,$,#${parentId},${refList(childIds)});`,
    );
    stats.relNests += 1;
  }

  // ── 5. Products → tasks (IfcRelAssignsToProcess) ─────────────────
  for (const task of data.tasks) {
    if (task.productExpressIds.length === 0 && task.productGlobalIds.length === 0) continue;
    const taskId = taskExpressIdByGlobalId.get(task.globalId);
    if (taskId === undefined) continue;
    const productIds = resolveProductIds(task, options.resolveProductExpressId);
    if (productIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-process|${task.globalId}`);
    lines.push(
      `#${relId}=IFCRELASSIGNSTOPROCESS('${relGid}',${owner},$,$,${refList(productIds)},$,#${taskId},$);`,
    );
    stats.assignsToProcess += 1;
  }

  // ── 6. Sequences (IfcLagTime + IfcRelSequence) ───────────────────
  for (const seq of data.sequences) {
    const relatingId = taskExpressIdByGlobalId.get(seq.relatingTaskGlobalId);
    const relatedId = taskExpressIdByGlobalId.get(seq.relatedTaskGlobalId);
    if (relatingId === undefined || relatedId === undefined) continue;

    // Preserve lag on export even when the upstream extractor only knew the
    // numeric seconds value (e.g. IFC2X3 round-trips where the original
    // IfcDuration string got dropped). We reconstruct an ISO 8601 duration so
    // the emitted IfcLagTime stays schema-valid.
    const lagDuration = seq.timeLagDuration
      ?? (seq.timeLagSeconds !== undefined && seq.timeLagSeconds !== 0
          ? secondsToIso8601Duration(seq.timeLagSeconds)
          : undefined);
    let lagRef = '$';
    if (lagDuration) {
      const lagId = nextId++;
      lines.push(
        `#${lagId}=IFCLAGTIME($,$,$,IFCDURATION('${escStr(lagDuration)}'),.WORKTIME.);`,
      );
      lagRef = `#${lagId}`;
      stats.lagTimes += 1;
    }
    const relId = nextId++;
    const seqGid = ensureGlobalId(seq.globalId, `rel-seq|${seq.relatingTaskGlobalId}|${seq.relatedTaskGlobalId}`);
    const seqType = optEnum(seq.sequenceType ?? 'FINISH_START');
    const userDef = optStr(seq.userDefinedSequenceType);
    lines.push(
      `#${relId}=IFCRELSEQUENCE('${seqGid}',${owner},$,$,#${relatingId},#${relatedId},${lagRef},${seqType},${userDef});`,
    );
    stats.sequences += 1;
  }

  return { lines, nextId, stats };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal builders
// ─────────────────────────────────────────────────────────────────────────

function buildWorkControl(id: number, ws: WorkScheduleInfo, owner: string): string {
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

function taskHasTimeData(task: ScheduleTaskInfo): boolean {
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

function buildTaskTime(id: number, task: ScheduleTaskInfo): string {
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

function buildTask(
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

function resolveProductIds(
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
