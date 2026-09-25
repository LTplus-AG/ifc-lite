/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Settings dialog (#5857, `components/viewer/settings/`): its chrome,
 * section names and each section's own labels. The SpaceMouse controls in
 * Display come from `spaceMousePanel.*` in `misc-panels-a.en.ts`, which owns
 * that component. The openers' labels (ribbon, classic toolbar, palette) live
 * in their own catalogues.
 */
export const settingsEn = {
  'settings.title': 'Settings',
  'settings.description': 'Saved in this browser.',
  'settings.sections.general': 'General',
  'settings.sections.display': 'Display',

  'settings.general.appearanceTitle': 'Appearance',
  'settings.general.theme': 'Theme',
  'settings.general.themeLight': 'Light',
  'settings.general.themeDark': 'Dark',
  'settings.general.toolbar': 'Toolbar',
  'settings.general.toolbarRibbon': 'Ribbon',
  'settings.general.toolbarClassic': 'Classic bar',
  'settings.general.helpersTitle': 'Helpers',
  'settings.general.hoverTooltips': 'Hover tooltips',
  'settings.general.hoverTooltipsHint': 'Show an element’s name and class under the pointer.',

  'settings.display.navigationTitle': 'Navigation',
  'settings.display.spaceMouseTitle': 'SpaceMouse',
} as const satisfies Record<string, TranslationValue>;
