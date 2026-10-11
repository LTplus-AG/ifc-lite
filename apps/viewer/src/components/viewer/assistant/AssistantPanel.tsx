/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import '@/i18n/catalogues/semantic-assist.register';
import { History, Key, ListChecks, RefreshCw, Send, SlidersHorizontal, Sparkles, Square } from 'lucide-react';
import { ConversationLibrary } from './ConversationLibrary';
import { SourcePicker } from './SourcePicker';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { ModelSelector } from '../chat/ModelSelector';
import { ByokKeyModal } from '../chat/ByokKeyModal';
import { useAssistant, cancelAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent, type AssistantSource } from '@/lib/assistant/evidence';
import { ASSISTANT_PROXY_URL, sendAssistant } from '@/lib/assistant/request';
import { adapterFor } from '@/lib/assistant/adapters/registry';
import { isFlowSource, isReportSource } from '@/lib/assistant/sources';
import { resolveCapturedClash } from '@/lib/assistant/clash-group-proposal';
import { useClash } from '@/hooks/useClash';
import { EvidenceSummary } from './EvidenceSummary';
import { AssistantConversation } from './AssistantConversation';
import { FreeQuotaNote } from './AssistantUsage';
import { attachmentsForSend, ComposerAttachments, NO_ATTACHMENTS } from './ComposerAttachments';
import { declaresRoomCommand } from '@/lib/actions/room-command-proposal';
import { captureRoomGrounding } from '@/lib/actions/room-review';
import { RecipeRunCard } from './RecipeRunCard';
import { usePreferredModel } from '@/lib/assistant/reuse/preference-hooks';
import { takeDraftPrompt, useRecipeRun } from '@/lib/assistant/reuse/recipe-run';
import { AssistantAnnouncer, useAnswerFocus } from './AssistantAnnouncer';
import { AssistantPlacementMenu, AssistantReturnButton } from './AssistantPlacementMenu';
import { GenerationLanguagePicker } from './GenerationLanguagePicker';
import { TransientSurface } from './TransientSurface';
import { setAssistantDraft, useAssistantDraft } from '@/lib/assistant/composer-draft';
import type { ArtifactPreset } from '@/lib/assistant/artifacts/artifact-preset';

const FlowProposalReview = lazy(() => import('./FlowProposalReview').then(m => ({ default: m.FlowProposalReview })));
const ReportDraftReview = lazy(() => import('./ReportDraftReview').then(m => ({ default: m.ReportDraftReview })));
const ModelChangeProposal = lazy(() => import('./ModelChangeProposal').then(m => ({ default: m.ModelChangeProposal })));
const SceneActionReview = lazy(() => import('./SceneActionReview').then(m => ({ default: m.SceneActionReview })));
const SceneRestoreBar = lazy(() => import('./SceneActionReview').then(m => ({ default: m.SceneRestoreBar })));
const ClashGroupReview = lazy(() => import('./ClashGroupReview').then(m => ({ default: m.ClashGroupReview })));
const CheckAuthoringProposal = lazy(() => import('./CheckAuthoringProposal').then(m => ({ default: m.CheckAuthoringProposal })));
const ArtifactProposalReview = lazy(() => import('./ArtifactProposalReview').then(m => ({ default: m.ArtifactProposalReview })));
const SemanticProposalReview = lazy(() => import('./SemanticProposalReview').then(m => ({ default: m.SemanticProposalReview })));
const RecipeLibrary = lazy(() => import('./RecipeLibrary').then(m => ({ default: m.RecipeLibrary })));
const ProjectPreferences = lazy(() => import('./ProjectPreferences').then(m => ({ default: m.ProjectPreferences })));

