/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const changesPanelEn = {
  'changesPanel.title': 'Changes',
  'changesPanel.close': 'Close Changes',
  'changesPanel.empty': 'No recorded edit operations.',
  'changesPanel.rowCount': { one: '{count} edit', other: '{count} edits' },
  'changesPanel.entity': '{type} #{id}',
  'changesPanel.georeference': 'Georeference',
  'changesPanel.modelMetadata': 'Model metadata',
  'changesPanel.jump': 'Jump to {entity} in {model}',
  'changesPanel.revert': 'Revert',
  'changesPanel.revertUnavailable': 'This edit cannot be safely reverted while newer edits depend on it.',
  'changesPanel.revertStale': 'The edit changed. Review the current list and try again.',
  'changesPanel.revertPermission': 'Turn on Edit mode or ask for editing access before reverting.',
  'changesPanel.revertSharedRoom': 'Leave the shared room before reverting an edit. The room cannot sync this reversal yet.',
  'changesPanel.revertUnsupported': 'This edit cannot be reversed from the drawer. Use Undo when it is the newest step.',
} as const;
