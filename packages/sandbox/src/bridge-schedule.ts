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
 *
 * Both the emitted TypeScript return types (bim-globals.d.ts) and the
 * runtime key translator are DERIVED from a single schema below —
 * adding a field now requires exactly one edit to the schema table
 * instead of the prior four (type string + translator + internal
 * interface + often a test).
 */

import type { NamespaceSchema } from './bridge-schema.js';

// ─── Schema: one source of truth for field mapping + TS types ─────────

/**
 * One attribute of a schedule struct. `tsType` is the TypeScript type
 * as a string, with `?` on the key handled by `optional`. Enum values
 * come through as literal-union tsType (e.g. `"'WORKTIME' | 'ELAPSEDTIME'"`).
 */
interface FieldSpec {
  pascalKey: string;
  camelKey: string;
  tsType: string;
  optional: boolean;
}

function mk(pascal: string, camel: string, tsType: string, optional = true): FieldSpec {
  return { pascalKey: pascal, camelKey: camel, tsType, optional };
}

const TASK_TIME_FIELDS: FieldSpec[] = [
  mk('ScheduleStart',    'scheduleStart',    'string'),
  mk('ScheduleFinish',   'scheduleFinish',   'string'),
  mk('ScheduleDuration', 'scheduleDuration', 'string'),
  mk('ActualStart',      'actualStart',      'string'),
  mk('ActualFinish',     'actualFinish',     'string'),
  mk('ActualDuration',   'actualDuration',   'string'),
  mk('EarlyStart',       'earlyStart',       'string'),
  mk('EarlyFinish',      'earlyFinish',      'string'),
  mk('LateStart',        'lateStart',        'string'),
  mk('LateFinish',       'lateFinish',       'string'),
  mk('FreeFloat',        'freeFloat',        'string'),
  mk('TotalFloat',       'totalFloat',       'string'),
  mk('RemainingTime',    'remainingTime',    'string'),
  mk('StatusTime',       'statusTime',       'string'),
  mk('IsCritical',       'isCritical',       'boolean'),
  mk('Completion',       'completion',       'number'),
  mk('DurationType',     'durationType',     "'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED'"),
];

const TASK_FIELDS: FieldSpec[] = [
  mk('GlobalId',                    'globalId',                     'string', false),
  mk('ExpressId',                   'expressId',                    'number', false),
  mk('Name',                        'name',                         'string', false),
  mk('Description',                 'description',                  'string'),
  mk('ObjectType',                  'objectType',                   'string'),
  mk('Identification',              'identification',               'string'),
  mk('LongDescription',             'longDescription',              'string'),
  mk('Status',                      'status',                       'string'),
  mk('WorkMethod',                  'workMethod',                   'string'),
  mk('IsMilestone',                 'isMilestone',                  'boolean', false),
  mk('Priority',                    'priority',                     'number'),
  mk('PredefinedType',              'predefinedType',               'string'),
  mk('ParentTaskGlobalId',          'parentGlobalId',               'string'),
  mk('ChildTaskGlobalIds',          'childGlobalIds',               'string[]', false),
  mk('AssignedProductExpressIds',   'productExpressIds',            'number[]', false),
  mk('AssignedProductGlobalIds',    'productGlobalIds',             'string[]', false),
  mk('ControllingScheduleGlobalIds','controllingScheduleGlobalIds', 'string[]', false),
  // TaskTime is a nested struct — handled by the schema-to-type helper below.
];

const WORK_SCHEDULE_FIELDS: FieldSpec[] = [
  mk('GlobalId',        'globalId',        'string', false),
  mk('ExpressId',       'expressId',       'number', false),
  mk('Name',            'name',            'string', false),
  mk('Description',     'description',     'string'),
  mk('Identification',  'identification',  'string'),
  mk('CreationDate',    'creationDate',    'string'),
  mk('StartTime',       'startTime',       'string'),
  mk('FinishTime',      'finishTime',      'string'),
  mk('Purpose',         'purpose',         'string'),
  mk('Duration',        'duration',        'string'),
  mk('PredefinedType',  'predefinedType',  'string'),
  mk('Kind',            'kind',            "'WorkSchedule' | 'WorkPlan'", false),
  mk('TaskGlobalIds',   'taskGlobalIds',   'string[]', false),
];

const SEQUENCE_FIELDS: FieldSpec[] = [
  mk('RelatingProcessGlobalId', 'relatingTaskGlobalId', 'string', false),
  mk('RelatedProcessGlobalId',  'relatedTaskGlobalId',  'string', false),
  mk('SequenceType',            'sequenceType',
    "'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'", false),
  mk('UserDefinedSequenceType', 'userDefinedSequenceType', 'string'),
  mk('TimeLagSeconds',          'timeLagSeconds',           'number'),
  mk('TimeLagDuration',         'timeLagDuration',          'string'),
];

// ─── Schema → TS return-type string ────────────────────────────────────

function buildReturnType(fields: FieldSpec[], extra: string = ''): string {
  const parts = fields.map(f => `${f.pascalKey}${f.optional ? '?' : ''}: ${f.tsType}`);
  if (extra) parts.push(extra);
  return `{ ${parts.join('; ')} }`;
}

const TASK_TIME_RETURN = buildReturnType(TASK_TIME_FIELDS);
const TASK_RETURN      = buildReturnType(TASK_FIELDS, `TaskTime?: ${TASK_TIME_RETURN}`);
const WORK_SCHEDULE_RETURN = buildReturnType(WORK_SCHEDULE_FIELDS);
const SEQUENCE_RETURN  = buildReturnType(SEQUENCE_FIELDS);

const DATA_RETURN =
  `{ HasSchedule: boolean;`
  + ` WorkSchedules: Array<${WORK_SCHEDULE_RETURN}>;`
  + ` Tasks: Array<${TASK_RETURN}>;`
  + ` Sequences: Array<${SEQUENCE_RETURN}> }`;

// ─── Schema → runtime translator ──────────────────────────────────────

/**
 * Walk `fields` and produce a new object with PascalCase keys reading
 * from the source's camelCase keys. Any field whose source value is
 * `undefined` is kept as `undefined` (not omitted) so shape checks
 * remain stable across optional-field presence.
 */
function translateByFields(source: Record<string, unknown>, fields: FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.pascalKey] = source[f.camelKey];
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateTaskTime(tt: any): Record<string, unknown> | undefined {
  if (!tt) return undefined;
  return translateByFields(tt, TASK_TIME_FIELDS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateTask(t: any): Record<string, unknown> {
  return { ...translateByFields(t, TASK_FIELDS), TaskTime: translateTaskTime(t.taskTime) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateWorkSchedule(w: any): Record<string, unknown> {
  return translateByFields(w, WORK_SCHEDULE_FIELDS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateSequence(s: any): Record<string, unknown> {
  return translateByFields(s, SEQUENCE_FIELDS);
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

// Exposed for tests — lets us assert TS return shape stays byte-identical
// when we refactor the schema-to-type builder.
export const __schedule_schema_testing = {
  TASK_TIME_FIELDS,
  TASK_FIELDS,
  WORK_SCHEDULE_FIELDS,
  SEQUENCE_FIELDS,
  TASK_TIME_RETURN,
  TASK_RETURN,
  WORK_SCHEDULE_RETURN,
  SEQUENCE_RETURN,
  DATA_RETURN,
  translateTask,
  translateTaskTime,
  translateWorkSchedule,
  translateSequence,
  translateData,
};

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
