/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ComposerAttachmentValue } from './attachments';
import { attachmentsForSend } from './attachments';
const captures = new Map<string, { evidenceId: string; value: ComposerAttachmentValue }>();
export function storeAssistantAttachments(evidenceId: string, value: ComposerAttachmentValue) {
  const id = crypto.randomUUID(); if (captures.size >= 30) captures.delete(captures.keys().next().value!); captures.set(id, { evidenceId, value });
  return { attachment_id: id, evidence_id: evidenceId, selection_count: value.selection?.elements.length ?? 0, screenshot: !!value.screenshot, rooms: !!value.rooms };
}
export function assistantAttachmentsForSend(id: string, evidenceId: string) {
  const capture = captures.get(id); if (!capture || capture.evidenceId !== evidenceId) throw new Error('Assistant attachment capture is absent or belongs to different evidence.');
  return attachmentsForSend(capture.value);
}
export function removeAssistantAttachments(id: string) { return captures.delete(id); }
