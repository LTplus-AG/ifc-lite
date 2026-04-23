/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.schedule namespace methods.
 *
 * Reads IFC 4D / construction-sequence data (IfcTask, IfcRelSequence, IfcTaskTime,
 * IfcWorkSchedule, IfcWorkPlan) from the active model. Reuses the `query`
 * permission since it's read-only metadata access — same trust level as
 * `bim.query.*`.
 *
 * Public shape uses IFC EXPRESS PascalCase per AGENTS.md §1 — direct
 * attribute names (`GlobalId`, `Name`, `ScheduleStart`, `PredefinedType`
 * …) map 1:1 to the source IFC. Derived navigation fields (parent /
 * children / assigned products) are also PascalCase for consistency.
 * Internal `ScheduleExtraction` structs stay camelCase; translation
 * happens at this boundary so SDK callers see the IFC-native shape
 * LLM-generated scripts will recognise.
 */

import type { NamespaceSchema } from './bridge-schema.js';

// ─── Public IFC-PascalCase shape (emitted into bim-globals.d.ts) ──────

const TASK_TIME_RETURN =
  "{ ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string;"
  + ' ActualStart?: string; ActualFinish?: string; ActualDuration?: string;'
  + ' EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string;'
  + ' FreeFloat?: string; TotalFloat?: string; RemainingTime?: string; StatusTime?: string;'
  + " IsCritical?: boolean; Completion?: number; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED' }";

const TASK_RETURN =
  '{ GlobalId: string; ExpressId: number; Name: string; Description?: string;'
  + ' ObjectType?: string; Identification?: string; LongDescription?: string;'
  + ' Status?: string; WorkMethod?: string; IsMilestone: boolean; Priority?: number;'
  + ' PredefinedType?: string;'
  + ' ParentTaskGlobalId?: string; ChildTaskGlobalIds: string[];'
  + ' AssignedProductExpressIds: number[]; AssignedProductGlobalIds: string[];'
  + ' ControllingScheduleGlobalIds: string[];'
  + ` TaskTime?: ${TASK_TIME_RETURN} }`;

const WORK_SCHEDULE_RETURN =
  "{ GlobalId: string; ExpressId: number; Name: string; Description?: string;"
  + ' Identification?: string; CreationDate?: string; StartTime?: string; FinishTime?: string;'
  + " Purpose?: string; Duration?: string; PredefinedType?: string;"
  + " Kind: 'WorkSchedule' | 'WorkPlan'; TaskGlobalIds: string[] }";

const SEQUENCE_RETURN =
  '{ RelatingProcessGlobalId: string; RelatedProcessGlobalId: string;'
  + " SequenceType: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH'"
  + " | 'USERDEFINED' | 'NOTDEFINED';"
  + ' UserDefinedSequenceType?: string;'
  + ' TimeLagSeconds?: number; TimeLagDuration?: string }';

const DATA_RETURN =
  `{ HasSchedule: boolean;`
  + ` WorkSchedules: Array<${WORK_SCHEDULE_RETURN}>;`
  + ` Tasks: Array<${TASK_RETURN}>;`
  + ` Sequences: Array<${SEQUENCE_RETURN}> }`;

// ─── Internal → public translator ─────────────────────────────────────

