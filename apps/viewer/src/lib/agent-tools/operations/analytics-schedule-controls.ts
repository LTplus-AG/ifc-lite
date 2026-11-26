/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { mutationPermission } from '@/store/mutation-permission';
import type { AnimationSettings } from '@/components/viewer/schedule/schedule-animator';
import { operation, viewerOperation, emptySchema } from './contract';
import { matchesJsonSnapshot, metadata, checkpoint, idSchema } from './analytics-common';
import { invalidInput, stale, unavailable } from './refusals';
import { mutationRefusal } from './mutation-refusal';
import { requireModelSchedule } from './analytics-schedule-common';
const rgba: JSONSchemaType<[number, number, number, number]> = { type: 'array', items: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'number', minimum: 0, maximum: 1 }, { type: 'number', minimum: 0, maximum: 1 }, { type: 'number', minimum: 0, maximum: 1 }], minItems: 4, maxItems: 4 };
const paletteProperties = { ATTENDANCE: rgba, CONSTRUCTION: rgba, DEMOLITION: rgba, DISMANTLE: rgba, DISPOSAL: rgba, INSTALLATION: rgba, LOGISTIC: rgba, MAINTENANCE: rgba, MOVE: rgba, OPERATION: rgba, REMOVAL: rgba, RENOVATION: rgba, USERDEFINED: rgba, NOTDEFINED: rgba, PREPARATION: rgba, COMPLETED: rgba };
const paletteRequired: (keyof typeof paletteProperties)[] = ['ATTENDANCE', 'CONSTRUCTION', 'DEMOLITION', 'DISMANTLE', 'DISPOSAL', 'INSTALLATION', 'LOGISTIC', 'MAINTENANCE', 'MOVE', 'OPERATION', 'REMOVAL', 'RENOVATION', 'USERDEFINED', 'NOTDEFINED', 'PREPARATION', 'COMPLETED'];
const settingsSchema: JSONSchemaType<AnimationSettings> = {
  type: 'object', properties: {
    preparationDays: { type: 'number', minimum: 0, maximum: 36500 }, rampInFraction: { type: 'number', minimum: 0, maximum: 0.5 }, fadeOutFraction: { type: 'number', minimum: 0, maximum: 0.5 }, showPreparationGhost: { type: 'boolean' }, colorizeByTaskType: { type: 'boolean' }, paletteIntensity: { type: 'number', minimum: 0, maximum: 1 }, animateDemolition: { type: 'boolean' }, hideBeforePreparation: { type: 'boolean' }, hideUntaskedProducts: { type: 'boolean' }, showCompletedTint: { type: 'boolean' }, palette: { type: 'object', properties: paletteProperties, required: paletteRequired, additionalProperties: false },
  }, required: ['preparationDays', 'rampInFraction', 'fadeOutFraction', 'showPreparationGhost', 'colorizeByTaskType', 'paletteIntensity', 'animateDemolition', 'hideBeforePreparation', 'hideUntaskedProducts', 'showCompletedTint', 'palette'], additionalProperties: false,
};
const output = { type: 'object', properties: { settings: settingsSchema }, required: ['settings'], additionalProperties: false };
export const analyticsScheduleControlOperations = [
  viewerOperation(metadata('schedule.animationSettings', 'gantt', 'Read all native animation style flags, ramps, ghost/tint settings and the complete RGBA task palette.', ['read'], output), emptySchema, () => ({ settings: useViewerStore.getState().animationSettings })),
  viewerOperation<{ expected_json: string; settings: AnimationSettings }>(metadata('schedule.configureAnimation', 'gantt', 'Set every native animation-popover style/palette control through the shared playback setter, with an expected settings conflict check. Full palette accepts only exact native task keys and finite normalized RGBA.', ['configuration', 'view'], output), {
    type: 'object', properties: { expected_json: { type: 'string', minLength: 2, maxLength: 30000 }, settings: settingsSchema }, required: ['expected_json', 'settings'], additionalProperties: false,
  } satisfies JSONSchemaType<{ expected_json: string; settings: AnimationSettings }>, (i, c) => { const s = useViewerStore.getState(); if (!matchesJsonSnapshot(s.animationSettings, i.expected_json)) throw stale('Native animation settings changed since inspection.'); checkpoint(c); c.commit(() => s.setAnimationSettings(i.settings)); return { settings: useViewerStore.getState().animationSettings }; }),
  operation<{ id: string; new_index: number; expected_order: string[] }>({ ...metadata('schedule.moveTask', 'gantt', 'Reorder a task using the native Gantt drag-drop handler and undo stack. Verify the complete previous task order and exact source model before writing.', ['model'], { type: 'object', properties: { order: { type: 'array', items: { type: 'string' } } }, required: ['order'], additionalProperties: false }), policy: { model: 'native-reviewed' } }, {
    type: 'object', properties: { id: idSchema.properties.id, new_index: { type: 'integer', minimum: 0 }, expected_order: { type: 'array', maxItems: 100000, items: { type: 'string' } } }, required: ['id', 'new_index', 'expected_order'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; new_index: number; expected_order: string[] }>, (i, c) => {
    const s = useViewerStore.getState(); const permission = mutationPermission(s, c.model.id); if (!permission.allowed) throw mutationRefusal(permission.reason, c.model.id);
    const schedule = requireModelSchedule(s, c.model.id);
    if (s.scheduleTransaction.active) throw unavailable('Finish the current Gantt edit before reordering tasks.');
    const order = schedule.tasks.map(row => row.globalId);
    if (JSON.stringify(order) !== JSON.stringify(i.expected_order)) throw stale('Task order changed since inspection.');
    if (!order.includes(i.id) || i.new_index >= order.length) throw invalidInput('invalid-value', 'Reorder target or destination is out of range.');
    checkpoint(c); c.commit(() => s.moveTask(i.id, i.new_index)); return { order: useViewerStore.getState().scheduleData?.tasks.map(row => row.globalId) ?? [] };
  }),
];
