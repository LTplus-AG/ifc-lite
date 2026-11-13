/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The ribbon's tab strip, and which of its tabs this page offers (see `lib/features`). */

import type { TranslationKey } from '@/i18n';
import { isFeatureEnabled, type FeatureId } from '@/lib/features';
import type { RibbonTabId } from '@/store';

/** `features`: the tab holds nothing else, so it goes when a host switched all of them off. */
export const RIBBON_TABS: { id: RibbonTabId; labelKey: TranslationKey; features?: readonly FeatureId[] }[] = [
  { id: 'file', labelKey: 'ribbon.tab.file' },
  { id: 'home', labelKey: 'ribbon.tab.home' },
  { id: 'view', labelKey: 'ribbon.tab.view' },
  { id: 'elements', labelKey: 'ribbon.tab.elements' },
  { id: 'analyze', labelKey: 'ribbon.tab.analyze' },
  { id: 'author', labelKey: 'ribbon.tab.author', features: ['edit.model', 'view.appearance', 'automate.extensions'] },
];

export function availableRibbonTabs(): typeof RIBBON_TABS {
  return RIBBON_TABS.filter((tab) => !tab.features || tab.features.some(isFeatureEnabled));
}
