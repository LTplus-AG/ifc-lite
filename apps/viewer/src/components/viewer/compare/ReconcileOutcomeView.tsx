/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One reconciliation outcome (#6921): the refusal with every named
 * incompatibility, or the per-state counts, partial/excluded disclosures and
 * the bounded list of non-persisting findings (persisting ones are counted,
 * not listed, so the list leads with what moved).
 */

import { useEffect, useRef } from 'react';
import { useReconciliationFocus } from '@/lib/panels/evidence-focus';
import { useTranslation } from '@/i18n';
import type { Incompatibility, ReconcileOutcome, ReconcileState } from '@/lib/compare/run-reconcile-types';

const STATES: readonly ReconcileState[] = ['new', 'resolved', 'persisting', 'changed', 'notEvaluated'];
const LISTED_FINDINGS = 40;

export function ReconcileOutcomeView({ outcome }: { outcome: ReconcileOutcome }) {
  const { t } = useTranslation();
  const focus = useReconciliationFocus(s => s.record);
  const focused = outcome.ok && focus?.baseRunId === outcome.baseRunId && focus.headRunId === outcome.headRunId
    ? outcome.findings.find(row => row.identity === focus.identity) : undefined;
  const focusedRow = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focused) return;
    focusedRow.current?.focus(); focusedRow.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);
  // A run-level refusal names the picked run by its role, not by an internal id.
  const detail = (item: Incompatibility) => item.sides
    ? item.sides.map(side => t(side === 'base' ? 'compareAnalysis.reconcile.baseRun' : 'compareAnalysis.reconcile.headRun')).join(', ')
    : item.detail ?? '';
  if (!outcome.ok) {
    return (
      <div role="alert" className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 space-y-1">
        <p className="font-medium">{t('compareAnalysis.reconcile.refused')}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {outcome.incompatibilities.map(item => (
            <li key={item.code}>{t(`compareAnalysis.incompat.${item.code}`, { detail: detail(item) })}</li>
          ))}
        </ul>
      </div>
    );
  }
  const ordinary = outcome.findings.filter(f => f.state !== 'persisting');
  const listed = focused ? [focused, ...ordinary.filter(row => row !== focused)] : ordinary;
  const shown = listed.slice(0, LISTED_FINDINGS);
  return (
    <div className="space-y-1.5">
      {/* The announced summary: counts and the partial/excluded disclosures (phrasing content only). */}
      <output className="block space-y-1.5">
        <span className="grid grid-cols-5 gap-1 text-center">
          {STATES.map(state => (
            <span key={state} className="flex flex-col">
              <span className="text-sm font-semibold tabular-nums">{outcome.counts[state]}</span>
              <span className="text-2xs text-muted-foreground">{t(`compareAnalysis.state.${state}`)}</span>
            </span>
          ))}
        </span>
        {outcome.partial && <span className="block text-amber-700 dark:text-amber-400">{t('compareAnalysis.reconcile.partial')}</span>}
        {outcome.excluded > 0 && (
          <span className="block text-muted-foreground">{t('compareAnalysis.reconcile.excluded', { count: outcome.excluded })}</span>
        )}
      </output>
      {shown.length > 0 && (
        <ul className="space-y-0.5">
          {shown.map(finding => (
            <li key={`${finding.state}:${finding.identity}:${finding.baseOccurrence ?? finding.headOccurrence}`}
              ref={finding === focused ? focusedRow : undefined} tabIndex={finding === focused ? -1 : undefined}
              aria-current={finding === focused ? true : undefined}
              className="rounded border border-border/60 px-2 py-1">
              <span className="font-medium">{t(`compareAnalysis.state.${finding.state}`)}</span>
              <span className="break-words"> · {finding.label}</span>
              {finding.reason && <span className="text-muted-foreground"> · {t(`compareAnalysis.reason.${finding.reason}`)}</span>}
              {finding.changes && (
                <span className="text-muted-foreground"> · {t('compareAnalysis.reconcile.changes', { fields: finding.changes.join(', ') })}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {listed.length > shown.length && (
        <p className="text-2xs text-muted-foreground">{t('comparePanel.moreNotShown', { count: listed.length - shown.length })}</p>
      )}
    </div>
  );
}
