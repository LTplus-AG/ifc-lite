/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Filter tab's group UI (#4904): "Add group" and its group-tabs row
 * (`SearchModal.filter.groupTabs.tsx`), the run-bar rule/group-count badge
 * (`SearchModal.filter.ruleSummary.tsx`), and the selector field's
 * applied-groups readback (`SearchModal.filter.selector.tsx`) plus the
 * preset-menu's group-count summary line
 * (`SearchModal.filter.builder.tsx`).
 *
 * Deliberately NOT covered: every OTHER hardcoded string already in these
 * four files (chip labels, "Save"/"Reset"/"Presets", the empty-rules
 * placeholder, …) predates #4904 and is not part of this change's own
 * literal-count delta — the i18n-literals ratchet
 * (`scripts/check-i18n-literals.mjs`) only requires a file's count not
 * RISE, not that every file be fully converted in one PR.
 */
export const filterGroupsEn = {
  'filterGroups.addGroup': 'Add group',
  'filterGroups.addGroupTitle': 'Add another OR group — "+" in selector text',
  'filterGroups.tabsAriaLabel': 'Filter groups',
  'filterGroups.groupLabel': 'Group {index}',
  'filterGroups.removeGroupAriaLabel': 'Remove group {index}',
  'filterGroups.noRules': 'No rules — add one to run.',
  'filterGroups.ruleCount': { one: '{count} rule', other: '{count} rules' },
  'filterGroups.groupCountOr': { one: '{count} group (OR)', other: '{count} groups (OR)' },
  'filterGroups.limit': 'limit',
  'filterGroups.readbackTitle':
    'The current filter, as selector text — a second group (Add group, below) shows up here joined with "+".',
} satisfies Record<string, TranslationValue>;
