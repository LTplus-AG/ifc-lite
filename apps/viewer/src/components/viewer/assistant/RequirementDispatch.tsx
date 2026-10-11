/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native targets of reviewed source requirements (#7375). Shows each
 * requirement's explicit target, lets the reviewer exclude any, and on
 * request prepares the P07 drafts, which are then audited, dry-run, saved and
 * handed to their native editors by the unchanged P07 review cards. Nothing
 * is dispatched automatically.
 */

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { SemanticRequirementProposal } from '@/lib/semantic/assist/requirement-proposal';
import type { RequirementReview } from '@/lib/semantic/assist/requirement-review';
import { prepareNativeDrafts, qualifyRequirements, type NativeDrafts } from '@/lib/semantic/assist/requirement-dispatch';
import type { ClassifiedRequirement, UnresolvedReason } from '@/lib/semantic/assist/requirement-targets';
import { useSemanticSourceTexts } from '@/lib/semantic/assist/source-texts';
import type { Passage } from '@/lib/semantic/assist/spans';
import { IdsDraftReview } from '../check-authoring/IdsDraftReview';
import { RulesDraftReview } from '../check-authoring/RulesDraftReview';
import { DocumentOutlineReview } from '../check-authoring/DocumentOutlineReview';

const UNRESOLVED: Record<Exclude<UnresolvedReason, 'native'>, TranslationKey> = {
  span: 'semanticAssist.unresolvedSpan', 'source-missing': 'semanticAssist.unresolvedSourceMissing',
  'source-changed': 'semanticAssist.unresolvedSourceChanged', property: 'semanticAssist.unresolvedProperty',
  operator: 'semanticAssist.unresolvedOperator', value: 'semanticAssist.unresolvedValue', unit: 'semanticAssist.unresolvedUnit',
};
const TARGET: Record<'ids' | 'geometry' | 'manual', TranslationKey> = {
  ids: 'semanticAssist.targetIds', geometry: 'semanticAssist.targetGeometry', manual: 'semanticAssist.targetManual',
};
const REFUSED: Record<NativeDrafts['refused'][number]['target'], TranslationKey> = {
  ids: 'semanticAssist.refusedIds', geometry: 'semanticAssist.refusedGeometry', manual: 'semanticAssist.refusedManual',
};

function TargetLabel({ row }: { row: ClassifiedRequirement }) {
  const { t } = useTranslation();
  if (row.target !== 'unresolved') return <span className="rounded bg-primary/10 px-1 py-0.5 font-medium">{t(TARGET[row.target])}</span>;
  return <span className="text-amber-700 dark:text-amber-400">
    {row.reason === 'native' ? t('semanticAssist.unresolvedNative', { detail: row.detail ?? '' }) : t(UNRESOLVED[row.reason ?? 'span'])}
    {' '}{t('semanticAssist.unresolvedListed')}</span>;
}

/** The revision each dispatched requirement was prepared from; a draft is withdrawn once any of them no longer holds. */
const revisions = (rows: readonly ClassifiedRequirement[]) =>
  new Map(rows.map(row => [row.requirement.id, row.source ? `${row.source.source}:${row.source.revision}` : null]));

export function RequirementDispatch({ proposal, review, passages }: { proposal: SemanticRequirementProposal; review: RequirementReview; passages: readonly Passage[] }) {
  const { t } = useTranslation();
  const sources = useSemanticSourceTexts(s => s.sources);
  const classified = useMemo(() => qualifyRequirements(review, passages, sources), [review, passages, sources]);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [prepared, setPrepared] = useState<{ drafts: NativeDrafts; from: Map<string, string | null>; included: string[] } | null>(null);
  // Re-checked on every render: a source changed or detached after preparing withdraws the unsaved drafts.
  const now = revisions(classified);
  const stale = prepared !== null && prepared.included.some(id => prepared.from.get(id) !== now.get(id));
  const prepare = () => {
    const drafts = prepareNativeDrafts(proposal, classified, excluded);
    setPrepared({ drafts, from: revisions(classified), included: classified.map(row => row.requirement.id).filter(id => !excluded.has(id)) });
  };
  const included = classified.length - excluded.size;
  return <section aria-label={t('semanticAssist.dispatchTitle')} className="space-y-1.5 rounded border border-border p-1.5">
    <p className="font-medium">{t('semanticAssist.dispatchTitle')}</p>
    <p className="text-muted-foreground">{t('semanticAssist.dispatchHint')}</p>
    <ul className="space-y-1">{classified.map(row => {
      const id = row.requirement.id;
      return <li key={id} className="flex items-start gap-1.5">
        <input type="checkbox" id={`dispatch-${id}`} className="mt-0.5" checked={!excluded.has(id)} disabled={prepared !== null}
          aria-label={t('semanticAssist.include', { id })}
          onChange={event => setExcluded(previous => {
            const next = new Set(previous);
            if (event.target.checked) next.delete(id); else next.add(id);
            return next;
          })} />
        <label htmlFor={`dispatch-${id}`} className="break-words"><span className="font-mono font-semibold">{id}</span> <TargetLabel row={row} /></label>
      </li>;
    })}</ul>
    {!prepared && <Button size="sm" variant="outline" className="h-7" disabled={!passages.length || (included === 0 && !proposal.unsupported.length)}
      onClick={prepare}>{t('semanticAssist.prepareDrafts')}</Button>}
    {prepared && stale && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('semanticAssist.draftsWithdrawn')}</p>}
    {prepared && !stale && <>
      <p aria-live="polite" className="text-muted-foreground">{t('semanticAssist.draftsPrepared')}</p>
      {prepared.drafts.refused.map(({ target, detail }) => <p key={target} role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive break-words">
        {t(REFUSED[target], { detail })}</p>)}
      {prepared.drafts.ids && <IdsDraftReview initial={prepared.drafts.ids} />}
      {prepared.drafts.rules && <RulesDraftReview initial={prepared.drafts.rules} />}
      {/* No validation report backs these drafts: the outline holds only text and not-checked items. */}
      {prepared.drafts.document && <DocumentOutlineReview initial={prepared.drafts.document} evidence={null} />}
    </>}
  </section>;
}
