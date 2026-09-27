/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Strings for the Properties panel's inline attribute editor (properties/AttributeEditorField.tsx). */
export const attributeEditorEn = {
  'properties.panel.attributeEditor.emptyValue': 'empty',
  'properties.panel.attributeEditor.editTooltip': 'Edit attribute',
  'properties.panel.attributeEditor.invalidGlobalId': 'A GlobalId is 22 characters: 0-9, A-Z, a-z, _ and $.',
  'properties.panel.attributeEditor.duplicateGlobalId': 'Another element in this model already has this GlobalId.',
} as const satisfies Record<string, TranslationValue>;
