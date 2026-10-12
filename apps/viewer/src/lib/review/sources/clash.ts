/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clashFindings as canonical } from '@ifc-lite/sdk/review';
import type { TranslatableMessage } from '@/i18n';
import type { FindingSourceResult, ReviewModel } from '../types';
export { clashGlobalId } from '@ifc-lite/sdk/review';
export type ClashFindingInput = Parameters<typeof canonical>[0];

export function clashFindings(input: ClashFindingInput, models: readonly ReviewModel[]): FindingSourceResult {
  return canonical<TranslatableMessage>(input, models);
}
