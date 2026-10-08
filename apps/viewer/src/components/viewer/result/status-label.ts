/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';
import type { ResultStatus } from './StatusChip';

/** Spoken status wording shares the chip vocabulary without loading its visual icons. */
export function statusLabelKey(status: ResultStatus): TranslationKey {
  return `resultStatus.${status}`;
}
