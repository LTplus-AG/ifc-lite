/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schemas for the IFC 4D / scheduling `bim.create.*` methods.
 *
 * Kept in its own module so `bridge-create.ts` stays under the ~400-line
 * guideline. The canonical `addIfcRel*` methods and their ergonomic aliases
 * share the same `(number, number, number[])` shape, so they're generated
 * through a single `relAssign()` factory instead of 7 copies of the same
 * `methods.push({...})` block.
 */

import type { IfcCreator } from '@ifc-lite/sdk';
import type { MethodSchema, MethodSemanticContract } from './bridge-schema.js';
import { creatorRegistry } from './creator-registry.js';

/** Names of scheduling methods on IfcCreator that take a `(number[], ...)` shape. */
type RelAssignMethodName =
  | 'addIfcRelAssignsToControl'
  | 'addIfcRelAssignsToProcess'
  | 'addIfcRelNests'
  | 'assignTasksToWorkSchedule'
  | 'assignSchedulesToWorkPlan'
  | 'assignProductsToTask'
  | 'nestTasks';

/**
 * Build a single `(number, number, number[]) → number` schedule-relationship
 * schema entry. Collapses the seven relationship/alias entries into one-liners.
 */
function relAssign(
  name: RelAssignMethodName,
  paramNames: readonly [string, string, string],
  doc: string,
  llm: MethodSemanticContract,
): MethodSchema {
  return {
    name,
    doc,
    args: ['number', 'number', 'dump'],
    paramNames: [...paramNames],
    tsParamTypes: [undefined, undefined, 'number[]'],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number) as IfcCreator;
      const fn = (creator as unknown as Record<string, (a: number, b: number[]) => number>)[name];
      return fn.call(creator, args[1] as number, args[2] as number[]);
    },
    returns: 'value',
    llmSemantics: llm,
  };
}

/**
 * Names of the scheduling methods that must live in `SPECIAL_METHODS` in
 * `bridge-create.ts` — exposed so the two files stay in sync.
 */
export const SCHEDULE_SPECIAL_METHOD_NAMES = [
  'addIfcWorkSchedule', 'addIfcWorkPlan', 'addIfcTask', 'addIfcRelSequence',
  'addIfcRelAssignsToControl', 'addIfcRelAssignsToProcess', 'addIfcRelNests',
  'assignTasksToWorkSchedule', 'assignSchedulesToWorkPlan',
  'assignProductsToTask', 'nestTasks',
] as const;

/**
 * Build every IFC 4D / scheduling method schema. Consumed by
 * `buildCreateMethods()` via `methods.push(...buildScheduleMethods())`.
 */
