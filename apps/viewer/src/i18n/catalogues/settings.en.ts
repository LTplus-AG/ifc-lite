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
  'settings.sections.performance': 'Performance',
  'settings.sections.privacy': 'Privacy',
  'settings.sections.collaboration': 'Collaboration',

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
  'settings.display.navigationPreset': 'Pointer and wheel controls',
  'settings.display.preset.default': 'Default',
  'settings.display.preset.navisworks': 'Navisworks-like',
  'settings.display.preset.trackpad': 'Trackpad',
  'settings.display.presetHint.default': 'Wheel zooms; horizontal wheel movement pans.',
  'settings.display.presetHint.navisworks': 'Shift + middle drag orbits; wheel zooms.',
  'settings.display.presetHint.trackpad': 'Two-finger scroll pans; pinch or Ctrl + wheel zooms.',
  'settings.display.spaceMouseTitle': 'SpaceMouse',
  'settings.display.performanceTitle': 'Performance',
  'settings.display.performanceStats': 'Show performance stats',
  'settings.display.performanceStatsHint': 'Show FPS, memory use and triangle count in the status bar.',

  'settings.performance.overridesTitle': 'Sticky geometry overrides',
  'settings.performance.overridesHint': 'These values affect the next model load. Reset returns to automatic selection.',
  'settings.performance.noOverrides': 'No overrides are active.',
  'settings.performance.geometryTier': 'Geometry detail',
  'settings.performance.geometryWorkers': 'Geometry workers',
  'settings.performance.tierIgnoredInExact': 'Low detail is ignored in Exact mode.',
  'settings.performance.workersMayClamp': 'Changes apply on the next model load. The engine may lower this count to fit memory.',
  'settings.performance.sourceUrl': 'From this URL',
  'settings.performance.sourceSaved': 'Saved in this browser',
  'settings.performance.reset': 'Reset',
  'settings.performance.resetNamed': 'Reset {name}',

  'settings.privacy.analyticsTitle': 'Product analytics',
  'settings.privacy.analyticsDisclosure': 'The hosted viewer sends anonymous usage and error events, such as the command used, model schema, counts and build version.',
  'settings.privacy.analyticsExclusions': 'Model content, file names, GlobalIds, property values, chat text and API keys are never included.',
  'settings.privacy.analyticsOptOut': 'Opt out of product analytics',
  'settings.privacy.analyticsOptOutHint': 'Stops usage and error events from this browser.',
  'settings.privacy.learnMore': 'Read the privacy guide',
  'settings.privacy.toastDisclosure': 'IFClite stores an action log on your device. The hosted viewer also sends anonymous product analytics unless you opt out in Privacy settings.',
  'settings.privacy.toastAction': 'Privacy settings',
  'settings.collaboration.identityTitle': 'Your identity',
  'settings.collaboration.displayName': 'Display name',
  'settings.collaboration.displayNameHint': 'Shown to other people in a shared session.',
  'settings.collaboration.saveName': 'Save name',
  'settings.collaboration.emptyName': 'Enter a display name.',
} as const satisfies Record<string, TranslationValue>;
