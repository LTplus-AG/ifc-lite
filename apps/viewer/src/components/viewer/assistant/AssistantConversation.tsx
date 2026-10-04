/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Bot, Crosshair, GitBranch, Layers, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { AssistantMessage } from '@/lib/assistant/persistence';
import type { AssistantSource } from '@/lib/assistant/sources';
import { parseClashGroupPatch } from '@/lib/assistant/clash-group-proposal';
import { parseFlowPatch } from '@/lib/assistant/flow-patch';
import { markdownHtml } from '@/lib/assistant/markdown';
import { capturedEvidence, rowFields } from '@/lib/assistant/captured-rows';

const SUGGESTIONS: Record<AssistantSource, TranslationKey[]> = {
  clash: ['assistant.suggestClashSummary', 'assistant.suggestClashGroups'],
  validation: ['assistant.suggestValidationSummary', 'assistant.suggestValidationRequirements'],
  compare: ['assistant.suggestCompareSummary'],
  flow: ['assistant.suggestFlowExplain', 'assistant.suggestFlowPatch'],
  loadReport: ['assistant.suggestLoadReport'],
};

type Proposal = { kind: 'clash'; groups: number; findings: number } | { kind: 'flow'; operations: number }
  | { kind: 'invalid'; declared: 'clash' | 'flow'; reason: string };

/** Typed proposals are reviewed natively below the conversation; raw JSON is secondary. */
export function proposalOf(content: string): Proposal | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
  // Only a reply that declares a typed kind is parsed; prose never reaches the strict parsers.
  const kind = /"kind"\s*:\s*"(clash\.groups|flow\.patch)"/.exec(content)?.[1];
  if (!kind) return null;
  try {
    if (kind === 'flow.patch') return { kind: 'flow', operations: parseFlowPatch(content).operations.length };
    const patch = parseClashGroupPatch(content);
    return { kind: 'clash', groups: patch.groups.length, findings: patch.groups.reduce((sum, group) => sum + group.citations.length, 0) };
  } catch (error) {
    // Shown as a refused proposal card so the coordinator can ask again; never reviewable.
    console.warn('[Assistant] Typed proposal failed validation', error);
    return { kind: 'invalid', declared: kind === 'flow.patch' ? 'flow' : 'clash', reason: error instanceof Error ? error.message : String(error) };
  }
}

function ProposalCard({ content, proposal, onRepair }: { content: string; proposal: Proposal; onRepair?: (prompt: string) => void }) {
  const { t } = useTranslation();
  const declared = proposal.kind === 'invalid' ? proposal.declared : proposal.kind;
  const Icon = declared === 'clash' ? Layers : GitBranch;
  const invalid = proposal.kind === 'invalid';
  return <div className={invalid ? 'rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1' : 'rounded border border-primary/30 bg-primary/5 p-2 space-y-1'}>
    <p className="flex items-center gap-1.5 font-semibold"><Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      {t(declared === 'clash' ? 'assistant.proposalClash' : 'assistant.proposalFlow')}</p>
    {proposal.kind === 'invalid' ? <>
      <p>{t('assistant.proposalInvalid')}</p>
      <p className="text-muted-foreground break-words">{proposal.reason}</p>
      {onRepair && <Button size="sm" variant="outline" className="h-7" onClick={() => onRepair(t('assistant.proposalRepairPrompt', { reason: proposal.reason }))}>
        {t('assistant.proposalRepair')}
      </Button>}
    </> : <>
      <p className="text-muted-foreground">{proposal.kind === 'clash'
        ? `${t('assistant.proposalGroups', { count: proposal.groups })} · ${t('assistant.proposalFindings', { count: proposal.findings })}`
        : t('assistant.proposalFlowSummary', { count: proposal.operations })}</p>
      <p>{t('assistant.proposalNext')}</p>
    </>}
    <details><summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('assistant.proposalJson')}</summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{content}</pre>
    </details>
  </div>;
}

/** A captured row behind a citation; clash rows can be shown in the model. */
function CitationPeek({ citation, data, onFocus, onClose }: {
  citation: string; data: unknown; onFocus: (() => void) | null; onClose: () => void;
}) {
  const { t } = useTranslation();
  const fields = useMemo(() => data === undefined ? [] : rowFields(data), [data]);
  return <section className="ml-11 mr-3 mb-2 rounded border border-primary/30 bg-background p-2 text-xs space-y-1.5" aria-label={t('assistant.citationPeek', { citation })}>
    <div className="flex items-center gap-1">
      <span className="font-mono font-semibold text-primary">{citation}</span>
      <span className="text-muted-foreground">{t('assistant.citationCaptured')}</span>
      <IconButton label={t('assistant.citationClose')} className="ml-auto h-6 w-6" onClick={onClose}><X className="h-3.5 w-3.5" /></IconButton>
    </div>
    {data === undefined ? <p className="text-muted-foreground">{t('assistant.citationMissing')}</p>
      : <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 max-h-48 overflow-auto">
        {fields.map(([key, value]) => <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt><dd className="min-w-0 break-words font-mono text-2xs">{value}</dd>
        </div>)}
      </dl>}
    {onFocus && <Button size="sm" variant="outline" className="h-7" onClick={onFocus}><Crosshair className="h-3 w-3 mr-1" />{t('assistant.clashFindingFocus')}</Button>}
  </section>;
}

