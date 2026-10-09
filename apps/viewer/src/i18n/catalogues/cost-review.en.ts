/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationValue } from '../types';
export const costReviewEn = {
  'costReview.title': 'Review supplied costs',
  'costReview.hint': 'Review only the supplied amounts and native units. No price, rate or currency is inferred. Select operations, then inspect the complete native changes before Apply.',
  'costReview.prepare': 'Review selected cost operations',
  'costReview.references': 'Native target: {target} · related records: {related}',
  'costReview.detach': 'Detach shared references using the native removal rules. Inspect all changed and deleted records below.',
  'costReview.population': '{records} source records reviewed · {created} created · {modified} modified · {deleted} deleted. Created IFC identities are assigned at Apply.',
  'costReview.nativeChanges': 'Inspect native IFC changes, including shared references and deletions',
  'costReview.receiptProblem': 'The changes were applied, but their receipt could not be saved. The native edit history still contains the changes.',
  'costReview.op.cost.schedule.create': 'Create cost schedule',
  'costReview.op.cost.item.create': 'Create cost item',
  'costReview.op.cost.value.create': 'Create supplied cost value',
  'costReview.op.cost.quantity.create': 'Create supplied quantity',
  'costReview.op.cost.items.nest': 'Nest cost items',
  'costReview.op.cost.schedule.assign': 'Assign items to schedule',
  'costReview.op.cost.item.assign': 'Assign objects to cost item',
  'costReview.op.cost.item.values': 'Replace item cost values',
  'costReview.op.cost.remove': 'Remove cost record',
} as const satisfies Record<string, TranslationValue>;
