/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationKey } from '@/i18n';
import type { ScanWorkflowMessage } from './useScanWorkbench.js';

export class ScanValidationError extends Error {
  constructor(readonly key: TranslationKey) {
    super(key);
    this.name = 'ScanValidationError';
  }
}

export function scanFailureMessage(error: unknown): ScanWorkflowMessage {
  return error instanceof ScanValidationError
    ? { kind: 'translated', key: error.key }
    : { kind: 'raw', text: error instanceof Error ? error.message : String(error) };
}
