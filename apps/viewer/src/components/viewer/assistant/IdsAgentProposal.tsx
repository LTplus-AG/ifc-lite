/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review of an IDS-agent proposal (IDS-082): changes grouped by
 * specification, each with its rationale, sources and live count; the user
 * keeps or drops each batch (or a whole specification). Rows come from the
 * framework-free `proposalView` of `@ifc-lite/ids-agent`, so this component
 * only renders and forwards the selection.
 */

import { proposalView, setSpecSelected, toggleBatch, type Proposal, type SpecRow } from '@ifc-lite/ids-agent';
import { useTranslation } from '@/i18n';

function SpecChanges({ spec, onSpec, onBatch }: { spec: SpecRow; onSpec: (on: boolean) => void; onBatch: (id: string) => void }) {
  const { t } = useTranslation();
  const id = `ids-agent-spec-${spec.specId}`;
  return <li className="rounded border border-border/70 p-1.5 space-y-1">
    <div className="flex items-start gap-1.5">
      <input id={id} type="checkbox" className="mt-0.5" checked={spec.selected === 'all'} ref={el => { if (el) el.indeterminate = spec.selected === 'some'; }}
        aria-label={t('idsAgent.keepSpec', { name: spec.name })} onChange={event => onSpec(event.target.checked)} />
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="font-medium break-words">{spec.name}</span>{' '}
        <span className="text-2xs text-muted-foreground">{t(`idsAgent.change.${spec.change}`)}</span>
        {spec.preview && <span className="block text-muted-foreground">{t('idsAgent.preview', { applicable: spec.preview.applicable })}</span>}
        {spec.diagnostics.length > 0 && <span className="block text-amber-700 dark:text-amber-400">{t('idsAgent.diagnostics', { count: spec.diagnostics.length })}</span>}
      </label>
    </div>
    <ul className="pl-5 space-y-1">
      {spec.batches.map(batch => <li key={batch.id} className="flex items-start gap-1.5">
        <input type="checkbox" className="mt-0.5" checked={batch.selected} aria-label={t('idsAgent.keepBatch', { label: batch.label })}
          onChange={() => onBatch(batch.id)} />
        <div className="min-w-0 flex-1">
          <p className="break-words">{batch.label} <span className="text-2xs text-muted-foreground">{t('idsAgent.ops', { count: batch.opCount })}</span></p>
          {batch.sources.map((source, index) => <p key={index} className="text-muted-foreground italic break-words">{t('idsAgent.source', { quote: source.quote })}</p>)}
        </div>
      </li>)}
    </ul>
  </li>;
}

export function IdsAgentProposal({ proposal, selection, onSelection }: {
  proposal: Proposal; selection: ReadonlySet<string>; onSelection: (selection: ReadonlySet<string>) => void;
}) {
  const { t } = useTranslation();
  const view = proposalView(proposal, selection);
  return <div className="space-y-2">
    {view.summary && <section aria-label={t('idsAgent.summary')}><p className="whitespace-pre-wrap break-words">{view.summary}</p></section>}
    <section aria-label={t('idsAgent.changes')} className="space-y-1">
      <p className="font-medium">{t('idsAgent.changes')}</p>
      {view.specs.length === 0 && view.documentBatches.length === 0 && <p className="text-muted-foreground">{t('idsAgent.noChanges')}</p>}
      <ul className="space-y-1">
        {view.specs.map(spec => <SpecChanges key={spec.specId} spec={spec}
          onSpec={on => onSelection(setSpecSelected(proposal, selection, spec.specId, on))}
          onBatch={id => onSelection(toggleBatch(selection, id))} />)}
        {view.documentBatches.map(batch => <li key={batch.id} className="flex items-start gap-1.5">
          <input type="checkbox" className="mt-0.5" checked={batch.selected} aria-label={t('idsAgent.keepBatch', { label: batch.label })}
            onChange={() => onSelection(toggleBatch(selection, batch.id))} />
          <span className="break-words">{batch.label}</span>
        </li>)}
      </ul>
      <p className="text-muted-foreground">{t('idsAgent.selected', { selected: view.counts.selected, total: view.counts.batches })}</p>
    </section>
    {view.unresolved.length > 0 && <section aria-label={t('idsAgent.unresolved')} className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-0.5">
      <p className="font-medium">{t('idsAgent.unresolved')}</p>
      <ol className="list-decimal pl-4">{view.unresolved.map(item => <li key={item.id} className="break-words">
        {t('idsAgent.unresolvedItem', { statement: item.statement, category: item.category, reason: item.reason })}</li>)}</ol>
    </section>}
    {view.questions.length > 0 && <section aria-label={t('idsAgent.questions')} className="space-y-0.5">
      <p className="font-medium">{t('idsAgent.questions')}</p>
      <ul className="pl-2">{view.questions.map(q => <li key={q.id} className="break-words">
        {q.picked === null ? t('idsAgent.answerDismissed', { question: q.question }) : t('idsAgent.answer', { question: q.question, answer: q.choices[q.picked] ?? '' })}
      </li>)}</ul>
    </section>}
    <p className="text-2xs text-muted-foreground">{t(view.tokens.complete ? 'idsAgent.receipt' : 'idsAgent.receiptIncomplete', {
      model: view.model, requests: proposal.receipt.totals.requests, input: view.tokens.input, output: view.tokens.output })}</p>
  </div>;
}
