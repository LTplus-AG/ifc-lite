/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Assistant scene actions (viewer AI P14): the proposal card, its review and
 * restore states (`SceneActionReview.tsx`), and the composer's explicit
 * selection / viewport-screenshot attachments (`ComposerAttachments.tsx`).
 */
export const sceneActionsEn = {
  'sceneActions.proposal': 'Scene action proposal',
  'sceneActions.proposalSummary': { one: '{count} view action', other: '{count} view actions' },
  'sceneActions.review': 'Show in the model',
  'sceneActions.inert': 'Nothing in the view changes until you apply. You can restore the previous view afterwards.',
  'sceneActions.select': 'Select',
  'sceneActions.isolate': 'Isolate',
  'sceneActions.hide': 'Hide',
  'sceneActions.colour': 'Colour',
  'sceneActions.frame': 'Frame',
  'sceneActions.section': 'Section',
  'sceneActions.camera': 'Camera',
  'sceneActions.elements': { one: '{count} element', other: '{count} elements' },
  'sceneActions.unresolved': { one: '{count} target not found or ambiguous', other: '{count} targets not found or ambiguous' },
  'sceneActions.stale': { one: '{count} citation needs current evidence', other: '{count} citations need current evidence' },
  'sceneActions.hiddenStay': { one: '{count} of them is hidden and stays hidden', other: '{count} of them are hidden and stay hidden' },
  'sceneActions.overlapping': { one: '{count} element named by two groups keeps its first colour', other: '{count} elements named by several groups keep their first colour' },
  'sceneActions.plane': 'Cut plane through ({x}, {y}, {z}) {units}, normal ({nx}, {ny}, {nz}); the side the normal points to is removed',
  'sceneActions.box': 'Section box from ({x1}, {y1}, {z1}) to ({x2}, {y2}, {z2}) {units}',
  'sceneActions.cameraAt': 'Look from ({x1}, {y1}, {z1}) at ({x2}, {y2}, {z2}) {units}',
  'sceneActions.refusedNoTargets': 'Refused: no target resolves in the loaded models',
  'sceneActions.refusedNoBounds': 'Refused: model bounds are not available yet',
  'sceneActions.refusedOutside': 'Refused: the coordinates lie outside the loaded models',
  'sceneActions.apply': { one: 'Apply {count} action', other: 'Apply {count} actions' },
  'sceneActions.nothingReady': 'Nothing in this proposal can be applied to the current view.',
  'sceneActions.applied': 'Applied to the view.',
  'sceneActions.appliedCount': '{action}: {count}',
  'sceneActions.unavailable': 'Not applied (the 3D view is not ready): {actions}',
  'sceneActions.restore': 'Restore previous view',
  'sceneActions.restored': 'Previous view restored.',
  'sceneActions.notRestored': 'Kept as you changed it since: {channels}',
  'sceneActions.modelsChanged': 'The loaded models changed since applying, so nothing was restored.',
  'sceneActions.activeTitle': 'Applied to the view: {title}',
  'sceneActions.channel.selection': 'selection',
  'sceneActions.channel.isolate': 'isolation',
  'sceneActions.channel.hide': 'hidden elements',
  'sceneActions.channel.colour': 'colours',
  'sceneActions.channel.section': 'section',
  'sceneActions.channel.camera': 'camera',
  'sceneActions.attachSelection': 'Attach selection',
  'sceneActions.attachSelectionCount': { one: 'Attach selection ({count})', other: 'Attach selection ({count})' },
  'sceneActions.attachSelectionEmpty': 'Select elements in the model to attach them',
  'sceneActions.selectionAttached': { one: 'Selection: {count} element', other: 'Selection: {count} elements' },
  'sceneActions.attachView': 'Attach view',
  'sceneActions.attachViewUnsupported': 'The selected model cannot read images',
  'sceneActions.viewAttached': 'Viewport screenshot',
  'sceneActions.viewCapturing': 'Capturing view…',
  'sceneActions.viewFailed': 'The view could not be captured.',
  'sceneActions.removeAttachment': 'Remove {name}',
  'sceneActions.attachmentsNote': 'Attachments are sent only with your next message.',
  'sceneActions.imageUnsupported': 'The selected model cannot read images. Remove the screenshot or choose a model with image input.',
  'sceneActions.imageTooLarge': 'The screenshot is too large to send. Remove it or make the view smaller.',
  'sceneActions.suggestShowClashes': 'Show me the elements of the most severe clashes',
  'sceneActions.suggestShowFailing': 'Show me the failing elements',
  'sceneActions.suggestShowChanged': 'Colour the changed elements by change type',
} as const satisfies Record<string, TranslationValue>;
