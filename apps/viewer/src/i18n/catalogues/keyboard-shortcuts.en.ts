/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Info dialog (#4918 slice: keyboard shortcuts, `KeyboardShortcutsDialog.tsx`,
 * exported under that name for backward compatibility though it renders all
 * five Info tabs, not only Shortcuts) covers its own header/footer chrome,
 * the About tab (privacy banner, links, license, package-count disclosure),
 * the What's New tab (release timeline and its legend), the Shortcuts tab's
 * own "Learn more" row, the Preferences tab's section headings (#5509 —
 * the SpaceMouse settings under it come from `spaceMousePanel.*` in
 * `misc-panels-a.en.ts`, which owns that component), and the tab strip.
 * The Shortcuts tab's rows are generated
 * from `@/lib/commands/keyboard-commands` and translated by `commands.en.ts`
 * (#5836). `LearnTab.tsx` (rendered as the fourth tab) has its own catalogue
 * outside this slice.
 */
export const keyboardShortcutsEn = {
  // Header
  'keyboardShortcuts.header.title': 'Info',
  'keyboardShortcuts.header.mcpAriaLabel': 'Open ifc-lite MCP — drive ifc-lite from any LLM',
  'keyboardShortcuts.header.mcpCta': 'Drive from any LLM',

  // Tab strip
  'keyboardShortcuts.tabs.about': 'About',
  'keyboardShortcuts.tabs.whatsNew': "What's New",
  'keyboardShortcuts.tabs.shortcuts': 'Shortcuts',
  'keyboardShortcuts.tabs.preferences': 'Preferences',
  'keyboardShortcuts.tabs.learn': 'Learn',

  // Preferences tab (#5509): today just Navigation → SpaceMouse, grows as
  // more settings move out of floating panels.
  'keyboardShortcuts.preferences.navigationSectionTitle': 'Navigation',
  'keyboardShortcuts.preferences.spaceMouseSectionTitle': 'SpaceMouse',

  // Footer
  'keyboardShortcuts.footer.pressPrefix': 'Press',
  'keyboardShortcuts.footer.toggleSuffix': 'to toggle this panel',

  // About tab — privacy banner
  'keyboardShortcuts.privacy.banner': 'Your IFC data never leaves your device.',
  'keyboardShortcuts.privacy.intro': 'All files are processed locally in the browser with',
  'keyboardShortcuts.privacy.wasmLink': 'WebAssembly (WASM)',
  'keyboardShortcuts.privacy.outro': '– no server upload, near-native speed.',
  'keyboardShortcuts.privacy.verifyIntro': 'Verify: press',
  'keyboardShortcuts.privacy.verifyKey': 'F12',
  'keyboardShortcuts.privacy.verifyOutro': '→ Network tab → no IFC data transmitted.',

  // About tab — links, license, packages
  'keyboardShortcuts.about.appName': 'ifc-lite',
  'keyboardShortcuts.about.versionLabel': 'v{version}',
  'keyboardShortcuts.about.homepageLink': 'ifclite.dev',
  'keyboardShortcuts.about.docsLink': 'Docs',
  'keyboardShortcuts.about.githubLink': 'GitHub',
  'keyboardShortcuts.about.reportIssueLink': 'Report issue',
  'keyboardShortcuts.about.license': 'MPL-2.0',
  'keyboardShortcuts.about.packagesCount': { one: '{count} package', other: '{count} packages' },

  // What's New tab
  'keyboardShortcuts.whatsNew.empty': 'No release history available.',
  'keyboardShortcuts.whatsNew.currentVersion': 'You’re on viewer v{version}',
  'keyboardShortcuts.whatsNew.perPackageHint': 'rows below are per-package releases',
  'keyboardShortcuts.whatsNew.releaseVersionLabel': 'v{version}',
  'keyboardShortcuts.whatsNew.viewerBadge': 'viewer',
  'keyboardShortcuts.whatsNew.changeCount': { one: '{count} change', other: '{count} changes' },
  'keyboardShortcuts.whatsNew.legendFeature': 'Feature',
  'keyboardShortcuts.whatsNew.legendFix': 'Fix',
  'keyboardShortcuts.whatsNew.legendPerf': 'Perf',

  // Shortcuts tab
  'keyboardShortcuts.shortcuts.learnMore': 'Learn more:',
  'keyboardShortcuts.shortcuts.homepageLink': 'ifclite.dev',
  'keyboardShortcuts.shortcuts.docsLink': 'docs',
} as const satisfies Record<string, TranslationValue>;
