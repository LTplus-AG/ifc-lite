/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerEnglish } from '../registry';

export const sourcesPanelEn = {
  'sources.sourceProviderRow.signOutFailed': 'Sign-out failed. Retry to end your Autodesk session.',
  'sources.resourceDetails.proposal': 'Forma proposal → native IFCX model',
  'sources.resourceDetails.exchange': 'Data Exchange → native IFC model',
  'sources.resourceDetails.file': 'Load the original source file at the selected version.',
  'sources.resourceDetails.exchangeVersions': 'Autodesk supports whole-exchange export of the current version. Older versions are listed for reference.',
  'sources.resourceDetails.proposalFidelity': 'Includes volume meshes, instances and source properties. Textures, vertex colors and 2D terrain overlays may differ; georeferencing is preserved.',
  'sources.resourceDetails.loading': 'Loading versions…',
  'sources.resourceDetails.versions': 'Source versions',
  'sources.resourceDetails.current': 'Version {version} (current)',
  'sources.resourceDetails.selected': 'Selected',
  'sources.resourceDetails.more': 'Load more versions',
  'sources.resourceDetails.retry': 'Retry',
  'sources.sourceProviderRow.cancelSignIn': 'Cancel sign-in',
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
  'sources.sourceProviderRow.sessionExpired': 'Your session expired. Please sign in again.',
  'sources.sourceProviderRow.signInFailed': 'Sign-in failed. Please try again.',
  'sources.sourceProviderRow.addRequiredSettings': 'Add the required settings to browse',
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
  'sources.sourcesPanel.revisionChangedZeroDeleted': { one: '{changed} loaded models have newer revisions and {deleted} source file is gone upstream — use Sync to update.', other: '{changed} loaded models have newer revisions and {deleted} source files are gone upstream — use Sync to update.' },
  'sources.sourcesPanel.revisionChangedOneDeleted': { one: '{changed} loaded model has a newer revision and {deleted} source file is gone upstream — use Sync to update.', other: '{changed} loaded model has a newer revision and {deleted} source files are gone upstream — use Sync to update.' },
  'sources.sourcesPanel.revisionChangedTwoDeleted': { one: '{changed} loaded models have newer revisions and {deleted} source file is gone upstream — use Sync to update.', other: '{changed} loaded models have newer revisions and {deleted} source files are gone upstream — use Sync to update.' },
  'sources.sourcesPanel.revisionChangedFewDeleted': { one: '{changed} loaded models have newer revisions and {deleted} source file is gone upstream — use Sync to update.', other: '{changed} loaded models have newer revisions and {deleted} source files are gone upstream — use Sync to update.' },
  'sources.sourcesPanel.revisionChangedManyDeleted': { one: '{changed} loaded models have newer revisions and {deleted} source file is gone upstream — use Sync to update.', other: '{changed} loaded models have newer revisions and {deleted} source files are gone upstream — use Sync to update.' },
  'sources.sourcesPanel.revisionChangedOtherDeleted': { one: '{changed} loaded models have newer revisions and {deleted} source file is gone upstream — use Sync to update.', other: '{changed} loaded models have newer revisions and {deleted} source files are gone upstream — use Sync to update.' },
  'sources.sourcesPanel.downloadFailedWithMessage': '{name}: {message}',
  'sources.sourcesPanel.downloadFailedGeneric': 'Failed to download {name} from {title}',
} as const;

registerEnglish(sourcesPanelEn);
