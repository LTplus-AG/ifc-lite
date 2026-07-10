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
 * Build the edited column from the editor draft, PRESERVING the original id so
 * the results table's width (keyed by id) and sort (by column index) survive.
 * The label tracks the property name, matching how columns are added.
 */
export function columnFromDraft(draft: ColumnDraft, id: string): ColumnDefinition {
  const setName = draft.setName.trim();
  const propName = draft.propName.trim();
  return {
    id,
    source: draft.source,
    psetName: setName,
    propertyName: propName,
    label: propName,
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
