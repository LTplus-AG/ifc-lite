/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One translation key per `TableColumnId` (#5138 review), shared by the
 * validation column-toggle editor (`TableBlockEditor.tsx`) and the on-screen
 * table (`TablePreview.tsx`) — both are interactive UI, so both translate.
 * The printed PDF keeps `resolve-validation-table.ts`'s plain-English
 * `VALIDATION_COLUMN_LABEL`, the same way every other fallback string
 * `generate-document-pdf.ts` draws is unlocalized.
 */
import type { TranslationKey } from '@/i18n';
import type { TableColumnId } from '@/lib/document/types';

export const TABLE_COLUMN_LABEL_KEY = {
  rule: 'document.table.column.rule',
  result: 'document.table.column.result',
  entityType: 'document.table.column.entityType',
  name: 'document.table.column.name',
  globalId: 'document.table.column.globalId',
  model: 'document.table.column.model',
  actual: 'document.table.column.actual',
  expected: 'document.table.column.expected',
  reason: 'document.table.column.reason',
  set: 'document.table.column.set',
  members: 'document.table.column.members',
} as const satisfies Record<TableColumnId, TranslationKey>;