export function buildScheduleMethods(): MethodSchema[] {
  const methods: MethodSchema[] = [];

  // ── Entity-creating schemas (varied shapes, written out explicitly) ──

  methods.push({
    name: 'addIfcWorkSchedule',
    doc: 'Create an IfcWorkSchedule. Returns schedule expressId.',
    args: ['number', 'dump'],
    paramNames: ['handle', 'params'],
    tsParamTypes: [undefined, "{ Name: string; StartTime: string; FinishTime?: string; CreationDate?: string; Description?: string; Identification?: string; Purpose?: string; Duration?: string; TotalFloat?: string; PredefinedType?: 'ACTUAL' | 'BASELINE' | 'PLANNED' | 'USERDEFINED' | 'NOTDEFINED' }"],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
      return creator.addIfcWorkSchedule(args[1] as Parameters<typeof creator.addIfcWorkSchedule>[0]);
    },
    returns: 'value',
    llmSemantics: {
      taskTags: ['create'],
      requiredKeys: ['Name', 'StartTime'],
      useWhen: 'Create a top-level work schedule container before adding tasks. StartTime is an ISO datetime (e.g. "2024-05-01T08:00:00").',
    },
  });

  methods.push({
    name: 'addIfcWorkPlan',
    doc: 'Create an IfcWorkPlan (groups multiple schedules). Returns plan expressId.',
    args: ['number', 'dump'],
    paramNames: ['handle', 'params'],
    tsParamTypes: [undefined, "{ Name: string; StartTime: string; FinishTime?: string; CreationDate?: string; Description?: string; Identification?: string; Purpose?: string; Duration?: string; PredefinedType?: 'ACTUAL' | 'BASELINE' | 'PLANNED' | 'USERDEFINED' | 'NOTDEFINED' }"],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
      return creator.addIfcWorkPlan(args[1] as Parameters<typeof creator.addIfcWorkPlan>[0]);
    },
    returns: 'value',
    llmSemantics: {
      taskTags: ['create'],
      requiredKeys: ['Name', 'StartTime'],
      useWhen: 'Use when the user needs multiple schedules grouped under a single plan. Otherwise prefer addIfcWorkSchedule.',
    },
  });

  methods.push({
    name: 'addIfcTask',
    doc: 'Create an IfcTask. Provide ScheduleStart + ScheduleFinish (or ScheduleDuration) for time fields. Returns task expressId.',
    args: ['number', 'dump'],
    paramNames: ['handle', 'params'],
    tsParamTypes: [undefined, "{ Name: string; Description?: string; Identification?: string; LongDescription?: string; Status?: string; WorkMethod?: string; IsMilestone?: boolean; Priority?: number; ObjectType?: string; ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string; ActualStart?: string; ActualFinish?: string; ActualDuration?: string; EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string; FreeFloat?: string; TotalFloat?: string; IsCritical?: boolean; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED'; Completion?: number; PredefinedType?: 'ATTENDANCE' | 'CONSTRUCTION' | 'DEMOLITION' | 'DISMANTLE' | 'DISPOSAL' | 'INSTALLATION' | 'LOGISTIC' | 'MAINTENANCE' | 'MOVE' | 'OPERATION' | 'REMOVAL' | 'RENOVATION' | 'USERDEFINED' | 'NOTDEFINED' | 'ADJUSTMENT' | 'CALIBRATION' | 'EMERGENCY' | 'INSPECTION' | 'SAFETY' | 'SHUTDOWN' | 'STARTUP' | 'TESTING' | 'TROUBLESHOOTING' }"],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
      return creator.addIfcTask(args[1] as Parameters<typeof creator.addIfcTask>[0]);
    },
    returns: 'value',
    llmSemantics: {
      taskTags: ['create'],
      requiredKeys: ['Name'],
      useWhen: 'Create a task (activity). Pair with addIfcRelAssignsToControl(...) to put it under a schedule and addIfcRelAssignsToProcess(...) to bind products that reveal during its window.',
      cautions: [
        'Dates are ISO 8601 datetimes; durations are ISO 8601 (e.g. "P5D", "PT8H").',
        'Use IsMilestone=true for zero-duration events like handovers.',
        'PredefinedType is an enum — prefer CONSTRUCTION, INSTALLATION, DEMOLITION, RENOVATION over free text.',
      ],
    },
  });

  methods.push({
    name: 'addIfcRelSequence',
    doc: 'Link predecessor → successor tasks via IfcRelSequence. Returns relationship expressId.',
    args: ['number', 'number', 'number', 'dump'],
    paramNames: ['handle', 'predecessorTaskId', 'successorTaskId', 'params'],
    tsParamTypes: [undefined, undefined, undefined, "{ SequenceType?: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; TimeLag?: string; LagDurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED'; UserDefinedSequenceType?: string }"],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
      return creator.addIfcRelSequence(
        args[1] as number,
        args[2] as number,
        (args[3] ?? {}) as Parameters<typeof creator.addIfcRelSequence>[2],
      );
    },
    returns: 'value',
    llmSemantics: {
      taskTags: ['create'],
      useWhen: 'Model a dependency between two tasks. SequenceType defaults to FINISH_START. Pass TimeLag as an ISO 8601 duration string like "P2D".',
    },
  });

  // ── Canonical IfcRel* helpers + ergonomic aliases (same shape, factory) ──

  methods.push(relAssign(
    'addIfcRelAssignsToControl',
    ['handle', 'relatingControlId', 'relatedObjectIds'],
    'Canonical IfcRelAssignsToControl — bind IfcObjectDefinitions (tasks or sub-schedules) to an IfcControl (IfcWorkSchedule/IfcWorkPlan). Returns relationship expressId.',
    {
      taskTags: ['create'],
      useWhen: 'Canonical IFC name. Prefer this over assignTasksToWorkSchedule when writing IFC-native scripts.',
    },
  ));

  methods.push(relAssign(
    'addIfcRelAssignsToProcess',
    ['handle', 'relatingProcessId', 'relatedObjectIds'],
    'Canonical IfcRelAssignsToProcess — bind products to an IfcProcess (task). Drives the 4D Gantt animation. Returns relationship expressId.',
    {
      taskTags: ['create'],
      useWhen: 'Canonical IFC name for binding products to a task. Use instead of assignProductsToTask for schema-compliant scripts.',
    },
  ));

  methods.push(relAssign(
    'addIfcRelNests',
    ['handle', 'relatingObjectId', 'relatedObjectIds'],
    'Canonical IfcRelNests — nest child objects under a parent (task WBS hierarchy). Returns relationship expressId.',
    {
      taskTags: ['create'],
      useWhen: 'Canonical IFC name for task nesting. Use instead of nestTasks for schema-compliant scripts.',
    },
  ));

  methods.push(relAssign(
    'assignTasksToWorkSchedule',
    ['handle', 'scheduleId', 'taskIds'],
    'Ergonomic alias for addIfcRelAssignsToControl — assign tasks to a work schedule. Returns relationship expressId.',
    {
      taskTags: ['create'],
      useWhen: 'Ergonomic alias — delegates to addIfcRelAssignsToControl.',
    },
  ));

  methods.push(relAssign(
    'assignSchedulesToWorkPlan',
    ['handle', 'planId', 'scheduleIds'],
    'Ergonomic alias for addIfcRelAssignsToControl — attach work schedules to a parent IfcWorkPlan. Returns relationship expressId.',
    {
      taskTags: ['create'],
      useWhen: 'Group schedules under a plan — only needed for multi-schedule projects.',
    },
  ));

  methods.push(relAssign(
    'assignProductsToTask',
    ['handle', 'taskId', 'productIds'],
    'Ergonomic alias for addIfcRelAssignsToProcess — bind products to a task. Returns relationship expressId.',
    {
      taskTags: ['create'],
      useWhen: 'Ergonomic alias — delegates to addIfcRelAssignsToProcess.',
    },
  ));

  methods.push(relAssign(
    'nestTasks',
    ['handle', 'parentTaskId', 'childTaskIds'],
    'Ergonomic alias for addIfcRelNests — nest child tasks under a summary parent. Returns relationship expressId.',
    {
      taskTags: ['create'],
      useWhen: 'Ergonomic alias — delegates to addIfcRelNests.',
    },
  ));

  return methods;
}
