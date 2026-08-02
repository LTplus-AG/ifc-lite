/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Editing a list column's definition IN PLACE (issue #1591 follow-up).
 *
 * Before this, a column's definition (set / property name, or a `/regex/`
 * pattern) could not be changed once added — the user had to delete the column
 * and add a new one, losing its position and any table width / sort state that
 * is keyed by column id. These pure helpers back the pencil-edit affordance in
 * the list builder: they replace a column IN PLACE, keeping both its array
 * position (column order) and its `id` (so the results table's per-id width and
 * index-based sort survive the edit).
 */

import type { ColumnDefinition } from '@ifc-lite/lists';

/** A column whose free-text definition (set + property, incl. `/regex/`) is
 *  editable. Built-in attribute / material / classification / spatial / model
 *  columns are picked by chip and carry no free-text formula to edit. */
export function isEditableColumn(col: ColumnDefinition): boolean {
  return col.source === 'property' || col.source === 'quantity';
}

/** The editor's working fields — a property/quantity set + a property name. */
export interface ColumnDraft {
  source: 'property' | 'quantity';
  setName: string;
  propName: string;
}

/** Seed the editor's fields from an existing column. */
export function draftFromColumn(col: ColumnDefinition): ColumnDraft {
  return {
    source: col.source === 'quantity' ? 'quantity' : 'property',
    setName: col.psetName ?? '',
    propName: col.propertyName,
  };
}

/**
 * A content-derived identity for a property / quantity column DEFINITION:
 * source + set + property, whitespace-collapsed (mirrors the add-path
 * `customColumnId` slug, minus its `custom-` prefix). Two columns collide when
 * their definitions resolve the same value, regardless of their `id` — so a
 * duplicate check can catch an in-place edit that changed a column's definition
 * while (deliberately) keeping its id stable. Case-preserving: `/A/` and `/a/`
 * are distinct regex sets and must not fold together.
 */
export function columnDefKey(
  col: Pick<ColumnDefinition, 'source' | 'psetName' | 'propertyName'>,
): string {
  return `${col.source}-${(col.psetName ?? '').trim()}-${col.propertyName.trim()}`.replace(/\s+/g, '-');
}

/** `columnDefKey` for an in-flight editor draft (see `columnDefKey`). */
export function draftDefKey(draft: ColumnDraft): string {
  return `${draft.source}-${draft.setName.trim()}-${draft.propName.trim()}`.replace(/\s+/g, '-');
}

/**
 * Build the edited column from the editor draft, PRESERVING the original id so
 * the results table's width (keyed by id) and sort (by column index) survive.
 *
 * The label tracks the property name, matching how columns are added — EXCEPT
 * when `previous` carries a deliberate label override (a label that differs
 * from the auto-label its own definition would generate, e.g. an imported
 * `.list.json` display name or a renamed column). That override is kept, so a
 * definition edit — and in particular a zero-change save — never silently
 * renames the column.
 */
export function columnFromDraft(
  draft: ColumnDraft,
  id: string,
  previous?: ColumnDefinition,
): ColumnDefinition {
  const setName = draft.setName.trim();
  const propName = draft.propName.trim();
  const hadOverride =
    previous?.label !== undefined && previous.label !== previous.propertyName;
  return {
    id,
    source: draft.source,
    psetName: setName,
    propertyName: propName,
    label: hadOverride ? previous!.label : propName,
  };
}

/**
 * Replace the column with `id` by `next` (its `id` forced to stay `id`),
 * keeping every other column and the overall ORDER untouched. Returns the
 * array unchanged when no column matches, so a stale edit is a no-op.
 */
export function updateColumnInPlace(
  columns: ColumnDefinition[],
  id: string,
  next: ColumnDefinition,
): ColumnDefinition[] {
  if (!columns.some((c) => c.id === id)) return columns;
  return columns.map((c) => (c.id === id ? { ...next, id } : c));
}
