/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationValue } from '../types';
export const structuralReviewEn = {
  'structuralReview.title': 'Review supplied analytical graph',
  'structuralReview.hint': 'Review only supplied geometry, restraints and load components. This creates IFC records; it does not solve or validate an engineering design. Select operations, then inspect the complete native changes before Apply.',
  'structuralReview.prepare': 'Review selected structural operations',
  'structuralReview.references': 'Native target: {target} · related records: {related}',
  'structuralReview.acknowledgement': 'I confirm the load and stiffness values are supplied in the model’s native measures. No conversion or missing unit declaration is assumed.',
  'structuralReview.previewUnavailable': 'An analytical geometry preview is unavailable here. Inspect the native IFC records before Apply.',
  'structuralReview.population': '{records} source records reviewed · {created} created · {modified} modified · {deleted} deleted. Created IFC identities are assigned at Apply.',
  'structuralReview.units': 'Inspect declared native units and unavailable declarations',
  'structuralReview.nativeChanges': 'Inspect native IFC changes, including shared references and deletions',
  'structuralReview.receiptProblem': 'The changes were applied, but their receipt could not be saved. The native edit history still contains the changes.',
  'structuralReview.op.structural.analysis.create': 'Create analytical model',
  'structuralReview.op.structural.member.create': 'Create analytical curve member',
  'structuralReview.op.structural.connection.create': 'Create analytical point connection',
  'structuralReview.op.structural.group.create': 'Create supplied load group',
  'structuralReview.op.structural.pointAction.create': 'Create supplied point action',
  'structuralReview.op.structural.linearAction.create': 'Create supplied linear action',
  'structuralReview.op.structural.member.connect': 'Connect member and connection',
  'structuralReview.op.structural.activity.connect': 'Connect supplied activity to item',
  'structuralReview.op.structural.group.assign': 'Assign supplied objects to group',
} as const satisfies Record<string, TranslationValue>;
