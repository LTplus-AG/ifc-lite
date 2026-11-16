/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { extractScheduleOnDemand } from '@ifc-lite/parser';
import { createEffectiveRecordOverlay } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import { entityExists } from '../refs';
import { importScheduleFromText } from '@/components/viewer/schedule/import';
import { shouldConfirmClobber } from '@/components/viewer/schedule/useScheduleFileImport';
import { operation, emptySchema, referenceSchema } from './contract';
import type { OperationContext } from './contract';
import { metadata, checkpoint, idSchema } from './analytics-common';
const output = { type: 'object', properties: { model_id: { type: ['string', 'null'] }, data: { type: ['object', 'null'] }, edited: { type: 'boolean' }, undo: { type: 'integer' }, redo: { type: 'integer' } }, required: ['model_id', 'data', 'edited', 'undo', 'redo'], additionalProperties: false };
function inspect() { const s = useViewerStore.getState(); return { model_id: s.scheduleSourceModelId, data: s.scheduleData, edited: s.scheduleIsEdited, undo: s.scheduleUndoStack.length, redo: s.scheduleRedoStack.length }; }
function native(c: OperationContext) {
  const s = useViewerStore.getState(); const denial = mutationDenial(s, c.model.id); if (denial) throw new Error(denial);
  if (s.scheduleSourceModelId !== c.model.id || !s.scheduleData) throw new Error('Initialize the native timeline for this exact model first.');
  checkpoint(c); return s;
}
function task(c: OperationContext, id: string) { const s = native(c); const row = s.scheduleData?.tasks.find(item => item.globalId === id); if (!row) throw new Error('Unknown task in the target model timeline.'); return row; }
const write = (id: string, description: string) => ({ ...metadata(id, 'gantt', description, ['model'], output), policy: { model: 'native-reviewed' as const } });
export const analyticsScheduleEditOperations = [
  operation(metadata('schedule.nativeData', 'gantt', 'Read the actual Gantt edit snapshot and its own native undo/redo history; unlike STEP extraction this includes generated and edited tasks.', ['read'], output), emptySchema, inspect),
  operation(metadata('schedule.initialize', 'gantt', 'Initialize the native timeline for the explicitly targeted model using the effective parser extraction. Refuses replacing an edited timeline.', ['configuration'], output), emptySchema, (_, c) => {
    const s = useViewerStore.getState(); if (s.scheduleIsEdited) throw new Error('Save or discard the edited native timeline before initializing another.');
    const view = c.model.mutationView(); const data = extractScheduleOnDemand(c.model.store, view ? { overlay: createEffectiveRecordOverlay(view, c.model.store) } : undefined);
    if (s.activeModelId !== c.model.id) throw new Error('Activate the target model before initializing its native timeline.');
    checkpoint(c); c.commit(() => s.setScheduleData(data)); return inspect();
  }),
  operation<{ id: string; expected_name: string; Name: string; Identification: string; IsMilestone: boolean }>(write('schedule.updateTask', 'Update native IfcTask identity/milestone fields as one Gantt transaction with an expected Name conflict check and native edit/role locks.'), {
    type: 'object', properties: { id: idSchema.properties.id, expected_name: { type: 'string', maxLength: 10000 }, Name: { type: 'string', minLength: 1, maxLength: 10000 }, Identification: { type: 'string', maxLength: 1000 }, IsMilestone: { type: 'boolean' } }, required: ['id', 'expected_name', 'Name', 'Identification', 'IsMilestone'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_name: string; Name: string; Identification: string; IsMilestone: boolean }>, (i, c) => {
    if ((task(c, i.id).name ?? '') !== i.expected_name) throw new Error('Task Name changed since inspection.');
    c.commit(() => useViewerStore.getState().updateTask(i.id, { name: i.Name, identification: i.Identification, isMilestone: i.IsMilestone })); return inspect();
  }),
  operation<{ id: string; ScheduleStart: string; ScheduleFinish: string; expected_start: string; expected_finish: string }>(write('schedule.updateTaskTime', 'Update native IfcTaskTime dates and recompute duration as one undo step; validate dates and expected existing values before writing.'), {
    type: 'object', properties: { id: idSchema.properties.id, ScheduleStart: { type: 'string', minLength: 10, maxLength: 40 }, ScheduleFinish: { type: 'string', minLength: 10, maxLength: 40 }, expected_start: { type: 'string', maxLength: 40 }, expected_finish: { type: 'string', maxLength: 40 } }, required: ['id', 'ScheduleStart', 'ScheduleFinish', 'expected_start', 'expected_finish'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; ScheduleStart: string; ScheduleFinish: string; expected_start: string; expected_finish: string }>, (i, c) => {
    const row = task(c, i.id);
    if ((row.taskTime?.scheduleStart ?? '') !== i.expected_start || (row.taskTime?.scheduleFinish ?? '') !== i.expected_finish) throw new Error('Task dates changed since inspection.');
    const start = Date.parse(i.ScheduleStart); const finish = Date.parse(i.ScheduleFinish);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) throw new Error('Supply valid ISO dates with finish at or after start.');
    c.commit(() => useViewerStore.getState().updateTaskTime(i.id, { scheduleStart: i.ScheduleStart, scheduleFinish: i.ScheduleFinish })); return inspect();
  }),
  operation<{ Name: string; duration_days: number; after_id: string }>(write('schedule.addTask', 'Create one native task and its timing in the exact target-model Gantt snapshot as one undo step.'), {
    type: 'object', properties: { Name: { type: 'string', minLength: 1, maxLength: 10000 }, duration_days: { type: 'number', minimum: 0, maximum: 36500 }, after_id: { type: 'string', maxLength: 200 } }, required: ['Name', 'duration_days', 'after_id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ Name: string; duration_days: number; after_id: string }>, (i, c) => {
    const s = native(c); if (i.after_id) task(c, i.after_id);
    c.commit(() => s.addTask({ nameDefault: i.Name, durationDays: i.duration_days, ...(i.after_id ? { afterGlobalId: i.after_id } : {}) })); return inspect();
  }),
  operation<{ id: string; expected_json: string }>(write('schedule.deleteTask', 'Delete a native task and its native dependent subtree/sequence cleanup with a complete expected task snapshot conflict check.'), {
    type: 'object', properties: { id: idSchema.properties.id, expected_json: { type: 'string', minLength: 2, maxLength: 500000 } }, required: ['id', 'expected_json'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_json: string }>, (i, c) => {
    if (JSON.stringify(task(c, i.id)) !== JSON.stringify(JSON.parse(i.expected_json))) throw new Error('Task changed since inspection.');
    c.commit(() => useViewerStore.getState().deleteTask(i.id)); return inspect();
  }),
  operation<{ id: string; express_ids: number[]; action: 'assign' | 'unassign' }>(write('schedule.assignProducts', 'Assign or unassign model-qualified IFC product IDs through the native Gantt membership handler and canonical global-ID adapter.'), {
    type: 'object', properties: { id: idSchema.properties.id, express_ids: referenceSchema.properties.express_ids, action: { type: 'string', enum: ['assign', 'unassign'] } }, required: ['id', 'express_ids', 'action'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; express_ids: number[]; action: 'assign' | 'unassign' }>, (i, c) => {
    task(c, i.id); if (i.express_ids.some(id => !entityExists(c.model, id))) throw new Error('An assigned entity does not exist in the target model.');
    const s = useViewerStore.getState(); const ids = i.express_ids.map(id => s.toGlobalId(c.model.id, id));
    c.commit(() => { if (i.action === 'assign') s.assignProductsToTask(i.id, ids); else s.unassignProductsFromTask(i.id, ids); }); return inspect();
  }),
  operation<{ action: 'undo' | 'redo' }>(write('schedule.history', 'Use the Gantt native history while preserving its source-model attribution and edit locks.'), {
    type: 'object', properties: { action: { type: 'string', enum: ['undo', 'redo'] } }, required: ['action'], additionalProperties: false,
  } satisfies JSONSchemaType<{ action: 'undo' | 'redo' }>, (i, c) => { const s = native(c); if ((i.action === 'undo' ? s.scheduleUndoStack : s.scheduleRedoStack).length === 0) throw new Error('Native schedule history is empty.'); c.commit(() => { if (i.action === 'undo') s.undoScheduleEdit(); else s.redoScheduleEdit(); }); return inspect(); }),
  operation<{ text: string; format: 'csv' | 'mspdi' }>({ ...write('schedule.import', 'Import native CSV/MSPDI schedule text through the same parser/commit as the UI. Refuses clobbering an edited or source-backed schedule requiring the existing native confirmation.'), outputSchema: { ...output, properties: { ...output.properties, warnings: { type: 'array' } } } }, {
    type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 1000000 }, format: { type: 'string', enum: ['csv', 'mspdi'] } }, required: ['text', 'format'], additionalProperties: false,
  } satisfies JSONSchemaType<{ text: string; format: 'csv' | 'mspdi' }>, (i, c) => {
    const s = native(c); if (shouldConfirmClobber(s.scheduleData, s.scheduleIsEdited)) throw new Error('Native schedule replacement requires the existing clobber confirmation. Save or clear the current schedule in the native workflow first.');
    const result = importScheduleFromText(i.format === 'csv' ? 'schedule.csv' : 'schedule.xml', i.text); checkpoint(c);
    c.commit(() => s.commitGeneratedSchedule(result.extraction, c.model.id)); return { ...inspect(), warnings: result.warnings };
  }),
];
