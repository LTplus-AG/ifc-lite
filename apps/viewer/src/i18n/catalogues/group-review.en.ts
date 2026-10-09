/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationValue } from '../types';
export const groupReviewEn = {
  'groupReview.title': 'Review group changes',
  'groupReview.hint': 'Select changes, then review the group names and complete membership. Removing a group keeps its members and their other memberships.',
  'groupReview.prepare': 'Review selected group changes',
  'groupReview.acknowledgement': 'I have reviewed the complete membership and shared references.',
  'groupReview.population': 'Native records: {created} created · {modified} modified · {deleted} deleted',
  'groupReview.nativeChanges': 'Inspect group changes and shared references',
  'groupReview.receiptProblem': 'The changes were applied, but their receipt could not be saved. Undo remains available in the edit history.',
  'groupReview.op.group.create': 'Create group',
  'groupReview.op.group.update': 'Update group and replace complete membership',
  'groupReview.op.group.remove': 'Remove group',
} as const satisfies Record<string, TranslationValue>;
