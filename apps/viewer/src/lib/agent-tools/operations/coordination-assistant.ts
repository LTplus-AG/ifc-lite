/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ASSISTANT_SOURCES, type AssistantSource } from '@/lib/assistant/sources';
import { coordination } from './coordination-common';
import { stale, unavailable } from './refusals';
export const coordinationAssistantOperations = [
  coordination<{ source: AssistantSource }>('assistant.captureEvidence', 'Capture one explicitly selected native evidence source and reset the assistant conversation using its native budget/provenance lifecycle.', ['configuration'], {
    type: 'object', properties: { source: { type: 'string', enum: [...ASSISTANT_SOURCES] } }, required: ['source'], additionalProperties: false,
  }, async (i, c) => {
    const [{ captureEvidence }, { replaceEvidence }] = await Promise.all([import('@/lib/assistant/evidence'), import('@/lib/assistant/conversation')]);
    return c.commit(() => { const snapshot = captureEvidence(i.source); replaceEvidence(snapshot); return { evidence_id: snapshot.id, source: snapshot.source }; });
  }),
  coordination<{ prompt: string; evidence_id: string; attachment_id?: string }>('assistant.send', 'Send one prompt against an exact native evidence snapshot using the already configured provider, credentials, entitlement and root budget. Awaits the actual streaming terminal response; cancellation aborts only this request.', ['network', 'configuration'], {
    type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 }, evidence_id: { type: 'string', minLength: 1, maxLength: 200 }, attachment_id: { type: 'string', nullable: true, minLength: 1, maxLength: 200 } }, required: ['prompt', 'evidence_id'], additionalProperties: false,
  }, async (i, c) => {
    const [{ sendAssistant, ASSISTANT_PROXY_URL }, { useAssistant, cancelAssistant }, { useViewerStore }] = await Promise.all([import('@/lib/assistant/request'), import('@/lib/assistant/conversation'), import('@/store')]);
    if (useAssistant.getState().snapshot?.id !== i.evidence_id) throw stale('Assistant evidence changed; inspect or capture the intended source first.');
    if (useAssistant.getState().status === 'streaming') throw unavailable('A native assistant request is already streaming.');
    let owned: AbortController | null = null;
    const cancel = () => { if (owned && useAssistant.getState().controller === owned) cancelAssistant(); };
    c.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const completed = await c.commitAsync(async () => {
        if (useAssistant.getState().snapshot?.id !== i.evidence_id) throw stale('Assistant evidence changed before request admission.');
        const { assistantAttachmentsForSend, removeAssistantAttachments } = await import('@/lib/assistant/attachment-library');
        const attachments = i.attachment_id ? assistantAttachmentsForSend(i.attachment_id, i.evidence_id) : {};
        c.checkpoint?.(); if (useAssistant.getState().snapshot?.id !== i.evidence_id || useAssistant.getState().status === 'streaming') throw stale('Native assistant evidence or request ownership changed before admission.');
        const pending = sendAssistant(i.prompt, useViewerStore.getState().chatActiveModel, ASSISTANT_PROXY_URL, attachments);
        owned = useAssistant.getState().controller; if (c.signal?.aborted) cancel(); const success = await pending; if (success && i.attachment_id) removeAssistantAttachments(i.attachment_id); return success;
      });
      const state = useAssistant.getState(); return { completed, status: state.status, error: state.error, messages: state.messages, budget: state.budget };
    } finally { c.signal?.removeEventListener('abort', cancel); }
  }),
];
