/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Annotate tool's own chrome (#4918 slice: annotations), covering the
 * canvas-overlay pin (the shared `Pin` scene primitive, `AnnotationLayer.tsx`
 * registers it on the projector — #5511), the read/edit popover for an
 * existing pin (`AnnotationPopover.tsx`), and the inline
 * commit-or-cancel input shown while dropping a fresh pin
 * (`AnnotationDropInput.tsx`). An annotation's own note TEXT and its
 * resolved entity TYPE NAME are model/runtime content and stay out of the
 * catalogue; only the surrounding labels, hints, and relative-time phrasing
 * are translated here.
 */
export const annotationsEn = {
  // AnnotationDropInput
  'annotations.dropInput.ariaLabel': 'New annotation',
  'annotations.dropInput.promptLabel': "What's worth noting?",
  'annotations.dropInput.placeholder': 'A short note — flag a defect, ask a question, leave context…',
  'annotations.dropInput.keyHints': '⏎ save · ⇧⏎ newline · esc cancel',
  'annotations.dropInput.cancelButton': 'Cancel',
  'annotations.dropInput.dropPinButton': 'Drop pin',

  // AnnotationLayer
  'annotations.layer.ariaLabel': 'Annotations layer',
  'annotations.layer.emptyNotePreview': '(empty note)',

  // AnnotationLayer's Pin instances
  'annotations.pin.ariaLabelWithPreview': 'Annotation {index}: {preview}',
  'annotations.pin.ariaLabelNoPreview': 'Annotation {index}',

  // AnnotationPopover
  'annotations.popover.ariaLabel': 'Annotation',
  'annotations.popover.headerFallbackLabel': 'Annotation',
  'annotations.popover.closeButtonTitle': 'Close',
  'annotations.popover.placeholder': 'Note about this point…',
  'annotations.popover.keyHints': '⏎ save · ⇧⏎ newline · esc cancel',
  'annotations.popover.cancelButton': 'Cancel',
  'annotations.popover.saveButton': 'Save',
  'annotations.popover.emptyNoteHint': '(no note — click the pen icon to add one)',
  'annotations.popover.editedSuffix': '· edited',
  'annotations.popover.editButtonTitle': 'Edit note',
  'annotations.popover.deleteButtonTitle': 'Delete annotation',
  'annotations.popover.relativeJustNow': 'just now',
  'annotations.popover.relativeMinutesAgo': '{count}m ago',
  'annotations.popover.relativeHoursAgo': '{count}h ago',
  'annotations.popover.relativeDaysAgo': '{count}d ago',
} as const satisfies Record<string, TranslationValue>;
