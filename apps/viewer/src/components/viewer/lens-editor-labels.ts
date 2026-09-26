/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Auto-color source labels used by the Lens panel. Manual rules use the
 * shared FilterGroup editor and its canonical operator labels. */
import type { TranslationKey } from '@/i18n';

export const TYPE_LABEL_KEYS: Record<string, TranslationKey> = {
  ifcType: 'lensPanel.type.ifcType',
  attribute: 'lensPanel.type.attribute',
  property: 'lensPanel.type.property',
  quantity: 'lensPanel.type.quantity',
  classification: 'lensPanel.type.classification',
  material: 'lensPanel.type.material',
  model: 'lensPanel.type.model',
  group: 'lensPanel.type.group',
};
