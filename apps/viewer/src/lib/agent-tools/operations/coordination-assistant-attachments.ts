/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { useAssistant } from '@/lib/assistant/conversation';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { storeAssistantAttachments, removeAssistantAttachments } from '@/lib/assistant/attachment-library';
import { coordination, idSchema } from './coordination-common';
export const coordinationAssistantAttachmentOperations = [
  coordination<{ evidence_id: string; selection: boolean; screenshot: boolean; room_candidate_id: string; room_model_id: string }>('assistant.captureAttachments', 'Explicitly capture the native selected-element ownership sidecar, compressed viewport screenshot and/or prepared native Room review for exactly one evidence conversation. Returns an opaque per-send attachment handle; no attachment is sent automatically.', ['configuration', 'view'], {
    type: 'object', properties: { evidence_id: { type: 'string', minLength: 1, maxLength: 200 }, selection: { type: 'boolean' }, screenshot: { type: 'boolean' }, room_candidate_id: { type: 'string', maxLength: 200 }, room_model_id: { type: 'string', maxLength: 200 } }, required: ['evidence_id', 'selection', 'screenshot', 'room_candidate_id', 'room_model_id'], additionalProperties: false,
  }, async (i, c) => {
    if (useAssistant.getState().snapshot?.id !== i.evidence_id) throw new Error('Native assistant evidence changed.');
    if (!i.selection && !i.screenshot && !i.room_candidate_id) throw new Error('Select at least one explicit native attachment source.');
    const selection = i.selection ? captureSelectionGrounding(useViewerStore.getState()) : null;
    // A requested selection must exist: no selected element is a refusal, not an empty attachment.
    if (i.selection && !selection?.elements.length) throw new Error('Native selection is empty.');
    let screenshot: string | null = null;
    if (i.screenshot) { const [{ getModelById }, { captureViewportScreenshot }] = await Promise.all([import('@/lib/llm/models'), import('@/components/viewer/assistant/viewport-screenshot')]); if (getModelById(useViewerStore.getState().chatActiveModel)?.supportsImages !== true) throw new Error('The current native assistant model does not accept image attachments.'); screenshot = await captureViewportScreenshot(); if (!screenshot) throw new Error('Native viewport capture failed.'); }
    const rooms = i.room_candidate_id ? await (await import('./authoring-graphs')).captureRoomGroundingForCandidate(c.host, i.room_candidate_id, i.room_model_id) : null;
    return c.commit(() => { if (useAssistant.getState().snapshot?.id !== i.evidence_id) throw new Error('Native assistant evidence changed during capture.'); return storeAssistantAttachments(i.evidence_id, { selection, screenshot, rooms }); });
  }),
  coordination('assistant.removeAttachments', 'Discard one opaque native per-send attachment capture without sending it.', ['configuration'], idSchema, (i, c) => c.commit(() => ({ removed: removeAssistantAttachments(i.id) }))),
];
