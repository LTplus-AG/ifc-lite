/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ValidationRowsMode } from '../document/types';
import type { resolve } from '@/i18n/registry';
import type { TranslationKey } from '@/i18n/en';

const rowLabels = {
  failed: 'document.block.tableValidationRowsFailed',
  passed: 'document.block.tableValidationRowsPassed',
  all: 'document.block.tableValidationRowsAll',
  sets: 'document.block.tableValidationRowsSets',
} as const satisfies Record<ValidationRowsMode, TranslationKey>;

/** #8890: enum values remain machine data; the preview displays translated labels. */
export function liveRowsText(t: typeof resolve, rows: ValidationRowsMode, count: number, target: string): string {
  return t('checkAuthoring.liveRows', { count, rows: t(rowLabels[rows]), target });
}