// Typed to `any` at this boundary because the internal ScheduleExtraction
// lives in @ifc-lite/parser — pulling the types in here would create a
// bridge → parser dependency the bundler doesn't need. The bridge just
// renames keys.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateTaskTime(tt: any): Record<string, unknown> | undefined {
  if (!tt) return undefined;
  return {
    ScheduleStart: tt.scheduleStart,
    ScheduleFinish: tt.scheduleFinish,
    ScheduleDuration: tt.scheduleDuration,
    ActualStart: tt.actualStart,
    ActualFinish: tt.actualFinish,
    ActualDuration: tt.actualDuration,
    EarlyStart: tt.earlyStart,
    EarlyFinish: tt.earlyFinish,
    LateStart: tt.lateStart,
    LateFinish: tt.lateFinish,
    FreeFloat: tt.freeFloat,
    TotalFloat: tt.totalFloat,
    RemainingTime: tt.remainingTime,
    StatusTime: tt.statusTime,
    IsCritical: tt.isCritical,
    Completion: tt.completion,
    DurationType: tt.durationType,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateTask(t: any): Record<string, unknown> {
  return {
    GlobalId: t.globalId,
    ExpressId: t.expressId,
    Name: t.name,
    Description: t.description,
    ObjectType: t.objectType,
    Identification: t.identification,
    LongDescription: t.longDescription,
    Status: t.status,
    WorkMethod: t.workMethod,
    IsMilestone: t.isMilestone,
    Priority: t.priority,
    PredefinedType: t.predefinedType,
    ParentTaskGlobalId: t.parentGlobalId,
    ChildTaskGlobalIds: t.childGlobalIds,
    AssignedProductExpressIds: t.productExpressIds,
    AssignedProductGlobalIds: t.productGlobalIds,
    ControllingScheduleGlobalIds: t.controllingScheduleGlobalIds,
    TaskTime: translateTaskTime(t.taskTime),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateWorkSchedule(w: any): Record<string, unknown> {
  return {
    GlobalId: w.globalId,
    ExpressId: w.expressId,
    Name: w.name,
    Description: w.description,
    Identification: w.identification,
    CreationDate: w.creationDate,
    StartTime: w.startTime,
    FinishTime: w.finishTime,
    Purpose: w.purpose,
    Duration: w.duration,
    PredefinedType: w.predefinedType,
    Kind: w.kind,
    TaskGlobalIds: w.taskGlobalIds,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateSequence(s: any): Record<string, unknown> {
  return {
    RelatingProcessGlobalId: s.relatingTaskGlobalId,
    RelatedProcessGlobalId: s.relatedTaskGlobalId,
    SequenceType: s.sequenceType,
    UserDefinedSequenceType: s.userDefinedSequenceType,
    TimeLagSeconds: s.timeLagSeconds,
    TimeLagDuration: s.timeLagDuration,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateData(d: any): Record<string, unknown> {
  return {
    HasSchedule: d.hasSchedule,
    WorkSchedules: (d.workSchedules ?? []).map(translateWorkSchedule),
    Tasks: (d.tasks ?? []).map(translateTask),
    Sequences: (d.sequences ?? []).map(translateSequence),
  };
}

export function buildScheduleNamespace(): NamespaceSchema {
  return {
    name: 'schedule',
    doc: '4D / IFC construction schedule reader (IfcTask, IfcWorkSchedule, IfcRelSequence)',
    permission: 'query',
    methods: [
      {
        name: 'data',
        doc: 'Full schedule extraction — tasks, dependencies, and work schedules.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: DATA_RETURN,
        call: (sdk, args) => translateData(sdk.schedule.data(args[0] as string | undefined)),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Inspect the full 4D schedule graph — tasks with their dates, dependencies, and products they control. Omit modelId to read the active model.',
        },
      },
      {
        name: 'tasks',
        doc: 'All IfcTask entities with their times and assigned products.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${TASK_RETURN}>`,
        call: (sdk, args) => (sdk.schedule.tasks(args[0] as string | undefined) ?? []).map(translateTask),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Get a flat list of tasks to inspect names, dates, and the products each task constructs/installs.',
        },
      },
      {
        name: 'workSchedules',
        doc: 'All IfcWorkSchedule and IfcWorkPlan containers.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${WORK_SCHEDULE_RETURN}>`,
        call: (sdk, args) => (sdk.schedule.workSchedules(args[0] as string | undefined) ?? []).map(translateWorkSchedule),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List all work schedules / work plans in the model.',
        },
      },
      {
        name: 'sequences',
        doc: 'All IfcRelSequence dependency edges (FS/SS/FF/SF, with optional IfcLagTime).',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${SEQUENCE_RETURN}>`,
        call: (sdk, args) => (sdk.schedule.sequences(args[0] as string | undefined) ?? []).map(translateSequence),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List task dependency edges to understand sequencing or detect missing links.',
        },
      },
    ],
  };
}
