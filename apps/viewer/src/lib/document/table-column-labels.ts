/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One translation key per `TableColumnId` (#5138 review), shared by the
 * validation column-toggle editor and the canonical document table labels.
 * A supplied captured formatter translates preview/PDF columns before layout
 * measures them. Callers omitting labels retain `resolve-validation-table.ts`'s
 * plain-English `VALIDATION_COLUMN_LABEL` (#6610).
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
