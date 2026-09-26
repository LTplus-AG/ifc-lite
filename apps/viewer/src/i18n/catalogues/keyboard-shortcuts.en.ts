/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Info dialog (#4918 slice: keyboard shortcuts, `KeyboardShortcutsDialog.tsx`,
 * exported under that name for backward compatibility though it renders all
 * four Info tabs, not only Shortcuts) covers its own header/footer chrome,
 * the About tab (privacy banner, links, license, package-count disclosure),
 * the What's New tab (release timeline and its legend), the Shortcuts tab's
 * own "Learn more" row, and the tab strip. (Preferences moved to the
 * Settings dialog, `settings.en.ts`, #5857.)
 * Shortcut CATEGORY names,
 * DESCRIPTIONS, and key-combination glyphs come from `KEYBOARD_SHORTCUTS`
 * (`@/hooks/keyboard-shortcuts-list`) and stay out of the catalogue — model
 * content for this slice's own scope, same reasoning as every other data
 * table in this sweep. `LearnTab.tsx` (rendered as the fourth tab) has its
 * own catalogue outside this slice.
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
  'keyboardShortcuts.tabs.learn': 'Learn',

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
