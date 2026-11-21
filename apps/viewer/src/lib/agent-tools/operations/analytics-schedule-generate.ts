/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { mutationPermission } from '@/store/mutation-permission';
import { generateScheduleFromSpatialHierarchy, type GenerateScheduleOptions } from '@/components/viewer/schedule/generate-schedule';
import { generatedExtraction } from '@/lib/schedule/generated-extraction';
import { operation } from './contract';
import { matchesJsonSnapshot, metadata, checkpoint } from './analytics-common';
import { invalidInput, stale, unavailable } from './refusals';
import { mutationRefusal } from './mutation-refusal';
const settings: JSONSchemaType<GenerateScheduleOptions> = {
  type: 'object', properties: {
    strategy: { type: 'string', enum: ['IfcBuildingStorey', 'IfcBuilding', 'IfcElement'] }, startDate: { type: 'string', minLength: 10, maxLength: 40 },
    daysPerGroup: { type: 'number', exclusiveMinimum: 0, maximum: 36500 }, lagDays: { type: 'number', minimum: 0, maximum: 36500 }, order: { type: 'string', enum: ['bottom-up', 'top-down'] },
    skipEmptyGroups: { type: 'boolean' }, linkSequences: { type: 'boolean' }, scheduleName: { type: 'string', minLength: 1, maxLength: 10000 }, predefinedType: { type: 'string', minLength: 1, maxLength: 100 },
    heightTolerance: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 }, elementZSubgroup: { type: 'string', enum: ['none', 'class', 'type', 'name'] },
  }, required: ['strategy', 'startDate', 'daysPerGroup', 'lagDays', 'order', 'skipEmptyGroups', 'linkSequences', 'scheduleName', 'predefinedType', 'heightTolerance', 'elementZSubgroup'], additionalProperties: false,
};
interface Input { settings: GenerateScheduleOptions; work_plan_name: string }
const schema: JSONSchemaType<Input> = { type: 'object', properties: { settings, work_plan_name: { type: 'string', maxLength: 10000 } }, required: ['settings', 'work_plan_name'], additionalProperties: false };
const output = { type: 'object', properties: { extraction: { type: 'object' }, groups: { type: 'integer' }, products: { type: 'integer' }, finish: { type: 'string' }, empty: { type: 'boolean' } }, required: ['extraction', 'groups', 'products', 'finish', 'empty'], additionalProperties: false };
export const analyticsScheduleGenerateOperations = [
  operation(metadata('schedule.generatePreview', 'gantt', 'Generate the native spatial/height-strategy candidate with exact order, dates, duration, lag, linked sequences, subgrouping and optional IfcWorkPlan. Does not change the model.', ['read'], output), schema, (i, c) => {
    if (!Number.isFinite(Date.parse(i.settings.startDate))) throw invalidInput('invalid-value', 'Invalid schedule start date.');
    const model = useViewerStore.getState().models.get(c.model.id);
    const preview = generateScheduleFromSpatialHierarchy(c.model.store, i.settings, { meshes: model?.geometryResult?.meshes ?? [], idOffset: model?.idOffset ?? 0 }, c.model.mutationView());
    return { extraction: generatedExtraction(preview.extraction, preview.empty ? null : i.work_plan_name.trim() || null), groups: preview.groupCount, products: preview.productCount, finish: preview.finishDate, empty: preview.empty };
  }),
  operation<Input & { expected_json: string }>({ ...metadata('schedule.generate', 'gantt', 'Apply the native Generate dialog workflow against an exact inspected timeline snapshot. Replaces its pending schedule and enables native construction animation; preserves native edit/role locks.', ['model', 'view'], {
    type: 'object', properties: { groups: { type: 'integer' }, products: { type: 'integer' }, finish: { type: 'string' }, empty: { type: 'boolean' } },
    required: ['groups', 'products', 'finish', 'empty'], additionalProperties: false,
  }), policy: { model: 'native-reviewed' } }, {
    type: 'object', properties: { settings, work_plan_name: { type: 'string', maxLength: 10000 }, expected_json: { type: 'string', minLength: 2, maxLength: 1000000 } }, required: ['settings', 'work_plan_name', 'expected_json'], additionalProperties: false,
  } satisfies JSONSchemaType<Input & { expected_json: string }>, (i, c) => {
    const s = useViewerStore.getState(); const permission = mutationPermission(s, c.model.id); if (!permission.allowed) throw mutationRefusal(permission.reason, c.model.id);
    if (s.scheduleTransaction.active) throw unavailable('Finish the current Gantt edit before generating tasks.');
    if (s.scheduleData && s.scheduleSourceModelId !== c.model.id) throw invalidInput('wrong-target', 'The timeline belongs to a different model.');
    if (!matchesJsonSnapshot(s.scheduleData, i.expected_json)) throw stale('Timeline changed since inspection.');
    if (!Number.isFinite(Date.parse(i.settings.startDate))) throw invalidInput('invalid-value', 'Invalid schedule start date.');
    const model = s.models.get(c.model.id);
    const preview = generateScheduleFromSpatialHierarchy(c.model.store, i.settings, { meshes: model?.geometryResult?.meshes ?? [], idOffset: model?.idOffset ?? 0 }, c.model.mutationView());
    if (preview.empty || !preview.groupCount) throw unavailable('The native generator found no groups/products for this strategy.');
    const extraction = generatedExtraction(preview.extraction, i.work_plan_name.trim() || null); checkpoint(c);
    c.commit(() => { s.commitGeneratedSchedule(extraction, c.model.id); s.setAnimationEnabled(true); });
    return { groups: preview.groupCount, products: preview.productCount, finish: preview.finishDate, empty: false };
  }),
];
