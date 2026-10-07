/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useDialogs } from '@/components/ui/confirm-dialog';
import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { useAssistant } from '@/lib/assistant/conversation';
import { assistantLibrary, openConversation, useAssistantLibrary } from '@/lib/assistant/library';
import { decodeConversation } from '@/lib/assistant/persistence';
import { ContentStorageNotice } from '../ContentStorageNotice';

export function ConversationLibrary() {
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  const { entries, status } = useAssistantLibrary();
  const state = useAssistant();
  const model = useViewerStore(s => s.chatActiveModel);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const save = async () => {
    const evidence = state.snapshot ?? state.archived?.evidence;
    if (!evidence || state.status === 'streaming') return;
    const entry = decodeConversation({ version: 1, id: state.snapshot?.id ?? state.archived!.id,
      name: name.trim() || state.archived?.name || t('assistant.title'), savedAt: new Date().toISOString(),
      model: state.archived?.model ?? model,
      evidence: { source: evidence.source, capturedAt: evidence.capturedAt, payload: evidence.payload,
        totalRows: evidence.totalRows, includedRows: evidence.includedRows, projectionTruncated: evidence.projectionTruncated },
      messages: state.messages, language: state.language });
    if (!entry) { setInvalid(true); return; }
    setInvalid(false); setBusy(true);
    try { await assistantLibrary.put(entry.id, entry); }
    finally { setBusy(false); }
  };
  return <section aria-label={t('assistant.savedConversations')} className="border-b border-border bg-muted/20 text-xs shrink-0">
    <div className="p-3 space-y-2">
      <h3 className="font-semibold">{t('assistant.savedConversations')}</h3>
      <p className="text-muted-foreground">{t('assistant.saveHint')}</p>
      <label className="sr-only" htmlFor="assistant-conversation-name">{t('assistant.conversationName')}</label>
      <div className="flex items-center gap-1">
        <input id="assistant-conversation-name" className="min-w-0 flex-1 h-7 border border-input rounded bg-background px-2" value={name}
          maxLength={200} placeholder={t('assistant.conversationName')} onChange={event => setName(event.target.value)} />
        <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={busy || state.status === 'streaming' || (!state.snapshot && !state.archived)} onClick={() => void save()}>{t('assistant.saveConversation')}</Button>
      </div>
      {invalid && <p role="alert">{t('assistant.invalidConversation')}</p>}
      {entries.map(entry => <div key={entry.id} className="flex items-center gap-1">
        <Button size="sm" variant="ghost" className="min-w-0 flex-1 justify-start truncate" disabled={busy || state.status === 'streaming'} onClick={() => void (async () => {
          if (state.messages.length && !await confirmDialog({ description: t('assistant.openConfirm') })) return;
          openConversation(entry);
        })()}>{entry.name}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void assistantLibrary.put(entry.id, null)}>{t('assistant.deleteConversation')}</Button>
      </div>)}
    </div>
    <ContentStorageNotice status={status} retry={assistantLibrary.retry} restore={assistantLibrary.restore} />
  </section>;
}
