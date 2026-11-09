/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The IFC shared-height-system assumption (#8042): its Settings group and the
 * "Assumed" notice on a model placed under it. Lazy (#6923): registered by
 * `ifc-federation-assumptions.register.ts`, which only the lazy-loaded
 * `IfcFederationAssumptionsUi.tsx` imports.
 */
export const ifcFederationAssumptionsEn = {
  'settings.ifcFederation.title': 'IFC federation',
  'settings.ifcFederation.sharedVertical': 'Assume IFC models share a height system',
  'settings.ifcFederation.hint': 'Off by default. Only enable this when you know the IFC models and anchor use the same height system. When a vertical datum is missing or unresolved, heights are placed as authored. A wrong assumption places models too high or too low. Different declared datums are still refused. Unrecognized names that cannot be reconciled are also refused. Reload or re-align the federation to apply changes.',
  'settings.ifcFederation.assumed': 'Assumed height system',
  'settings.ifcFederation.appliedUnresolved': 'IFC heights assumed to share the anchor model’s height system by your setting. An authored vertical datum could not be resolved; the source declarations are unchanged.',
  'settings.ifcFederation.applied': 'IFC heights assumed to share the anchor model’s height system by your setting. A vertical datum is missing; the source declarations are unchanged.',
} as const satisfies Record<string, TranslationValue>;
