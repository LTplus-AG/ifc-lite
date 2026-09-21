/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Document presets (#4594): a blank page, and a coordination cover sheet
 * that shows what bindings do — every value on it comes from the model.
 */
import { newChartSpec } from '../charts/presets.js';
import { freshBlockId, freshDocumentId } from './persistence.js';
import { DOCUMENT_VERSION, type DocumentBlock, type DocumentSpec, type TableBlock, type TableColumnId, type TableRowsMode, type TextBlock } from './types.js';

const text = (style: TextBlock['style'], value: string): TextBlock => ({ kind: 'text', id: freshBlockId(), style, text: value });

export function blankDocument(): DocumentSpec {
  return {
    version: DOCUMENT_VERSION,
    id: freshDocumentId(),
    name: 'Untitled document',
    page: { size: 'A4', orientation: 'portrait' },
    blocks: [text('title', '{IfcProject.Name}'), text('body', '')],
  };
}

export function coverSheetDocument(): DocumentSpec {
  const blocks: DocumentBlock[] = [
    text('title', '{IfcProject.LongName}'),
    text('body', 'Project {IfcProject.Name} · Model {Model.Name} ({Model.Schema}) · {Model.Elements} elements'),
    text('heading', 'Site and building'),
    text('body', 'Site: {IfcSite.Name}\nBuilding: {IfcBuilding.Name}\nStoreys: {Count[IfcBuildingStorey]} · Walls: {Count[IfcWall]} · Doors: {Count[IfcDoor]} · Windows: {Count[IfcWindow]}'),
    text('heading', 'Elements by type'),
    { kind: 'chart', id: freshBlockId(), chart: newChartSpec(), snapshot: true },
    text('body', 'Issued {Today}.'),
  ];
  return { version: DOCUMENT_VERSION, id: freshDocumentId(), name: 'Cover sheet', page: { size: 'A4', orientation: 'portrait' }, blocks };
}

/** Default columns for a fresh table block, per rows mode (#5138): entity rows lead with what to
 *  triage an element by, set rows with what identifies the group and its violation. */
export const DEFAULT_TABLE_COLUMNS: Record<TableRowsMode, TableColumnId[]> = {
  failed: ['rule', 'result', 'entityType', 'name', 'globalId', 'reason'],
  passed: ['rule', 'result', 'entityType', 'name', 'globalId'],
  all: ['rule', 'result', 'entityType', 'name', 'globalId'],
  sets: ['rule', 'result', 'set', 'members', 'actual', 'expected', 'reason'],
};

/**
 * Append a validation-results table block to `document` (#5138): the helper
 * both the "Insert table" menu entry and, from a different panel, the
 * results panel's "Insert results table" affordance (PR 4) call — a pure
 * function so either caller can pass it straight to `upsertDocument`.
 */
export function insertValidationTableBlock(document: DocumentSpec, options: { ruleId?: string; rows?: TableRowsMode } = {}): DocumentSpec {
  const rows = options.rows ?? 'failed';
  const block: TableBlock = {
    kind: 'table',
    id: freshBlockId(),
    source: { kind: 'validation', ruleId: options.ruleId, rows },
    columns: DEFAULT_TABLE_COLUMNS[rows],
  };
  return { ...document, blocks: [...document.blocks, block] };
}

export const DOCUMENT_PRESETS: ReadonlyArray<{ name: string; create: () => DocumentSpec }> = [
  { name: 'Blank page', create: blankDocument },
  { name: 'Cover sheet', create: coverSheetDocument },
];

/** Binding paths offered by the "Insert field" picker, with what they read. */
export const FIELD_SUGGESTIONS: ReadonlyArray<{ path: string; label: string }> = [
  { path: 'IfcProject.Name', label: 'Project name' },
  { path: 'IfcProject.LongName', label: 'Project long name' },
  { path: 'IfcProject.Description', label: 'Project description' },
  { path: 'IfcSite.Name', label: 'Site name' },
  { path: 'IfcBuilding.Name', label: 'Building name' },
  { path: 'IfcBuildingStorey[1].Name', label: 'First storey name' },
  { path: 'Model.Name', label: 'Model file name' },
  { path: 'Model.Schema', label: 'IFC schema' },
  { path: 'Model.Elements', label: 'Element count' },
  { path: 'Count[IfcWall]', label: 'Number of walls' },
  { path: 'Count[IfcSpace]', label: 'Number of spaces' },
  { path: 'Today', label: "Today's date" },
];
