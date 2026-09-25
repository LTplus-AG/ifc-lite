/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Default button labels of the shared confirm/prompt dialogs
 *  (`components/ui/confirm-dialog.tsx`, #5813). Each call site supplies its
 *  own question; these are only the fallbacks. */
export const dialogsEn = {
  'dialogs.confirm': 'Confirm',
  'dialogs.cancel': 'Cancel',
  'dialogs.ok': 'OK',
} as const satisfies Record<string, TranslationValue>;
