/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslatableMessage } from '@/i18n';
import { validationFindings as canonical } from '@ifc-lite/sdk/review';
import type { FindingSourceResult, ReviewModel } from '../types';

export function validationFindings(input: Parameters<typeof canonical>[0], models: readonly ReviewModel[]): FindingSourceResult {
  return canonical<TranslatableMessage>(input, models);
}
