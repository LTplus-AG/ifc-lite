/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One translation key per `TableColumnId` (#5138), shared by the on-screen
 * table (`DocumentPreview.tsx`) and its column-toggle editor
 * (`TableBlockEditor.tsx`) — printed PDF headers stay plain English, like
 * every other fallback string `generate-document-pdf.ts` draws.
 */
import type { TranslationKey } from '@/i18n';
import type { TableColumnId } from '@/lib/document/types';

export const TABLE_COLUMN_LABEL_KEY = {
  rule: 'document.tableColumn.rule',
  result: 'document.tableColumn.result',
  entityType: 'document.tableColumn.entityType',
  name: 'document.tableColumn.name',
  globalId: 'document.tableColumn.globalId',
  model: 'document.tableColumn.model',
  actual: 'document.tableColumn.actual',
  expected: 'document.tableColumn.expected',
  reason: 'document.tableColumn.reason',
  set: 'document.tableColumn.set',
  members: 'document.tableColumn.members',
} as const satisfies Record<TableColumnId, TranslationKey>;
