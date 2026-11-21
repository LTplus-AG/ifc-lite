/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { restoreSheet } from '@/store/slices/sheetSlice.validation';
import { viewerOperation, emptySchema } from './contract';
import { metadata, idSchema, checkpoint } from './analytics-common';
import { invalidInput, stale, unavailable, parseJsonInput } from './refusals';
const output = { type: 'object', properties: { active: { type: ['object', 'null'] }, enabled: { type: 'boolean' }, templates: { type: 'array' } }, required: ['active', 'enabled', 'templates'], additionalProperties: false };
function inspect() { const s = useViewerStore.getState(); return { active: s.activeSheet, enabled: s.sheetEnabled, templates: s.savedSheetTemplates }; }
export const analyticsDrawingSheetOperations = [
  viewerOperation(metadata('drawing.sheets', 'drawing', 'Read native paper/frame/title-block/revision/scale-bar/north-arrow settings and saved template library.', ['read'], output), emptySchema, inspect),
  viewerOperation(metadata('drawing.createSheet', 'drawing', 'Create and enable the same default native drawing sheet used by the Sheet Setup control. Refuses replacing an existing sheet implicitly.', ['configuration', 'view'], output), emptySchema, (_, c) => { if (useViewerStore.getState().activeSheet) throw unavailable('An active sheet already exists. Edit or clear it explicitly.'); checkpoint(c); c.commit(() => useViewerStore.getState().createSheet()); return inspect(); }),
  viewerOperation<{ expected_json: string; content_json: string; enabled: boolean }>(metadata('drawing.replaceSheet', 'drawing', 'Edit the full structured native paper/frame/title-block/fields/revisions/scale/north-arrow sheet using the same native decoder as saved templates. Invalid subfields normalize to native defaults; inspect the returned candidate. expected_json prevents stale replacement.', ['configuration', 'view'], output), {
    type: 'object', properties: { expected_json: { type: 'string', minLength: 2, maxLength: 500000 }, content_json: { type: 'string', minLength: 2, maxLength: 500000 }, enabled: { type: 'boolean' } }, required: ['expected_json', 'content_json', 'enabled'], additionalProperties: false,
  } satisfies JSONSchemaType<{ expected_json: string; content_json: string; enabled: boolean }>, (i, c) => {
    const s = useViewerStore.getState(); if (JSON.stringify(s.activeSheet) !== JSON.stringify(parseJsonInput(i.expected_json, 'expected_json'))) throw stale('Sheet changed since inspection.');
    const sheet = restoreSheet(parseJsonInput(i.content_json, 'content_json')); if (!sheet) throw invalidInput('refused', 'The native sheet decoder refused this sheet.'); checkpoint(c);
    c.commit(() => { if (!s.activeSheet) s.createSheet(); s.updateSheet(sheet); s.setSheetEnabled(i.enabled); }); return inspect();
  }),
  viewerOperation<{ expected_id: string }>(metadata('drawing.clearSheet', 'drawing', 'Clear the active sheet through native reset behavior after verifying its identity; saved templates remain native library entries.', ['configuration', 'view'], output), {
    type: 'object', properties: { expected_id: idSchema.properties.id }, required: ['expected_id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ expected_id: string }>, (i, c) => { const s = useViewerStore.getState(); if (s.activeSheet?.id !== i.expected_id) throw stale('Active sheet identity changed.'); checkpoint(c); c.commit(s.clearSheet); return inspect(); }),
  viewerOperation<{ name: string }>(metadata('drawing.saveSheetTemplate', 'drawing', 'Save the active sheet as a native template; returns the actual native session template library.', ['configuration'], output), {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['name'], additionalProperties: false,
  } satisfies JSONSchemaType<{ name: string }>, (i, c) => { const s = useViewerStore.getState(); if (!s.activeSheet) throw unavailable('Create a native sheet first.'); checkpoint(c); c.commit(() => s.saveAsTemplate(i.name)); return inspect(); }),
  viewerOperation<{ id: string; action: 'load' | 'delete' }>(metadata('drawing.sheetTemplate', 'drawing', 'Load or delete one exact native saved-sheet template through its existing handler.', ['configuration', 'view'], output), {
    type: 'object', properties: { id: idSchema.properties.id, action: { type: 'string', enum: ['load', 'delete'] } }, required: ['id', 'action'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; action: 'load' | 'delete' }>, (i, c) => { const s = useViewerStore.getState(); if (!s.savedSheetTemplates.some(row => row.id === i.id)) throw invalidInput('unknown-target', 'Unknown native sheet template.'); checkpoint(c); c.commit(() => { if (i.action === 'load') s.loadTemplate(i.id); else s.deleteTemplate(i.id); }); return inspect(); }),
];
