/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** The Model inspector side panel (charter #6232, M2). */
export const modelInspectorEn = {
  'modelInspector.panel.title': 'Model inspector',
  'modelInspector.close': 'Close the Model inspector',
  'modelInspector.empty.noSession': 'Enter the Model workspace to edit',
  'modelInspector.empty.enter': 'Model',
  'modelInspector.empty.noModel': 'Load or start a model first',
  'modelInspector.empty.idle': 'Pick a tool in the rail, or select an element',
} as const satisfies Record<string, TranslationValue>;