/** Free models can think for 10-30 s before the first token; show that time is passing. */
function Waiting() {
  const { t } = useTranslation();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return <p className="px-3 py-2 text-xs text-muted-foreground animate-pulse">{seconds >= 3 ? t('assistant.thinkingElapsed', { seconds }) : t('assistant.thinking')}</p>;
}

const Message = memo(function Message({ message: { role, content, model }, streaming, onCitation, onRepair }: {
  message: AssistantMessage; streaming?: boolean; onCitation?: (citation: string) => void; onRepair?: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const user = role === 'user';
  const proposal = useMemo(() => user || streaming ? null : proposalOf(content), [content, user, streaming]);
  const html = useMemo(() => user || proposal ? '' : markdownHtml(content), [content, user, proposal]);
  // Citation chips are escaped markup buttons; one delegated handler keeps model text inert.
  const citationClick = (event: MouseEvent<HTMLDivElement>) => {
    const chip = (event.target as Element).closest?.('[data-citation]');
    const citation = chip?.getAttribute('data-citation');
    if (citation && onCitation) onCitation(citation);
  };
  return <div className={cn('flex gap-2 px-3 py-2', user && 'bg-muted/30')}>
    <div aria-hidden="true" className={cn('shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5',
      user ? 'bg-primary/10 text-primary' : 'bg-blue-500/10 text-blue-500')}>
      {user ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
    </div>
    <div className="flex-1 min-w-0 text-xs">
      <p className="mb-0.5 text-2xs font-medium text-muted-foreground">{user ? t('assistant.you') : [t('assistant.title'), model].filter(Boolean).join(' · ')}</p>
      {user ? <p className="whitespace-pre-wrap break-words">{content}</p>
        : proposal ? <ProposalCard content={content} proposal={proposal} onRepair={onRepair} />
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegates to the native citation <button>s inside
          : <div className="break-words leading-relaxed" onClick={citationClick} dangerouslySetInnerHTML={{ __html: html }} />}
      {streaming && <span className="inline-block w-1.5 h-3.5 bg-blue-500 animate-pulse ml-0.5 align-text-bottom rounded-sm" aria-hidden="true" />}
    </div>
  </div>;
});

export function AssistantConversation({ source, messages, pendingPrompt, output, streaming, error, canAsk, onSuggest, evidencePayload, focusCitation }: {
  source: AssistantSource | null;
  /** Captured payload the citations refer to; null when nothing is attached. */
  evidencePayload: string | null;
  /** A native focus action for a cited row, when the row still resolves live. */
  focusCitation: (citation: string) => (() => void) | null;
  messages: AssistantMessage[];
  pendingPrompt: string | null;
  output: string;
  streaming: boolean;
  error: string | null;
  canAsk: boolean;
  onSuggest: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const empty = !messages.length && !pendingPrompt;
  const [peek, setPeek] = useState<{ index: number; citation: string } | null>(null);
  const captured = useMemo(() => evidencePayload ? capturedEvidence(evidencePayload) : null, [evidencePayload]);
  return <div className="py-1" aria-live="polite">
    {empty && source && <div className="p-3 space-y-2 text-xs">
      <p className="font-semibold">{t('assistant.conversationTitle')}</p>
      <p className="text-muted-foreground">{t('assistant.conversationHint')}</p>
      {canAsk && <fieldset aria-label={t('assistant.suggestions')} className="flex flex-col items-start gap-1.5 pt-1">
        {SUGGESTIONS[source].map(key => <button key={key} type="button" onClick={() => onSuggest(t(key))}
          className="max-w-full rounded-full border border-border px-2.5 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t(key)}
        </button>)}
      </fieldset>}
    </div>}
    {messages.map((message, index) => <div key={index}>
      <Message message={message} onRepair={canAsk && index === messages.length - 1 ? onSuggest : undefined}
        onCitation={citation => setPeek(current => current?.index === index && current.citation === citation ? null : { index, citation })} />
      {peek?.index === index && <CitationPeek citation={peek.citation} data={captured?.rows.get(peek.citation)}
        onFocus={focusCitation(peek.citation)} onClose={() => setPeek(null)} />}
    </div>)}
    {pendingPrompt && <Message message={{ role: 'user', content: pendingPrompt }} />}
    {streaming && (output
      ? <Message message={{ role: 'assistant', content: output }} streaming />
      : <Waiting />)}
    {error && <p role="alert" className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
