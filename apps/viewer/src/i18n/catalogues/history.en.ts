/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Model version history (commit-history spec 02): the History panel, its
 * timeline rows and compare bar, and the element-history card in the
 * properties panel.
 *
 * Commit MESSAGES, author display names, model names, file names, IFC type
 * names and property-set names are all runtime data from the source or the
 * model and stay out of the catalogue — only the chrome around them is here.
 */
export const historyEn = {
  'history.panel.title': 'Model history',
  'history.panel.close': 'Close history',
  'history.panel.modelLabel': 'Model',
  'history.panel.sourceLabel': 'Source',

  // Empty / unavailable states
  'history.state.noModel': 'Open a model to see its history.',
  'history.state.noSource': 'History is available for models opened from a source.',
  'history.state.noProviderHistory': 'This source does not keep version history for its files.',
  'history.state.empty': 'This model has no commits yet.',
  'history.state.loading': 'Loading history…',
  'history.state.forbidden': "You do not have access to this model's history.",
  'history.state.retry': 'Retry',

  // Timeline
  'history.timeline.label': 'Version history',
  'history.timeline.loadMore': 'Load more',
  'history.timeline.mergeCommit': 'Merge commit',
  'history.badge.head': 'HEAD',
  'history.badge.loaded': 'LOADED',
  'history.badge.pending': 'Pending',
  'history.badge.rejected': 'Rejected',
  'history.badge.historical': 'Past version',
  'history.row.stats': '{added} added, {modified} modified, {deleted} deleted',

  // Row actions
  'history.action.menu': 'Version actions',
  'history.action.open': 'Open (replace)',
  'history.action.openAlongside': 'Open alongside',
  'history.action.setA': 'Set as A',
  'history.action.setB': 'Set as B',
  'history.action.compareWithLoaded': 'Compare with loaded',
  'history.action.copyId': 'Copy commit id',
  'history.action.copied': 'Commit id copied',
  'history.action.backToLatest': 'Back to latest version',
  'history.action.showHistory': 'Show history',
  'history.action.openDisabled': 'This source can list older versions but cannot download them.',

  // Compare
  'history.compare.label': 'Compare',
  'history.compare.slotA': 'A',
  'history.compare.slotB': 'B',
  'history.compare.none': 'none',
  'history.compare.showIn3D': 'Show in 3D',
  'history.compare.calculating': 'Calculating changes…',
  'history.compare.unsupported': 'This source cannot pre-compute changes; open both versions to compare them.',
  'history.compare.counts': '{added} added · {modified} modified · {deleted} deleted',
  'history.compare.more': '…and {count} more',
  'history.compare.groupAdded': 'Added',
  'history.compare.groupModified': 'Modified',
  'history.compare.groupDeleted': 'Deleted',

  // New head
  'history.newHead.available': 'New version available',
  'history.newHead.open': 'Open it',

  // Read-only historical models
  'history.readOnly.tooltip': 'This is a past version and cannot be edited.',

  // Element history card
  'history.element.title': 'History',
  'history.element.unsupported': 'Element history is not available for this source.',
  'history.element.empty': 'No recorded changes for this element.',
  'history.element.showAll': 'Show all',
  'history.element.state.added': 'Added',
  'history.element.state.modified': 'Modified',
  'history.element.state.deleted': 'Deleted',
  'history.element.state.renamed': 'Renamed from {from}',
  'history.element.state.split': 'Split',
  'history.element.state.merged': 'Merged',
  'history.element.state.replaced': 'Replaced',
  'history.element.changeKind.data': 'data',
  'history.element.changeKind.geometry': 'geometry',
  'history.element.changeKind.container': 'container',
} as const satisfies Record<string, TranslationValue>;
