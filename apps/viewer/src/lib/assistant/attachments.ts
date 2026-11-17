/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit, per-message grounding for the Assistant composer: the current
 * selection and an optional viewport screenshot. Selecting elements or moving
 * the camera attaches nothing; only these controls do, and an attachment is
 * sent with the next message and then cleared. For a model without image
 * input the screenshot control explains on click why it cannot attach, and the
 * request refuses an image for such a model rather than dropping it silently.
 */

import { selectionGroundingText, type SelectionGrounding } from '@/lib/actions/selection-grounding';
import { roomAttachmentText, type RoomGrounding } from '@/lib/actions/room-review';
import type { AssistantAttachments } from './request';
export interface ComposerAttachmentValue {
  selection: SelectionGrounding | null;
  screenshot: string | null;
  rooms?: RoomGrounding | null;
}

export const NO_ATTACHMENTS: ComposerAttachmentValue = { selection: null, screenshot: null };

/** What a send carries for `value`: nothing unless the user attached it. */
export function attachmentsForSend(value: ComposerAttachmentValue): AssistantAttachments {
  return {
    ...(value.selection ? { selection: selectionGroundingText(value.selection), selectionSnapshot: value.selection } : {}),
    ...(value.screenshot ? { screenshot: value.screenshot } : {}),
    ...(value.rooms ? { rooms: roomAttachmentText(value.rooms), roomSnapshot: value.rooms } : {}),
  };
}

