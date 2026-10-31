/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `customGrouping` rule chip (#8425, `CustomGroupingRuleEditor.tsx`): pick
 * a rule-based Lens as the grouping, then the groups (its rule names) to keep.
 */
export const customGroupingEn = {
  'customGrouping.pickGroupingAriaLabel': 'Pick a custom grouping',
  'customGrouping.pickGroupingPlaceholder': 'Pick grouping…',
  'customGrouping.noGroupingsYet': 'No custom groupings yet. Create a Lens with named rules first.',
  'customGrouping.unresolvedGrouping': 'The grouping "{name}" does not exist here. The rule matches nothing until you pick another or import it.',
  'customGrouping.unresolvedGroups': {
    one: 'The group {names} is not in this grouping. The rule matches nothing until it is fixed.',
    other: 'The groups {names} are not in this grouping. The rule matches nothing until they are fixed.',
  },
} as const;
