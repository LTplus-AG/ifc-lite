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
 */

import type { NamespaceSchema } from './bridge-schema.js';

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
        tsReturn: "{ hasSchedule: boolean; workSchedules: Array<{ globalId: string; name: string; startTime?: string; finishTime?: string; predefinedType?: string; kind: 'WorkSchedule' | 'WorkPlan'; taskGlobalIds: string[] }>; tasks: Array<{ globalId: string; expressId: number; name: string; isMilestone: boolean; predefinedType?: string; parentGlobalId?: string; childGlobalIds: string[]; productExpressIds: number[]; productGlobalIds: string[]; controllingScheduleGlobalIds: string[]; taskTime?: { scheduleStart?: string; scheduleFinish?: string; scheduleDuration?: string; actualStart?: string; actualFinish?: string; isCritical?: boolean; completion?: number } }>; sequences: Array<{ relatingTaskGlobalId: string; relatedTaskGlobalId: string; sequenceType: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; timeLagSeconds?: number; timeLagDuration?: string }> }",
        call: (sdk, args) => sdk.schedule.data(args[0] as string | undefined),
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
        tsReturn: "Array<{ globalId: string; expressId: number; name: string; isMilestone: boolean; predefinedType?: string; parentGlobalId?: string; childGlobalIds: string[]; productExpressIds: number[]; productGlobalIds: string[]; controllingScheduleGlobalIds: string[]; taskTime?: { scheduleStart?: string; scheduleFinish?: string; scheduleDuration?: string; isCritical?: boolean; completion?: number } }>",
        call: (sdk, args) => sdk.schedule.tasks(args[0] as string | undefined),
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
        tsReturn: "Array<{ globalId: string; expressId: number; name: string; kind: 'WorkSchedule' | 'WorkPlan'; startTime?: string; finishTime?: string; predefinedType?: string; taskGlobalIds: string[] }>",
        call: (sdk, args) => sdk.schedule.workSchedules(args[0] as string | undefined),
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
        tsReturn: "Array<{ relatingTaskGlobalId: string; relatedTaskGlobalId: string; sequenceType: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; timeLagSeconds?: number; timeLagDuration?: string }>",
        call: (sdk, args) => sdk.schedule.sequences(args[0] as string | undefined),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List task dependency edges to understand sequencing or detect missing links.',
        },
      },
    ],
  };
}
