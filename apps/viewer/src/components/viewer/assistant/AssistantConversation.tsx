/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo, useMemo } from 'react';
import { Bot, GitBranch, Layers, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { AssistantMessage } from '@/lib/assistant/persistence';
import type { AssistantSource } from '@/lib/assistant/sources';
import { parseClashGroupPatch } from '@/lib/assistant/clash-group-proposal';
import { parseFlowPatch } from '@/lib/assistant/flow-patch';
import { renderTextContent } from '../chat/renderTextContent';

const SUGGESTIONS: Record<AssistantSource, TranslationKey[]> = {
  clash: ['assistant.suggestClashSummary', 'assistant.suggestClashGroups'],
  validation: ['assistant.suggestValidationSummary', 'assistant.suggestValidationRequirements'],
  compare: ['assistant.suggestCompareSummary'],
  flow: ['assistant.suggestFlowExplain', 'assistant.suggestFlowPatch'],
  loadReport: ['assistant.suggestLoadReport'],
};

type Proposal = { kind: 'clash'; groups: number; findings: number } | { kind: 'flow'; operations: number };

/** Typed proposals are reviewed natively below the conversation; raw JSON is secondary. */
export function proposalOf(content: string): Proposal | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
  try {
    const patch = parseClashGroupPatch(content);
    return { kind: 'clash', groups: patch.groups.length, findings: patch.groups.reduce((sum, group) => sum + group.citations.length, 0) };
  } catch { /* not a clash proposal */ }
  try { return { kind: 'flow', operations: parseFlowPatch(content).operations.length }; }
  catch { return null; }
}

function ProposalCard({ content, proposal }: { content: string; proposal: Proposal }) {
  const { t } = useTranslation();
  const Icon = proposal.kind === 'clash' ? Layers : GitBranch;
  return <div className="rounded border border-primary/30 bg-primary/5 p-2 space-y-1">
    <p className="flex items-center gap-1.5 font-semibold"><Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      {t(proposal.kind === 'clash' ? 'assistant.proposalClash' : 'assistant.proposalFlow')}</p>
    <p className="text-muted-foreground">{proposal.kind === 'clash'
      ? `${t('assistant.proposalGroups', { count: proposal.groups })} · ${t('assistant.proposalFindings', { count: proposal.findings })}`
      : t('assistant.proposalFlowSummary', { count: proposal.operations })}</p>
    <p>{t('assistant.proposalNext')}</p>
    <details><summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('assistant.proposalJson')}</summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{content}</pre>
    </details>
  </div>;
}

const Message = memo(function Message({ message: { role, content, model }, streaming }: { message: AssistantMessage; streaming?: boolean }) {
  const { t } = useTranslation();
  const user = role === 'user';
  const proposal = useMemo(() => user || streaming ? null : proposalOf(content), [content, user, streaming]);
  const html = useMemo(() => user || proposal ? '' : renderTextContent(content), [content, user, proposal]);
  return <div className={cn('flex gap-2 px-3 py-2', user && 'bg-muted/30')}>
    <div aria-hidden="true" className={cn('shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5',
      user ? 'bg-primary/10 text-primary' : 'bg-blue-500/10 text-blue-500')}>
      {user ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
    </div>
    <div className="flex-1 min-w-0 text-xs">
      <p className="mb-0.5 text-2xs font-medium text-muted-foreground">{user ? t('assistant.you') : [t('assistant.title'), model].filter(Boolean).join(' · ')}</p>
      {user ? <p className="whitespace-pre-wrap break-words">{content}</p>
        : proposal ? <ProposalCard content={content} proposal={proposal} />
          : <div className="break-words leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />}
      {streaming && <span className="inline-block w-1.5 h-3.5 bg-blue-500 animate-pulse ml-0.5 align-text-bottom rounded-sm" aria-hidden="true" />}
    </div>
  </div>;
});

export function AssistantConversation({ source, messages, pendingPrompt, output, streaming, error, canAsk, onSuggest }: {
  source: AssistantSource | null;
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
    {messages.map((message, index) => <Message key={index} message={message} />)}
    {pendingPrompt && <Message message={{ role: 'user', content: pendingPrompt }} />}
    {streaming && (output
      ? <Message message={{ role: 'assistant', content: output }} streaming />
      : <p className="px-3 py-2 text-xs text-muted-foreground animate-pulse">{t('assistant.thinking')}</p>)}
    {error && <p role="alert" className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
