/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { AiClaimStatus } from '@/lib/document/ai-report-types';
import type { CheckedClaim } from '@/lib/assistant/report-claims';
import { formatFactValue } from '@/lib/assistant/report-facts';

const STATUS = {
  supported: ['aiReports.statusSupported', 'border-emerald-500/40 bg-emerald-500/10'],
  unverifiable: ['aiReports.statusUnverifiable', 'border-amber-500/40 bg-amber-500/10'],
  contradicted: ['aiReports.statusContradicted', 'border-destructive/40 bg-destructive/10 text-destructive'],
} as const satisfies Record<AiClaimStatus, readonly [string, string]>;

function Claim({ claim, disabled, onEdit, onRemove }: { claim: CheckedClaim; disabled: boolean; onEdit: (text: string) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [label, tone] = STATUS[claim.status];
  const inputId = `report-claim-${claim.id}`;
  return <li className="rounded border border-border p-1.5 space-y-1" data-claim={claim.id}>
    <p className="flex flex-wrap items-center gap-1">
      <span className="font-mono text-2xs text-muted-foreground">{claim.id}</span>
      <span className={cn('rounded border px-1 text-2xs font-medium', tone)}>{t(label)}</span>
      {claim.edited && <span className="text-2xs text-muted-foreground">{t('aiReports.claimEdited')}</span>}
    </p>
    {editing === null ? <p className="whitespace-pre-wrap break-words">{claim.text}</p> : <>
      <label className="sr-only" htmlFor={inputId}>{t('aiReports.claimText')}</label>
      <textarea id={inputId} rows={3} maxLength={1200} value={editing} onChange={event => setEditing(event.target.value)}
        className="w-full resize-y rounded border border-input bg-background p-1.5 text-xs" />
    </>}
    <ul className="space-y-0.5 text-2xs text-muted-foreground">
      {claim.results.map((result, index) => <li key={index} className="break-words">
        {t('aiReports.factLine', { citation: result.fact.citation, field: result.fact.field, claimed: formatFactValue(result.fact.value, result.fact.unit) })}
        {result.check.kind === 'match' ? ` · ${formatFactValue(result.check.captured, result.check.unit)}` : ` · ${result.check.reason}`}
      </li>)}
      {claim.unknownCitations.map(citation => <li key={citation}>{t('aiReports.unknownCitation', { citation })}</li>)}
    </ul>
    <div className="flex flex-wrap gap-1">
      {editing === null ? <>
        <Button variant="outline" size="sm" className="h-6" disabled={disabled} onClick={() => setEditing(claim.text)}>{t('aiReports.editClaim')}</Button>
        <Button variant="ghost" size="sm" className="h-6" disabled={disabled} onClick={onRemove}>{t('aiReports.removeClaim')}</Button>
      </> : <>
        <Button size="sm" className="h-6" disabled={disabled || !editing.trim()} onClick={() => { onEdit(editing); setEditing(null); }}>{t('aiReports.saveClaim')}</Button>
        <Button variant="ghost" size="sm" className="h-6" onClick={() => setEditing(null)}>{t('aiReports.cancelEdit')}</Button>
      </>}
    </div>
  </li>;
}

/** Per-claim check status with reviewer edit/remove. Contradicted claims block saving until changed. */
export function ReportClaimList({ claims, disabled, onEdit, onRemove }: {
  claims: CheckedClaim[]; disabled: boolean; onEdit: (id: string, text: string) => void; onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const contradicted = claims.filter(claim => claim.status === 'contradicted').length;
  return <section aria-label={t('aiReports.claims')} className="space-y-1">
    <p className="font-semibold">{t('aiReports.claims')}</p>
    {!claims.length && <p className="text-muted-foreground">{t('aiReports.noClaims')}</p>}
    {claims.length > 0 && <ol className="space-y-1">
      {claims.map(claim => <Claim key={claim.id} claim={claim} disabled={disabled}
        onEdit={text => onEdit(claim.id, text)} onRemove={() => onRemove(claim.id)} />)}
    </ol>}
    {contradicted > 0 && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
      {t('aiReports.contradictedBlocks', { count: contradicted })}</p>}
  </section>;
}
