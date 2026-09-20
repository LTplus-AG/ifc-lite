/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const clashGroupsEn = {
  'clashGroups.expand': 'Expand {name}',
  'clashGroups.collapse': 'Collapse {name}',
  'clashGroups.focus': 'Focus every object in this group',
  'clashGroups.createBcf': 'Create one BCF topic from this group',
  'clashGroups.rename': 'Rename this group',
  'clashGroups.ungroup': 'Ungroup these clashes',
  'clashGroups.select': 'Select clash {first} and {second}',
  'clashGroups.selectForGrouping': 'Select this clash for manual grouping',
  'clashGroups.removeMember': 'Remove this clash from the group',
  'clashGroups.createTitle': 'Group selected clashes',
  'clashGroups.renameTitle': 'Rename clash group',
  'clashGroups.createDescription': {
    one: '{count} selected clash will appear as one expandable coordination issue.',
    other: '{count} selected clashes will appear as one expandable coordination issue.',
  },
  'clashGroups.renameDescription': 'The group membership is unchanged.',
  'clashGroups.name': 'Group name',
  'clashGroups.cancel': 'Cancel',
  'clashGroups.create': 'Create group',
  'clashGroups.saveName': 'Save name',
  'clashGroups.view.pairs': 'Pairs',
  'clashGroups.view.issues': 'Issues',
  'clashGroups.view.groups': 'Groups',
  'clashGroups.viewTitle': 'Issues group nearby pairs within {distance}m; Groups are chosen and named by you',
  'clashGroups.issuePairs': '{issues} · {pairs}',
  'clashGroups.groupPairs': '{groups} · {pairs}',
  'clashGroups.clashSummary': '{clashes}',
  'clashGroups.clashSummaryShown': '{clashes} · {shown} shown',
  'clashGroups.clashSummaryIssues': '{clashes} · {issues}',
  'clashGroups.clashSummaryShownIssues': '{clashes} · {shown} shown · {issues}',
  'clashGroups.issueCount': { one: '{count} issue', other: '{count} issues' },
  'clashGroups.groupCount': { one: '{count} group', other: '{count} groups' },
  'clashGroups.pairCount': { one: '{count} pair', other: '{count} pairs' },
  'clashGroups.clashCount': { one: '{count} clash', other: '{count} clashes' },
  'clashGroups.severity.critical': 'Critical',
  'clashGroups.severity.major': 'Major',
  'clashGroups.severity.minor': 'Minor',
  'clashGroups.severity.info': 'Info',
} satisfies Record<string, TranslationValue>;
