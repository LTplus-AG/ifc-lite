/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The ribbon's tab strip, and which of its tabs this page offers (see `lib/features`). */

import type { TranslationKey } from '@/i18n';
import type { RibbonTabId } from '@/store';
import { anyRibbonCommandAvailable } from '../surface-command-features';
import type { SurfaceCommandId } from '../surface-command-registry';

/** The Author tab's groups, by the commands each holds. */
export const AUTHOR_GROUPS = {
  edit: ['author:undo', 'author:redo', 'panel:changeSets'],
  create: ['panel:appearance'],
  properties: ['author:bulk-properties', 'author:import-data'],
  customize: ['panel:extensions'],
} as const satisfies Record<string, readonly SurfaceCommandId[]>;

/** `commands`: the tab holds nothing else, so it goes when a host switched all of them off. */
export const RIBBON_TABS: { id: RibbonTabId; labelKey: TranslationKey; commands?: readonly SurfaceCommandId[] }[] = [
  { id: 'file', labelKey: 'ribbon.tab.file' },
  { id: 'home', labelKey: 'ribbon.tab.home' },
  { id: 'view', labelKey: 'ribbon.tab.view' },
  { id: 'elements', labelKey: 'ribbon.tab.elements' },
  { id: 'analyze', labelKey: 'ribbon.tab.analyze' },
  { id: 'author', labelKey: 'ribbon.tab.author', commands: Object.values(AUTHOR_GROUPS).flat() },
];

export function availableRibbonTabs(): typeof RIBBON_TABS {
  return RIBBON_TABS.filter((tab) => !tab.commands || anyRibbonCommandAvailable(tab.commands));
}
