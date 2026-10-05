/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { mutationDenialKey, mutationPermission } from '@/store/mutation-permission';
import { useSemanticSession } from '@/lib/semantic/session';
import { applySemanticProjections, previewSemanticProjection, type SemanticProjectionProposal } from '@/lib/semantic/assist/projection-proposal';
import { ReviewFrame } from './SemanticReviewParts';

const show = (value: unknown) => value === undefined || value === null ? '—' : String(value);

/** Native projection previews per row: target, prior and new value, unit and conflict policy; applied only when approved. */
export function SemanticProjectionReview({ proposal }: { proposal: SemanticProjectionProposal }) {
  const { t } = useTranslation();
  const document = useSemanticSession(s => s.document);
  const profile = useSemanticSession(s => s.profile);
  const revisions = useSemanticSession(s => s.revisions);
  const retrievedAt = useSemanticSession(s => s.retrievedAt);
  const models = useViewerStore(s => s.models);
  const mutationVersion = useViewerStore(s => s.mutationVersion);
  const denial = useViewerStore(s => { const permission = mutationPermission(s); return permission.allowed ? null : permission.reason; });
  const rows = useMemo(() => previewSemanticProjection(proposal, { document, profile, revisions, retrievedAt }),
    // The native preview reads live model state; re-preview after edits, reloads and edit-mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [proposal, document, profile, revisions, retrievedAt, models, mutationVersion, denial]);
  const [approved, setApproved] = useState<ReadonlySet<number>>(new Set());
  const [outcome, setOutcome] = useState<{ applied: number; errors: string[] } | null>(null);
  const plans = [...approved].flatMap(index => { const row = rows[index]; return row?.status === 'ready' && !row.plan.skip ? [row.plan] : []; });
  const apply = () => {
    const results = applySemanticProjections(plans, revisions);
    setOutcome({ applied: results.filter(result => !result.error).length, errors: results.flatMap(result => result.error ? [result.error] : []) });
    setApproved(new Set());
  };
  return <ReviewFrame label={t('semanticAssist.projectionTitle')} title={proposal.title}>
    {proposal.rationale && <p className="text-muted-foreground break-words">{proposal.rationale}</p>}
    {denial && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t(mutationDenialKey(denial))}</p>}
    <ol className="space-y-2">{rows.map((row, index) => <li key={index} className="rounded border border-border p-1.5 space-y-1">
      <p className="break-all"><span className="font-mono text-2xs">{row.projection.field}</span> · {row.projection.resource}</p>
      {row.status === 'ready' ? <label className="flex items-start gap-2">
        <input type="checkbox" checked={approved.has(index)} disabled={row.plan.skip}
          onChange={event => setApproved(current => { const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />
        <span className="min-w-0">
          <span className="block font-mono text-2xs break-all">{row.plan.targetGlobalId} · {row.plan.mapping.pset}.{row.plan.mapping.property}</span>
          <span className="block">{t('semanticAssist.projectionValues', { previous: show(row.plan.previous), value: show(row.plan.value), unit: row.plan.mapping.unit ?? '' })}</span>
          <span className="block text-muted-foreground">{t('semanticAssist.projectionPolicy', { policy: row.plan.policy })}
            {row.plan.skip ? ` · ${t('semanticAssist.projectionSkipped')}` : ''}</span>
        </span>
      </label> : <p className="text-destructive break-words">{t('semanticAssist.projectionRefused', { reason: row.reason })}</p>}
    </li>)}</ol>
    <Button size="sm" className="h-7" disabled={!plans.length || !!denial} onClick={apply}>{t('semanticAssist.projectionApply', { count: plans.length })}</Button>
    {outcome && <div aria-live="polite" className="rounded border border-border p-2 space-y-1">
      <p>{t('semanticAssist.projectionApplied', { count: outcome.applied })}</p>
      {outcome.errors.map((reason, index) => <p key={index} role="alert" className="text-destructive break-words">{reason}</p>)}
    </div>}
  </ReviewFrame>;
}
