/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS agent in the Assistant (IDS-081, IDS-082, IDS-085, IDS-086). It
 * supersedes the JSON `ids.specifications` proposal: the agent drafts with
 * tools against the grounding gate, the user reviews each change (sources,
 * live counts, unresolved statements, decisions), and the kept changes go
 * through the same native gates as before (audit, dry run, save or export).
 */

import { useState } from 'react';
import { ClipboardCheck, RotateCcw, Sparkles, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useAssistantDraft } from '@/lib/assistant/composer-draft';
import { answerIdsAgentQuestion, acceptedIdsDraft, cancelIdsAgentRun, resetIdsAgent, setIdsAgentSelection, startIdsAgentRun, useIdsAgent } from '@/lib/ids-agent/run';
import type { IdsDraft } from '@/lib/check-authoring/ids-draft';
import { IdsDraftChecks } from '../check-authoring/IdsDraftChecks';
import { Notice, ReviewCard } from '../check-authoring/DraftParts';
import { IdsAgentProposal } from './IdsAgentProposal';
import { IdsAgentPrivacy } from './IdsAgentPrivacy';

const ROUTE_ERRORS = new Set(['missing-model', 'missing-key', 'needs-key']);

function Question() {
  const { t } = useTranslation();
  const question = useIdsAgent(s => s.question);
  if (!question) return null;
  return <section aria-label={t('idsAgent.question')} className="rounded border border-primary/40 bg-primary/5 p-2 space-y-1">
    <p className="font-medium">{t('idsAgent.question')}</p>
    <p className="break-words">{question.question}</p>
    <div className="flex flex-col gap-1">
      {question.choices.map((choice, index) => <Button key={index} size="sm" variant="outline" className="h-auto min-h-7 justify-start whitespace-normal text-left"
        onClick={() => answerIdsAgentQuestion(index)}>
        <span>{choice.label}{choice.rationale && <span className="block text-2xs text-muted-foreground">{choice.rationale}</span>}</span>
      </Button>)}
      <Button size="sm" variant="ghost" className="h-7 justify-start" onClick={() => answerIdsAgentQuestion(null)}>{t('idsAgent.dismiss')}</Button>
    </div>
  </section>;
}

function Progress() {
  const { t } = useTranslation();
  const progress = useIdsAgent(s => s.progress);
  const text = useIdsAgent(s => s.text);
  return <div aria-live="polite" className="space-y-1">
    <p className="text-muted-foreground">{t('idsAgent.running')}</p>
    {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
    <ul className="pl-2 space-y-0.5 text-2xs">
      {progress.slice(-8).map((line, index) => <li key={index} className={line.ok === false ? 'text-amber-700 dark:text-amber-400 break-words' : 'text-muted-foreground break-words'}>{line.text}</li>)}
    </ul>
  </div>;
}

export function IdsAgentReview() {
  const { t } = useTranslation();
  const state = useIdsAgent();
  const prompt = useAssistantDraft(s => s.text);
  const model = useViewerStore(s => s.chatActiveModel);
  const [draft, setDraft] = useState<{ draft: IdsDraft; rejected: string[] } | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const start = () => { setDraft(null); setAcceptError(null); void startIdsAgentRun({ request: prompt, model }); };
  const accept = () => {
    acceptedIdsDraft().then(setDraft, (error: unknown) => setAcceptError(error instanceof Error ? error.message : String(error)));
  };
  const run = state.run;
  const stopped = run && run.status !== 'completed' ? run.proposal.status : null;
  return <ReviewCard label={t('idsAgent.title')} icon={<ClipboardCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}>
    {state.phase === 'idle' && <>
      <p className="text-muted-foreground">{t('idsAgent.intro')}</p>
      <Button size="sm" className="h-7" disabled={!prompt.trim()} onClick={start}><Sparkles className="h-3 w-3 mr-1" />{t('idsAgent.start')}</Button>
      {!prompt.trim() && <p className="text-2xs text-muted-foreground">{t('idsAgent.needsPrompt')}</p>}
    </>}
    {state.error && <Notice tone="error">{ROUTE_ERRORS.has(state.error)
      ? t(`idsAgent.error.${state.error as 'missing-model' | 'missing-key' | 'needs-key'}`)
      : t('idsAgent.error.other', { reason: state.error })}</Notice>}
    {state.phase === 'running' && <>
      <Progress />
      <Question />
      <Button size="sm" variant="outline" className="h-7" onClick={cancelIdsAgentRun}><Square className="h-3 w-3 mr-1" />{t('idsAgent.cancel')}</Button>
    </>}
    {state.phase === 'done' && run && <>
      <p className={stopped ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}>
        {stopped ? t('idsAgent.status.stopped', { reason: run.message ?? stopped }) : t('idsAgent.status.completed')}</p>
      <IdsAgentProposal proposal={run.proposal} selection={state.selection} onSelection={setIdsAgentSelection} />
      <IdsAgentPrivacy run={run} />
      {!draft && <Button size="sm" className="h-7" disabled={state.selection.size === 0} onClick={accept}>{t('idsAgent.accept')}</Button>}
      {acceptError && <Notice tone="error">{acceptError}</Notice>}
      {draft && draft.rejected.length > 0 && <Notice tone="warning">{t('idsAgent.rejected', { count: draft.rejected.length })}</Notice>}
      {draft && <IdsDraftChecks draft={draft.draft} />}
    </>}
    {state.phase !== 'running' && (state.phase === 'done' || state.error) && <Button size="sm" variant="ghost" className="h-7"
      onClick={() => { setDraft(null); resetIdsAgent(); }}><RotateCcw className="h-3 w-3 mr-1" />{t('idsAgent.again')}</Button>}
  </ReviewCard>;
}
