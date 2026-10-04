/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { History, Key, RefreshCw, Send, Sparkles, Square } from 'lucide-react';
import { ConversationLibrary } from './ConversationLibrary';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { ModelSelector } from '../chat/ModelSelector';
import { ByokKeyModal } from '../chat/ByokKeyModal';
import { useAssistant, cancelAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';
import { sendAssistant } from '@/lib/assistant/request';
import { EvidenceSummary } from './EvidenceSummary';
import { AssistantConversation } from './AssistantConversation';

const FlowProposalReview = lazy(() => import('./FlowProposalReview').then(m => ({ default: m.FlowProposalReview })));
const ReportDraftReview = lazy(() => import('./ReportDraftReview').then(m => ({ default: m.ReportDraftReview })));
const ClashGroupReview = lazy(() => import('./ClashGroupReview').then(m => ({ default: m.ClashGroupReview })));

export function AssistantPanel() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const state = useAssistant();
  const evidence = state.snapshot ?? state.archived?.evidence;
  const model = useViewerStore(s => s.chatActiveModel);
  const stale = useViewerStore(() => state.snapshot ? !evidenceIsCurrent(state.snapshot) : true);
  const [prompt, setPrompt] = useState('');
  const [keysOpen, setKeysOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = state.status === 'streaming';
  const canAsk = !!state.snapshot && !busy && !stale;
  const errors = { 'missing-model': t('assistant.missingModel'), 'missing-key': t('assistant.missingKey'), 'context-limit': t('assistant.contextLimit'),
    'stale-evidence': t('assistant.stale'), 'truncated-output': t('assistant.truncated'), 'empty-output': t('assistant.emptyOutput'), 'request-timeout': t('assistant.timeout') };
  const errorText = state.error && (errors[state.error as keyof typeof errors] ?? state.error);
  // Follow the newest turn without stealing focus from the composer.
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [state.messages.length, state.pendingPrompt, state.output, state.error]);
  const submit = () => {
    if (!prompt.trim() || !canAsk) return;
    const text = prompt;
    void sendAssistant(text, model, import.meta.env.VITE_LLM_PROXY_URL || '/api/chat').then(success => {
      if (success) setPrompt(current => current === text ? '' : current);
    });
  };
  const refresh = () => { if (evidence) replaceEvidence(captureEvidence(evidence.source)); };
  const suggest = (text: string) => { setPrompt(text); promptRef.current?.focus(); };
  return <section className="h-full min-h-0 min-w-0 flex flex-col bg-background text-foreground" aria-label={t('assistant.title')}>
    <div className="shrink-0 flex items-center gap-1 border-b border-border px-3 py-2">
      <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
      <h2 className="text-sm font-semibold">{t('assistant.title')}</h2>
      <div className="ml-auto flex items-center">
        <IconButton label={t('assistant.savedConversations')} className="h-7 w-7" aria-pressed={libraryOpen}
          onClick={() => setLibraryOpen(open => !open)}><History className="h-4 w-4" /></IconButton>
        <IconButton label={t('assistant.keys')} className="h-7 w-7" onClick={() => setKeysOpen(true)}><Key className="h-4 w-4" /></IconButton>
      </div>
    </div>
    {/* One scroll region: short docked panels keep the header and composer reachable. */}
    <div className="flex-1 min-h-0 overflow-auto">
      {libraryOpen && <ConversationLibrary />}
      {evidence ? <EvidenceSummary evidence={evidence} state={state.archived ? 'historical' : stale ? 'stale' : 'captured'}
        onReturn={() => panels.openInHome(evidence.source)} onRefresh={refresh} />
        : <div className="shrink-0 border-b border-border p-3 text-xs space-y-1">
          <p className="font-semibold">{t('assistant.emptyTitle')}</p>
          <p className="text-muted-foreground">{t('assistant.empty')}</p>
        </div>}
      {state.archived && <div aria-live="polite" className="mx-3 mt-2 rounded bg-muted p-2 text-xs space-y-2">
        <p className="text-muted-foreground">{t('assistant.archived')}</p>
        <Button size="sm" variant="outline" className="h-7" onClick={refresh}><RefreshCw className="h-3 w-3 mr-1" />{t('assistant.refreshShort')}</Button>
      </div>}
      <AssistantConversation source={evidence?.source ?? null} messages={state.messages} pendingPrompt={state.pendingPrompt}
        output={state.output} streaming={busy} error={errorText} canAsk={canAsk} onSuggest={suggest} />
      {evidence?.source === 'clash' && <Suspense fallback={null}><ClashGroupReview /></Suspense>}
      {evidence?.source === 'flow' && <Suspense fallback={null}><FlowProposalReview /></Suspense>}
      {evidence && evidence.source !== 'flow' && <Suspense fallback={null}><ReportDraftReview /></Suspense>}
      <div ref={endRef} />
    </div>
    <form className="shrink-0 border-t border-border p-2 space-y-1" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="sr-only" htmlFor="assistant-prompt">{t('assistant.prompt')}</label>
      <textarea id="assistant-prompt" ref={promptRef} rows={2} maxLength={8000} disabled={!canAsk} value={prompt}
        placeholder={t('assistant.placeholder')}
        className="w-full resize-none rounded border border-input bg-background p-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        onChange={event => setPrompt(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault(); submit();
        }} />
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0 flex-1 overflow-hidden"><ModelSelector /></div>
        {busy ? <Button type="button" size="sm" variant="outline" className="h-7 shrink-0" onClick={cancelAssistant}><Square className="h-3 w-3 mr-1" />{t('assistant.cancel')}</Button>
          : <Button type="submit" size="sm" className="h-7 shrink-0" disabled={!canAsk || !prompt.trim()}><Send className="h-3 w-3 mr-1" />{t('assistant.send')}</Button>}
      </div>
    </form>
    <ByokKeyModal open={keysOpen} onOpenChange={setKeysOpen} />
  </section>;
}
