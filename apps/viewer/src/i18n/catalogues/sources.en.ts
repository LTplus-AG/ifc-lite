/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Cloud Sources panel (`SourcesPanel.tsx` and its `sources/` component
 * tree, #4918 sweep): every heading, button label, tooltip, aria-label, and
 * empty/error/status message that is literally written in these components.
 *
 * Deliberately NOT covered — all of it is runtime content, not a literal in
 * this repo:
 *  - Real file, folder, and project NAMES a connected source reports
 *    (`file.name`, `container.name`, `project.name`) — only ever passed as
 *    `{name}`/`{title}` interpolation parameters here, never as literal text.
 *  - A provider's own display name/title (`manifest.title`) and its
 *    third-party registration-failure `reason` string — same treatment,
 *    interpolated, never literal.
 *  - `SourceBrowser.tsx` itself and `usePagedList`/`useSourceAuth` (no
 *    literal UI copy of their own).
 *
 * Keys are namespaced per component (`sources.<component>.<name>`). A few
 * strings that read identically across two components (e.g. a folder's
 * "Remove/Add favourite: {name}" aria-label, shared by `SourceFileRow`,
 * `SourceFolderStep`, and `SourceFolderTree`) still get one entry per
 * component: each is a separate literal in a separate file, not a shared
 * import, so a translator may reasonably want to phrase a deeply-nested
 * folder row differently from a top-level file row.
 */
export const sourcesEn = {
  // ── SourceBrowserHeader ──
  'sources.sourceBrowserHeader.backAria': 'Back',
  'sources.sourceBrowserHeader.syncedAt': 'Synced {time}',
  'sources.sourceBrowserHeader.sync': 'Sync',
  'sources.sourceBrowserHeader.syncedJustNow': 'just now',
  'sources.sourceBrowserHeader.syncedMinutesAgo': '{minutes}m ago',
  'sources.sourceBrowserHeader.syncedHoursAgo': '{hours}h ago',

  // ── SourceEntityList / LoadMoreRow ──
  'sources.sourceEntityList.loading': 'Loading…',

  // ── SourceFavouritesList ──
  'sources.sourceFavouritesList.heading': 'Favourites',
  'sources.sourceFavouritesList.removeFavouriteAria': 'Remove favourite: {name}',
  'sources.sourceFavouritesList.providerUnavailable': 'Provider unavailable',
  'sources.sourceFavouritesList.addRequiredSettings': 'Add the required settings to browse',

  // ── SourceFileRow ──
  'sources.sourceFileRow.deselectAria': 'Deselect {name}',
  'sources.sourceFileRow.selectAria': 'Select {name}',
  'sources.sourceFileRow.updateAvailable': 'Update available',
  'sources.sourceFileRow.removeFavouriteAria': 'Remove favourite: {name}',
  'sources.sourceFileRow.addFavouriteAria': 'Add favourite: {name}',
  'sources.sourceFileRow.loadedTooltip': 'Loaded in hierarchy: {names}',
  'sources.sourceFileRow.loadedTooltipEmpty': 'Loaded in hierarchy',
  'sources.sourceFileRow.loadedBadge': { one: 'Loaded', other: '{count} loaded' },
  'sources.sourceFileRow.syncAria': 'Sync {name} from source',

  // ── SourceFolderStep ──
  'sources.sourceFolderStep.fileAreaRemoveFavouriteAria': 'Remove favourite: {name}',
  'sources.sourceFolderStep.fileAreaAddFavouriteAria': 'Add favourite: {name}',
  'sources.sourceFolderStep.loadMoreFolders': 'Load more folders',
  'sources.sourceFolderStep.searchPlaceholder': 'Search files in project…',
  'sources.sourceFolderStep.searchAriaLabel': 'Search files in project',
  'sources.sourceFolderStep.clearSearchAria': 'Clear search',
  'sources.sourceFolderStep.searchActiveHint': 'Showing search results across the whole project.',
  'sources.sourceFolderStep.subfoldersHeading': 'Subfolders',
  'sources.sourceFolderStep.noSearchResults': 'No files match this search',
  'sources.sourceFolderStep.noFilesFound': 'No IFC files found in this folder',
  'sources.sourceFolderStep.loadMoreFiles': 'Load more files',
  'sources.sourceFolderStep.loadButtonBusy': 'Loading…',
  'sources.sourceFolderStep.loadButton': {
    one: 'Load {count} file as federated model',
    other: 'Load {count} files as federated model',
  },

  // ── SourceFolderTree ──
  'sources.sourceFolderTree.noSubfolders': 'No subfolders',
  'sources.sourceFolderTree.collapseFolderAria': 'Collapse folder',
  'sources.sourceFolderTree.expandFolderAria': 'Expand folder',
  'sources.sourceFolderTree.removeFavouriteAria': 'Remove favourite: {name}',
  'sources.sourceFolderTree.addFavouriteAria': 'Add favourite: {name}',

  // ── SourceProjectsStep ──
  'sources.sourceProjectsStep.searchPlaceholder': 'Search projects…',
  'sources.sourceProjectsStep.searchAriaLabel': 'Search projects',
  'sources.sourceProjectsStep.discoverableHint':
    'This provider cannot list every project — search to find more.',
  'sources.sourceProjectsStep.emptyDiscoverable': 'No projects found — try a search',
  'sources.sourceProjectsStep.emptyDefault': 'No projects found',
  'sources.sourceProjectsStep.loadMoreProjects': 'Load more projects',

  // ── SourceProviderRow ──
  'sources.sourceProviderRow.signOutAria': 'Sign out of {title}',
  'sources.sourceProviderRow.signOut': 'Sign out',
  'sources.sourceProviderRow.signInAria': 'Sign in to {title}',
  'sources.sourceProviderRow.signIn': 'Sign in',
  'sources.sourceProviderRow.settingsAria': '{title} settings',
  'sources.sourceProviderRow.browseAria': 'Browse {title}',
  'sources.sourceProviderRow.browse': 'Browse',
  'sources.sourceProviderRow.restoringSession': 'Restoring session…',
  'sources.sourceProviderRow.addSettingsThenSignIn': 'Add the required settings, then sign in to browse',
  'sources.sourceProviderRow.signInToBrowse': 'Sign in to browse',
  'sources.sourceProviderRow.addRequiredSettings': 'Add the required settings to browse',

  // ── SourceSettingsDialog ──
  'sources.sourceSettingsDialog.title': '{title} Settings',
  'sources.sourceSettingsDialog.localStorageNotice':
    "Saved values are stored in this browser's local storage, unencrypted. Treat them as revocable, not secret.",
  'sources.sourceSettingsDialog.forgetSavedValues': 'Forget saved values',
  'sources.sourceSettingsDialog.testConnection': 'Test connection',
  'sources.sourceSettingsDialog.save': 'Save',
  'sources.sourceSettingsDialog.selectPlaceholder': 'Select…',

  // ── SourcesPanel ──
  'sources.sourcesPanel.title': 'Cloud Sources',
  'sources.sourcesPanel.closeAria': 'Close',
  'sources.sourcesPanel.noProviders': 'No source providers configured',
  'sources.sourcesPanel.unavailableProviders': 'Unavailable providers',
  'sources.sourcesPanel.failedToRegister': '{provider} failed to register: {reason}',
  'sources.sourcesPanel.noProviderMessage': 'No provider',
  'sources.sourcesPanel.connectionTestUnsupported': 'Provider does not support connection testing',
  'sources.sourcesPanel.revisionChangedOnly': {
    one: '{count} loaded model has a newer revision — use Sync to update.',
    other: '{count} loaded models have newer revisions — use Sync to update.',
  },
  'sources.sourcesPanel.revisionDeletedOnly': {
    one: '{count} source file is gone upstream — use Sync to update.',
    other: '{count} source files are gone upstream — use Sync to update.',
  },
  'sources.sourcesPanel.revisionChangedOneDeletedOne':
    '{changed} loaded model has a newer revision and {deleted} source file is gone upstream — use Sync to update.',
  'sources.sourcesPanel.revisionChangedOneDeletedMany':
    '{changed} loaded model has a newer revision and {deleted} source files are gone upstream — use Sync to update.',
  'sources.sourcesPanel.revisionChangedManyDeletedOne':
    '{changed} loaded models have newer revisions and {deleted} source file is gone upstream — use Sync to update.',
  'sources.sourcesPanel.revisionChangedManyDeletedMany':
    '{changed} loaded models have newer revisions and {deleted} source files are gone upstream — use Sync to update.',
  'sources.sourcesPanel.downloadFailedWithMessage': '{name}: {message}',
  'sources.sourcesPanel.downloadFailedGeneric': 'Failed to download {name} from {title}',
} as const satisfies Record<string, TranslationValue>;
