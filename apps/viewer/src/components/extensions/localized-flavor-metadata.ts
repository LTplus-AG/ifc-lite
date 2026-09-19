/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_FLAVOR_ID, type Flavor } from '@ifc-lite/extensions';
import type { UseTranslationResult } from '@/i18n';

type Translate = UseTranslationResult['t'];

export function localizedFlavorName(flavor: Flavor, t: Translate): string {
  return flavor.id === DEFAULT_FLAVOR_ID
    ? t('extensionsFlavors.flavorIndicator.defaultLabel')
    : flavor.name;
}

export function localizedFlavorDescription(flavor: Flavor, t: Translate): string | undefined {
  return flavor.id === DEFAULT_FLAVOR_ID
    ? t('extensionsFlavors.flavorIndicator.defaultDescription')
    : flavor.description;
}
