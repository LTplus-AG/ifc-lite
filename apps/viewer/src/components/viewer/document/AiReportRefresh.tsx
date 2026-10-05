/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { aiBlockOrigin, type AiClaimStatus } from '@/lib/document/ai-report-types';
import type { DocumentSpec } from '@/lib/document/types';
import { captureEvidence } from '@/lib/assistant/evidence';
import { isAssistantSource } from '@/lib/assistant/sources';
import { applyReportRefresh, planReportRefresh, type ReportRefreshPlan } from '@/lib/assistant/report-refresh';
import { reportLanguageName } from '@/lib/assistant/report-language';

const STATUS: Record<AiClaimStatus, TranslationKey> = {
  supported: 'aiReports.statusSupported', unverifiable: 'aiReports.statusUnverifiable', contradicted: 'aiReports.statusContradicted',
};

/** Saved AI report: provenance, claim status and evidence refresh that keeps human edits by default. */
export function AiReportRefresh({ document, onChange }: { document: DocumentSpec; onChange: (next: DocumentSpec) => void }) {
  const { t, locale } = useTranslation();
  const [plan, setPlan] = useState<ReportRefreshPlan | null>(null);
  const [replace, setReplace] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const record = document.aiReport;
  if (!record) return null;
  const texts = document.blocks.flatMap(block => block.kind === 'text' ? [aiBlockOrigin(block)] : []);
  const refresh = () => {
    setMessage(null);
    try {
      if (!isAssistantSource(record.evidence.source)) throw new Error(t('aiReports.sourceUnsupported'));
      setPlan(planReportRefresh(document, captureEvidence(record.evidence.source)));
      setReplace(new Set());
    } catch (error) { setMessage({ error: true, text: error instanceof Error ? error.message : String(error) }); }
  };
  const apply = () => {
    if (!plan) return;
    try {
      onChange(applyReportRefresh(document, plan, replace));
      setPlan(null);
      setMessage({ error: false, text: t('aiReports.refreshApplied') });
    } catch (error) { setMessage({ error: true, text: error instanceof Error ? error.message : String(error) }); }
  };
  const toggle = (id: string, on: boolean) => setReplace(previous => {
    const next = new Set(previous);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  return <section aria-label={t('aiReports.refreshEvidence')} className="rounded-md border border-border p-2 space-y-2">
    <p className="flex items-center gap-1 font-semibold"><Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      {t('aiReports.reportRecord', { language: reportLanguageName(record.language, locale), revision: record.revision, capturedAt: record.evidence.capturedAt })}</p>
    <p className="text-muted-foreground">{t('aiReports.blockOrigins', { generated: texts.filter(origin => origin === 'ai-generated').length,
      edited: texts.filter(origin => origin === 'human-edited').length })}</p>
    {record.claims.length > 0 && <ul className="space-y-0.5">
      {record.claims.map(claim => <li key={claim.id} className="break-words"><span className="font-mono text-2xs">{claim.id}</span> {t(STATUS[claim.status])}</li>)}
    </ul>}
    <p className="text-muted-foreground">{t('aiReports.refreshHint')}</p>
    {!plan && <Button variant="outline" size="sm" className="h-7" onClick={refresh}><RefreshCw className="h-3 w-3 mr-1" aria-hidden="true" />{t('aiReports.refreshEvidence')}</Button>}
    {plan && <div className="space-y-2">
      <ul className="space-y-0.5">{plan.claims.map(claim => <li key={claim.id}>{t('aiReports.refreshClaim', { id: claim.id,
        before: t(STATUS[claim.before]), after: t(STATUS[claim.after]),
        changed: claim.changes.filter(change => change.kind === 'changed').length, missing: claim.changes.filter(change => change.kind === 'missing').length })}</li>)}</ul>
      <p className="font-semibold">{t('aiReports.conflicts')}</p>
      {!plan.conflicts.length && <p className="text-muted-foreground">{t('aiReports.noConflicts')}</p>}
      {plan.conflicts.map(conflict => <div key={conflict.blockId} className="rounded border border-amber-500/40 bg-amber-500/10 p-1.5 space-y-1" data-conflict={conflict.slot}>
        <p className="text-2xs text-muted-foreground">{t('aiReports.yourText')}</p>
        <p className="whitespace-pre-wrap break-words">{conflict.current}</p>
        {conflict.regenerated !== null && <>
          <p className="text-2xs text-muted-foreground">{t('aiReports.regeneratedText')}</p>
          <p className="whitespace-pre-wrap break-words">{conflict.regenerated}</p>
        </>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={replace.has(conflict.blockId)}
          onChange={event => toggle(conflict.blockId, event.target.checked)} />
          {t(conflict.regenerated === null ? 'aiReports.removeEdit' : 'aiReports.replaceEdit')}</label>
      </div>)}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" className="h-7" onClick={apply}>{t('aiReports.applyRefresh')}</Button>
        <Button variant="ghost" size="sm" className="h-7" onClick={() => setPlan(null)}>{t('aiReports.cancelRefresh')}</Button>
      </div>
    </div>}
    {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-destructive' : 'text-muted-foreground'}>{message.text}</p>}
  </section>;
}
