/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BlockTitle } from './block-title';
import type { DocumentValidationError } from './types';

export interface QualityGateBlock extends BlockTitle {
  kind: 'quality-gate';
  id: string;
  clashReportId: string;
  /** Row index in the immutable saved report. Absent while the author chooses a result. */
  row?: number;
  scale?: number;
}

export function validateQualityGateBlock(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
  if (typeof block.clashReportId !== 'string' || !block.clashReportId.length) {
    errors.push({ path: `${at}.clashReportId`, message: 'expected a saved clash report id' });
  }
  if (block.row !== undefined && (typeof block.row !== 'number' || !Number.isSafeInteger(block.row) || block.row < 0)) {
    errors.push({ path: `${at}.row`, message: 'expected a non-negative row index' });
  }
}
