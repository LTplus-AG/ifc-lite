/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';

/** One user-facing name per action, shared by every surface that offers it. */
export const ACTION_NAME_KEYS = {
  showAll: 'commands.visibility.showAll',
  copyGlobalId: 'commands.edit.copyGlobalId',
} as const satisfies Record<'showAll' | 'copyGlobalId', TranslationKey>;