export function AssistantPanel() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const state = useAssistant();
  const evidence = state.snapshot ?? state.archived?.evidence;
  const model = useViewerStore(s => s.chatActiveModel);
  const stale = useViewerStore(() => state.snapshot ? !evidenceIsCurrent(state.snapshot) : true);
  // Held outside the panel so a draft survives the narrow-layout sheet and host switches.
  const prompt = useAssistantDraft(s => s.text);
  useEffect(() => {
    const draft = useAssistantDraft.getState();
    if (draft.intent && draft.intent.evidenceId !== state.snapshot?.id) useAssistantDraft.setState({ intent: null });
  }, [state.snapshot?.id]);
  const [keysOpen, setKeysOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attachments, setAttachments] = useState(NO_ATTACHMENTS);
  const [sent, setSent] = useState(0);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  usePreferredModel();
  const { confirmDialog } = useDialogs();
  // Recipe prompts are taken once, but an unsent question requires approval.
  const recipeDraft = useRecipeRun(s => s.draftPrompt);
  useEffect(() => {
    const draft = recipeDraft === null ? null : takeDraftPrompt();
    if (draft === null) return;
    const previous = useAssistantDraft.getState().text;
    const apply = () => {
      if (useAssistantDraft.getState().text !== previous) return;
      setAssistantDraft(draft); promptRef.current?.focus();
    };
    if (!previous.trim() || previous === draft) { apply(); return; }
    void confirmDialog({ description: t('assistantRecipes.replaceDraft') }).then(approved => { if (approved) apply(); });
  }, [recipeDraft, confirmDialog, t]);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useAnswerFocus(scrollRef);
  const busy = state.status === 'streaming';
  const canAsk = !!state.snapshot && !busy && !stale;
  const errors = { 'missing-model': t('assistant.missingModel'), 'missing-key': t('assistant.missingKey'), 'context-limit': t('assistant.contextLimit'),
    'stale-evidence': t('assistant.stale'), 'truncated-output': t('assistant.truncated'), 'empty-output': t('assistant.emptyOutput'), 'request-timeout': t('assistant.timeout'),
    'budget-exhausted': t('assistantUsage.budgetExhausted'), 'image-unsupported': t('sceneActions.imageUnsupported'),
    'image-too-large': t('sceneActions.imageTooLarge') };
  const errorText = state.error && (errors[state.error as keyof typeof errors] ?? state.error);
  // Follow the newest turn without stealing focus from the composer.
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [state.messages.length, state.pendingPrompt, state.output, state.error]);
  const submit = () => {
    if (!prompt.trim() || !canAsk) return;
    const text = prompt;
    // Attachments go with this one message only, and only because the user attached them. A sent message
    // clears them and counts the send, so a capture still running then is dropped (one that landed meanwhile
    // is cleared with the rest); a refused send keeps the attachments, and a late capture, for the retry.
    const draft = useAssistantDraft.getState();
    const intent = draft.intent;
    const artifactPreset = draft.text === text && intent && intent.evidenceId === state.snapshot?.id ? intent.preset : undefined;
    void sendAssistant(text, model, ASSISTANT_PROXY_URL, attachmentsForSend(attachments), { artifactPreset }).then(success => {
      if (!success) return;
      if (useAssistantDraft.getState().text === text) setAssistantDraft('');
      setAttachments(NO_ATTACHMENTS);
      setSent(count => count + 1);
    });
  };
  const refresh = () => { if (evidence) replaceEvidence(captureEvidence(evidence.source)); };
  const suggest = (text: string, preset?: ArtifactPreset) => {
    setAssistantDraft(text, preset && state.snapshot ? { preset, evidenceId: state.snapshot.id } : null);
    promptRef.current?.focus();
  };
  const attach = async (source: AssistantSource) => {
    if (state.messages.length && !await confirmDialog({ description: t('assistant.switchConfirm') })) return;
    replaceEvidence(captureEvidence(source));
    setPicking(false);
    promptRef.current?.focus();
  };
  const showPicker = !evidence || picking;
  const { focusClash } = useClash();
  // Only live clash evidence can drive the scene; archived/stale rows stay read-only.
  const focusCitation = (citation: string) => {
    const clash = state.snapshot && !stale ? resolveCapturedClash(state.snapshot, citation) : null;
    return clash ? () => focusClash(clash) : null;
  };
  return <section className="h-full min-h-0 min-w-0 flex flex-col overflow-y-auto bg-background text-foreground" aria-label={t('assistant.title')}>
    <div className="shrink-0 flex items-center gap-1 border-b border-border px-3 py-2">
      <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <h2 className="text-sm font-semibold">{t('assistant.title')}</h2>
      <AssistantReturnButton />
      <div className="ml-auto flex shrink-0 items-center">
        <AssistantPlacementMenu />
        <IconButton label={t('assistant.savedConversations')} className="h-7 w-7" aria-pressed={libraryOpen} data-assistant-library-toggle=""
          onClick={() => setLibraryOpen(open => !open)}><History className="h-4 w-4" /></IconButton>
        <IconButton label={t('assistantRecipes.title')} className="h-7 w-7" aria-pressed={recipesOpen}
          onClick={() => setRecipesOpen(open => !open)}><ListChecks className="h-4 w-4" /></IconButton>
        <IconButton label={t('assistantReuse.prefsTitle')} className="h-7 w-7" aria-pressed={prefsOpen}
          onClick={() => setPrefsOpen(open => !open)}><SlidersHorizontal className="h-4 w-4" /></IconButton>
        <IconButton label={t('assistant.keys')} className="h-7 w-7" onClick={() => setKeysOpen(true)}><Key className="h-4 w-4" /></IconButton>
      </div>
    </div>
    {/* Short hosts scroll the whole panel; reserve readable space for evidence above the composer. */}
    <div ref={scrollRef} className="flex-1 min-h-40 overflow-auto">
      {libraryOpen && <TransientSurface label={t('assistant.savedConversations')} onClose={() => setLibraryOpen(false)}
        fallback="[data-assistant-library-toggle]"><ConversationLibrary /></TransientSurface>}
      {recipesOpen && <Suspense fallback={null}><RecipeLibrary /></Suspense>}
      {prefsOpen && <Suspense fallback={null}><ProjectPreferences /></Suspense>}
      <RecipeRunCard />
      {showPicker && evidence ? <TransientSurface label={t('assistant.pickTitle')} onClose={() => setPicking(false)}
        fallback="[data-assistant-change-source]">
        <SourcePicker current={evidence.source} onAttach={source => void attach(source)} onCancel={() => setPicking(false)} />
      </TransientSurface>
        : showPicker ? <SourcePicker current={null} onAttach={source => void attach(source)} onCancel={null} />
        : <EvidenceSummary evidence={evidence} state={state.archived ? 'historical' : stale ? 'stale' : 'captured'}
          onReturn={() => panels.openInHome(adapterFor(evidence.source).panelIds[0])} onRefresh={refresh} onChange={() => setPicking(true)} />}
      {!showPicker && <>
      {state.archived && <div aria-live="polite" className="mx-3 mt-2 rounded bg-muted p-2 text-xs space-y-2">
        <p className="text-muted-foreground">{t('assistant.archived')}</p>
        <Button size="sm" variant="outline" className="h-7" onClick={refresh}><RefreshCw className="h-3 w-3 mr-1" />{t('assistant.refreshShort')}</Button>
      </div>}
      <AssistantConversation source={evidence?.source ?? null} messages={state.messages} pendingPrompt={state.pendingPrompt}
        output={state.output} streaming={busy} error={errorText} canAsk={canAsk} onSuggest={suggest}
        evidencePayload={evidence?.payload ?? null} focusCitation={focusCitation} />
      {evidence?.source === 'clash' && <Suspense fallback={null}><ClashGroupReview /></Suspense>}
      {evidence && isFlowSource(evidence.source) && <Suspense fallback={null}><FlowProposalReview /></Suspense>}
      {evidence?.source === 'semantic' && <Suspense fallback={null}><SemanticProposalReview /></Suspense>}
      {evidence && (isReportSource(evidence.source) || declaresRoomCommand(state.messages.at(-1)?.content ?? '')) && <Suspense fallback={null}>
        <ModelChangeProposal onAttachRoom={review => setAttachments(current => ({ ...current, rooms: captureRoomGrounding(review) }))} />
      </Suspense>}
      {(evidence?.source === 'validation' || evidence?.source === 'loadReport') && <Suspense fallback={null}><CheckAuthoringProposal /></Suspense>}
      {evidence && isReportSource(evidence.source) && <Suspense fallback={null}><ReportDraftReview /></Suspense>}
      {evidence && !isFlowSource(evidence.source) && <Suspense fallback={null}><SceneActionReview /></Suspense>}
      {evidence && !isFlowSource(evidence.source) && <Suspense fallback={null}><ArtifactProposalReview onAsk={canAsk ? suggest : null} /></Suspense>}
      </>}
      <Suspense fallback={null}><SceneRestoreBar /></Suspense>
      <div ref={endRef} />
    </div>
    <form className="shrink-0 border-t border-border p-2 space-y-1" onSubmit={event => { event.preventDefault(); submit(); }}>
      <GenerationLanguagePicker disabled={busy} />
      <ComposerAttachments model={model} value={attachments} onChange={setAttachments} disabled={!canAsk} sent={sent} />
      <label className="sr-only" htmlFor="assistant-prompt">{t('assistant.prompt')}</label>
      {/* Stays editable while an answer streams, so typing the next question never loses focus; sending waits for canAsk. */}
      <textarea id="assistant-prompt" ref={promptRef} rows={2} maxLength={8000} disabled={!state.snapshot || stale} value={prompt}
        placeholder={t('assistant.placeholder')}
        className="w-full resize-none rounded border border-input bg-background p-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        onChange={event => setAssistantDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault(); submit();
        }} />
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0 flex-1 overflow-hidden"><ModelSelector /></div>
        {busy ? <Button type="button" size="sm" variant="outline" className="h-7 shrink-0" onClick={cancelAssistant}><Square className="h-3 w-3 mr-1" />{t('assistant.cancel')}</Button>
          : <Button type="submit" size="sm" className="h-7 shrink-0" disabled={!canAsk || !prompt.trim()}><Send className="h-3 w-3 mr-1" />{t('assistant.send')}</Button>}
      </div>
      <FreeQuotaNote model={model} proxyUrl={ASSISTANT_PROXY_URL} />
    </form>
    <AssistantAnnouncer />
    <ByokKeyModal open={keysOpen} onOpenChange={setKeysOpen} />
  </section>;
}
