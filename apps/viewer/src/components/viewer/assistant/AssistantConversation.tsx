/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { BarChart3, Bot, ClipboardCheck, Crosshair, Eye, FileText, Filter, GitBranch, Hammer, Layers, ListChecks, Palette, PencilLine, Table, Table2, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { AssistantMessage } from '@/lib/assistant/persistence';
import type { AssistantSource } from '@/lib/assistant/sources';
import { adapterFor } from '@/lib/assistant/adapters/registry';
import { parseClashGroupPatch } from '@/lib/assistant/clash-group-proposal';
import { parseFlowPatch } from '@/lib/assistant/flow-patch';
import { parseFlowCreate } from '@/lib/assistant/flow-create-envelope';
import { parseModelChangeBatch } from '@/lib/actions/model-change';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { parseSceneActions } from '@/lib/actions/scene-actions';
import { parseTableMapping } from '@/lib/actions/table-mapping';
import { checkProposalOf, type CheckDeclared } from '@/lib/check-authoring/proposal-summary';
import { artifactParts, declaredArtifactKind, parseArtifactProposal, type ArtifactKind } from '@/lib/assistant/artifacts/proposal-kinds';
import { markdownHtml } from '@/lib/assistant/markdown';
import { capturedEvidence, rowFields } from '@/lib/assistant/captured-rows';
import { ReceiptFooter } from './AssistantUsage';
import { useTransientSurface } from './useTransientSurface';

type Artifact = 'filter' | 'list' | 'lens' | 'chart';
type Declared = 'clash' | 'flow' | 'flowCreate' | 'changes' | 'authoring' | 'scene' | 'mapping' | CheckDeclared | Artifact;
type Proposal = { kind: 'clash'; groups: number; findings: number } | { kind: 'flow'; operations: number } | { kind: 'flowCreate'; nodes: number }
  | { kind: 'changes'; changes: number } | { kind: 'authoring'; operations: number } | { kind: 'scene'; actions: number }
  | { kind: 'mapping'; columns: number; key: string } | { kind: Artifact; parts: number } | { kind: 'invalid'; declared: Declared; reason: string }
  | { kind: 'checks'; declared: CheckDeclared; items: number; unsupported: number };
const DECLARED: Record<string, Declared> = { 'clash.groups': 'clash', 'flow.patch': 'flow', 'flow.create': 'flowCreate', 'model.changes': 'changes',
  'model.authoring': 'authoring', 'scene.actions': 'scene', 'table.mapping': 'mapping',
  'filter.proposal': 'filter', 'list.proposal': 'list', 'lens.proposal': 'lens', 'chart.proposal': 'chart' };
const PROPOSAL_TITLE = { clash: 'assistant.proposalClash', flow: 'assistant.proposalFlow', flowCreate: 'flowAssistant.proposalCreate', changes: 'assistant.proposalChanges',
  authoring: 'assistant.proposalAuthoring', scene: 'sceneActions.proposal', mapping: 'assistant.proposalMapping',
  ids: 'checkAuthoring.proposalIds', rules: 'checkAuthoring.proposalRules', document: 'checkAuthoring.proposalDocument',
  filter: 'assistantArtifacts.proposal.filter', list: 'assistantArtifacts.proposal.list',
  lens: 'assistantArtifacts.proposal.lens', chart: 'assistantArtifacts.proposal.chart' } as const;
const PROPOSAL_ICON = { clash: Layers, flow: GitBranch, flowCreate: GitBranch, changes: PencilLine, authoring: Hammer, scene: Eye, mapping: Table2,
  ids: ClipboardCheck, rules: ListChecks, document: FileText,
  filter: Filter, list: Table, lens: Palette, chart: BarChart3 } as const;
const CHECK_SUMMARY = { ids: 'checkAuthoring.proposalIdsSummary', rules: 'checkAuthoring.proposalRulesSummary',
  document: 'checkAuthoring.proposalDocumentSummary' } as const;
const ARTIFACT_OF: Record<ArtifactKind, Artifact> = { 'filter.proposal': 'filter', 'list.proposal': 'list', 'lens.proposal': 'lens', 'chart.proposal': 'chart' };
const ARTIFACT_SUMMARY = { filter: 'assistantArtifacts.summary.filter', list: 'assistantArtifacts.summary.list',
  lens: 'assistantArtifacts.summary.lens', chart: 'assistantArtifacts.summary.chart' } as const;

/** Typed proposals are reviewed natively below the conversation; raw JSON is secondary. */
export function proposalOf(content: string): Proposal | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
  const check = checkProposalOf(content);
  if (check) {
    try { return { kind: 'checks', ...check.summary() }; }
    catch (error) {
      console.warn('[Assistant] Check authoring proposal failed validation', error);
      return { kind: 'invalid', declared: check.declared, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  // Only a reply that declares a typed kind is parsed; prose never reaches the strict parsers.
  const artifact = declaredArtifactKind(content);
  const kind = /"kind"\s*:\s*"(clash\.groups|flow\.patch|flow\.create|model\.changes|model\.authoring|scene\.actions|table\.mapping)"/.exec(content)?.[1] ?? artifact;
  if (!kind) return null;
  try {
    if (artifact && kind === artifact) return { kind: ARTIFACT_OF[artifact], parts: artifactParts(parseArtifactProposal(content, artifact)) };
    if (kind === 'flow.patch') return { kind: 'flow', operations: parseFlowPatch(content).operations.length };
    if (kind === 'flow.create') return { kind: 'flowCreate', nodes: parseFlowCreate(content).nodes.length };
    if (kind === 'scene.actions') return { kind: 'scene', actions: parseSceneActions(content).actions.length };
    if (kind === 'model.changes') return { kind: 'changes', changes: parseModelChangeBatch(content).changes.length };
    if (kind === 'model.authoring') return { kind: 'authoring', operations: parseModelAuthoringBatch(content).operations.length };
    if (kind === 'table.mapping') {
      const mapping = parseTableMapping(content);
      return { kind: 'mapping', columns: mapping.columns.length, key: mapping.identity.key };
    }
    const patch = parseClashGroupPatch(content);
    return { kind: 'clash', groups: patch.groups.length, findings: patch.groups.reduce((sum, group) => sum + group.citations.length, 0) };
  } catch (error) {
    // Shown as a refused proposal card so the coordinator can ask again; never reviewable.
    console.warn('[Assistant] Typed proposal failed validation', error);
    return { kind: 'invalid', declared: DECLARED[kind], reason: error instanceof Error ? error.message : String(error) };
  }
}

function ProposalCard({ content, proposal, onRepair }: { content: string; proposal: Proposal; onRepair?: (prompt: string) => void }) {
  const { t } = useTranslation();
  const declared = proposal.kind === 'invalid' || proposal.kind === 'checks' ? proposal.declared : proposal.kind;
  const Icon = PROPOSAL_ICON[declared];
  const invalid = proposal.kind === 'invalid';
  return <div className={invalid ? 'rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1' : 'rounded border border-primary/30 bg-primary/5 p-2 space-y-1'}>
    <p className="flex items-center gap-1.5 font-semibold"><Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      {t(PROPOSAL_TITLE[declared])}</p>
    {proposal.kind === 'invalid' ? <>
      <p>{t('assistant.proposalInvalid')}</p>
      <p className="text-muted-foreground break-words">{proposal.reason}</p>
      {onRepair && <Button size="sm" variant="outline" className="h-7" onClick={() => onRepair(t('assistant.proposalRepairPrompt', { reason: proposal.reason }))}>
        {t('assistant.proposalRepair')}
      </Button>}
    </> : <>
      <p className="text-muted-foreground">{proposal.kind === 'checks'
        ? `${t(CHECK_SUMMARY[proposal.declared], { count: proposal.items })} · ${t('checkAuthoring.proposalUnsupported', { count: proposal.unsupported })}`
        : proposal.kind === 'clash'
        ? `${t('assistant.proposalGroups', { count: proposal.groups })} · ${t('assistant.proposalFindings', { count: proposal.findings })}`
        : proposal.kind === 'flow' ? t('assistant.proposalFlowSummary', { count: proposal.operations })
          : proposal.kind === 'flowCreate' ? t('flowAssistant.proposalCreateSummary', { count: proposal.nodes })
          : proposal.kind === 'authoring' ? t('assistant.proposalAuthoringSummary', { count: proposal.operations })
          : proposal.kind === 'scene' ? t('sceneActions.proposalSummary', { count: proposal.actions })
          : proposal.kind === 'mapping' ? t('assistant.proposalMappingSummary', { count: proposal.columns, key: proposal.key })
          : proposal.kind === 'changes' ? t('assistant.proposalChangesSummary', { count: proposal.changes })
            : t(ARTIFACT_SUMMARY[proposal.kind], { count: proposal.parts })}</p>
      <p>{t(proposal.kind === 'mapping' ? 'assistant.proposalMappingNext' : 'assistant.proposalNext')}</p>
    </>}
    <details><summary className="cursor-pointer py-1 text-muted-foreground hover:text-foreground">{t('assistant.proposalJson')}</summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{content}</pre>
    </details>
  </div>;
}

/** A captured row behind a citation; clash rows can be shown in the model. */
function CitationPeek({ citation, data, onFocus, onClose, restoreTo }: {
  citation: string; data: unknown; onFocus: (() => void) | null; onClose: () => void;
  /** Focus target after closing when the chip that opened the peek was replaced. */
  restoreTo: string;
}) {
  const { t } = useTranslation();
  const fields = useMemo(() => data === undefined ? [] : rowFields(data), [data]);
  const ref = useRef<HTMLElement>(null);
  useTransientSurface(ref, onClose, { fallback: restoreTo });
  return <section ref={ref} tabIndex={-1} className="ml-11 mr-3 mb-2 rounded border border-primary/30 bg-background p-2 text-xs space-y-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={t('assistant.citationPeek', { citation })}>
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
  return <p className="px-3 py-2 text-xs text-muted-foreground motion-safe:animate-pulse">{seconds >= 3 ? t('assistant.thinkingElapsed', { seconds }) : t('assistant.thinking')}</p>;
}

const Message = memo(function Message({ message: { role, content, model, receipt }, streaming, onCitation, onRepair, answerIndex }: {
  message: AssistantMessage; streaming?: boolean; onCitation?: (citation: string) => void; onRepair?: (prompt: string) => void;
  /** 1-based position of a completed answer; it can then receive focus when it arrives. */
  answerIndex?: number;
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
  const answer = !user && !streaming && answerIndex !== undefined;
  return <div className={cn('flex gap-2 px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring', user && 'bg-muted/30')}
    {...(answer ? { 'data-assistant-answer': '', role: 'article', tabIndex: -1, 'aria-label': t('assistantA11y.answer', { index: answerIndex }) } : {})}>
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
      {streaming && <span className="inline-block w-1.5 h-3.5 bg-blue-500 motion-safe:animate-pulse ml-0.5 align-text-bottom rounded-sm" aria-hidden="true" />}
      {receipt && !streaming && <ReceiptFooter receipt={receipt} />}
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
  // Deliberately not a live region: streamed tokens are not announced (AssistantAnnouncer reports completion).
  return <div className="py-1" aria-busy={streaming}>
    {empty && source && <div className="p-3 space-y-2 text-xs">
      <p className="font-semibold">{t('assistant.conversationTitle')}</p>
      <p className="text-muted-foreground">{t('assistant.conversationHint')}</p>
      {canAsk && <fieldset aria-label={t('assistant.suggestions')} className="flex flex-col items-start gap-1.5 pt-1">
        {adapterFor(source).suggestionKeys.map(key => <button key={key} type="button" onClick={() => onSuggest(t(key))}
          className="max-w-full rounded-full border border-border px-2.5 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t(key)}
        </button>)}
      </fieldset>}
    </div>}
    {messages.map((message, index) => <div key={index} data-message-index={index}>
      <Message message={message} onRepair={canAsk && index === messages.length - 1 ? onSuggest : undefined}
        answerIndex={message.role === 'assistant' ? Math.ceil((index + 1) / 2) : undefined}
        onCitation={citation => setPeek(current => current?.index === index && current.citation === citation ? null : { index, citation })} />
      {peek?.index === index && <CitationPeek citation={peek.citation} data={captured?.rows.get(peek.citation)}
        onFocus={focusCitation(peek.citation)} onClose={() => setPeek(null)}
        restoreTo={`[data-message-index="${index}"] [data-citation="${peek.citation}"]`} />}
    </div>)}
    {pendingPrompt && <Message message={{ role: 'user', content: pendingPrompt }} />}
    {streaming && (output
      ? <Message message={{ role: 'assistant', content: output }} streaming />
      : <Waiting />)}
    {error && <p role="alert" className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
