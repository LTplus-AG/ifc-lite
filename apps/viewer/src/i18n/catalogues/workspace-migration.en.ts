/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';


/** Layout migration, unavailable extension placements and artifact links (#6927). */
export const workspaceMigrationEn = {
  'workspaceMigration.layout.title': 'Review your updated layout',
  'workspaceMigration.layout.summary': '{count} layout changes are ready to review. Your saved work is preserved.',
  'workspaceMigration.layout.showChanges': 'Show changes',
  'workspaceMigration.layout.hideChanges': 'Hide changes',
  'workspaceMigration.layout.keep': 'Keep layout',
  'workspaceMigration.layout.reset': 'Reset layout',
  'workspaceMigration.layout.added': 'Added {panel} after {anchor}.',
  'workspaceMigration.layout.addedTop': 'Added {panel} to the panel list.',
  'workspaceMigration.layout.renamed': 'Renamed {from} to {panel}.',
  'workspaceMigration.layout.restored': 'Restored {panel} to the panel list.',
  'workspaceMigration.layout.preserved': 'Kept the unavailable placement {id} for later.',
  'workspaceMigration.layout.regrouped': 'Updated panel groups.',
  'workspaceMigration.layout.mode': 'Updated the sidebar mode.',
  'workspaceMigration.layout.unreadable': 'The saved layout could not be read. The original is kept for recovery.',
  'workspaceMigration.placement.title': 'Unavailable extension placements',
  'workspaceMigration.placement.notRendered': 'The viewer has no surface for {slot}. The placement is preserved.',
  'workspaceMigration.placement.hostOwned': 'The viewer owns {slot}; extensions cannot replace this surface.',
  'workspaceMigration.placement.unknownSlot': 'The slot {slot} is unknown. The placement is preserved.',
  'workspaceMigration.deepLink.copy': 'Copy link',
  'workspaceMigration.deepLink.copyNamed': 'Copy link to {name}',
  'workspaceMigration.deepLink.copied': 'Link copied',
  'workspaceMigration.deepLink.copyFailed': 'The link could not be copied.',
  'workspaceMigration.deepLink.failed': 'The linked item could not be opened.',
  'workspaceMigration.deepLink.busy': 'Wait for the current request to finish, then open the link again.',
  'workspaceMigration.deepLink.unavailable': 'The linked item is unavailable in this browser.',
  'workspaceMigration.deepLink.missingConversation': 'This saved conversation was not found in this browser.',
  'workspaceMigration.deepLink.missingReceipt': 'This request receipt was not found in this session.',
  'workspaceMigration.deepLink.missingBcfDraft': 'This BCF draft was not found in this browser.',
  'workspaceMigration.deepLink.unknownPanel': 'The link names an unknown panel.',
  'workspaceMigration.deepLink.conflicting': 'The link contains conflicting destinations.',
  'workspaceMigration.deepLink.invalidId': 'The link contains an invalid item identifier.',
} as const satisfies Record<string, TranslationValue>;
