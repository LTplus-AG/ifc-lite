/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { Key, RefreshCw, Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import { usePanelControls } from '@/hooks/usePanelControls';
import { ModelSelector } from '../chat/ModelSelector';
import { ByokKeyModal } from '../chat/ByokKeyModal';
import { useAssistant, cancelAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence, sourceIdentity } from '@/lib/assistant/evidence';
import { sendAssistant } from '@/lib/assistant/request';

export function AssistantPanel() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const state = useAssistant();
  const model = useViewerStore(s => s.chatActiveModel);
  const identity = useViewerStore(() => state.snapshot ? sourceIdentity(state.snapshot.source) : null);
  const contextStale = useAnalysisStaleness(state.snapshot?.contextStamp ?? null);
  const reportStale = useAnalysisStaleness(state.snapshot?.reportStamp ?? null);
  const stale = contextStale || reportStale || identity !== state.snapshot?.sourceIdentity;
  const [prompt, setPrompt] = useState('');
  const [keysOpen, setKeysOpen] = useState(false);
  const busy = state.status === 'streaming';
  const errors = { 'missing-key': t('assistant.missingKey'), 'context-limit': t('assistant.contextLimit'),
    'stale-evidence': t('assistant.stale'), 'truncated-output': t('assistant.truncated'), 'empty-output': t('assistant.emptyOutput'), 'request-timeout': t('assistant.timeout') };
  const errorText = state.error && (errors[state.error as keyof typeof errors] ?? state.error);
  const submit = () => {
    if (!prompt.trim() || busy || stale) return;
    const text = prompt;
    void sendAssistant(text, model, import.meta.env.VITE_LLM_PROXY_URL || '/api/chat').then(success => {
      if (success) setPrompt(current => current === text ? '' : current);
    });
  };
  return <section className="h-full min-h-0 flex flex-col bg-background text-foreground" aria-label={t('assistant.title')}>
    <div className="flex items-center gap-2 border-b border-border p-3">
      <h2 className="text-sm font-semibold">{t('assistant.title')}</h2>
      <div className="ml-auto"><IconButton label={t('assistant.keys')} onClick={() => setKeysOpen(true)}><Key className="h-4 w-4" /></IconButton></div>
    </div>
    <div className="p-3 border-b border-border space-y-2">
      <ModelSelector />
      {state.snapshot ? <>
        <Button variant="outline" size="sm" onClick={() => panels.openInHome(state.snapshot!.source)}>{t('assistant.returnSource')}</Button>
        <p className="text-xs text-muted-foreground">{t('assistant.scope', { included: state.snapshot.includedRows, total: state.snapshot.totalRows })}</p>
        {state.snapshot.projectionTruncated && <p className="text-xs text-muted-foreground">{t('assistant.evidenceTruncated')}</p>}
        <p className="text-2xs text-muted-foreground">{state.snapshot.capturedAt}</p>
        <p className="text-xs text-muted-foreground">{t('assistant.sessionOnly')}</p>
        {stale && <output className="block text-xs text-amber-600">{t('assistant.stale')}</output>}
        <Button variant="outline" size="sm" onClick={() => replaceEvidence(captureEvidence(state.snapshot!.source))}>
          <RefreshCw className="h-3 w-3 mr-1" />{t('assistant.refresh')}
        </Button>
        <details className="text-xs"><summary>{t('assistant.evidence')}</summary><pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto">{state.snapshot.payload}</pre></details>
      </> : <p className="text-xs text-muted-foreground">{t('assistant.empty')}</p>}
    </div>
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3" aria-live="polite">
      {state.messages.map((message, i) => <div key={i} className="text-xs whitespace-pre-wrap break-words">
        <p className="font-semibold mb-1">{message.role === 'user' ? t('assistant.you') : t('assistant.title')}</p>
        {typeof message.content === 'string' ? message.content : null}
      </div>)}
      {state.pendingPrompt && <p className="text-xs whitespace-pre-wrap break-words">{state.pendingPrompt}</p>}
      {state.output && <p className="text-xs whitespace-pre-wrap break-words">{state.output}</p>}
      {state.error && <p role="alert" className="text-xs text-destructive">{errorText}</p>}
    </div>
    <form className="p-3 border-t border-border space-y-2" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="text-xs" htmlFor="assistant-prompt">{t('assistant.prompt')}</label>
      <textarea id="assistant-prompt" className="w-full rounded border border-input bg-background p-2 text-xs" rows={3}
        value={prompt} maxLength={8000} disabled={!state.snapshot || busy || stale} onChange={event => setPrompt(event.target.value)} />
      <div className="flex justify-end">
        {busy ? <Button type="button" size="sm" variant="outline" onClick={cancelAssistant}><Square className="h-3 w-3 mr-1" />{t('assistant.cancel')}</Button>
          : <Button type="submit" size="sm" disabled={!state.snapshot || !prompt.trim() || stale}><Send className="h-3 w-3 mr-1" />{t('assistant.send')}</Button>}
      </div>
    </form>
    <ByokKeyModal open={keysOpen} onOpenChange={setKeysOpen} />
  </section>;
}
