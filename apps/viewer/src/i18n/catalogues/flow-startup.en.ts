/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const flowStartupEn = {
  'flowStartup.optIn': 'Offer this workflow at startup',
  'flowStartup.title': 'Open your saved workflow?',
  'flowStartup.description': 'Open “{name}” to choose files and review settings, then click Run when ready.',
  'flowStartup.open': 'Open workflow',
  'flowStartup.skip': 'Skip this session',
  'flowStartup.disable': 'Disable startup prompt',
  'flowStartup.storageError': 'Could not save startup preference: {reason}',
} as const satisfies Record<string, TranslationValue>;
