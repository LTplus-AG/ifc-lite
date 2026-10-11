/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the grounding gate refused, as data: code, message and its ranked
 * candidates. Picking a candidate resubmits the batch with it (through the
 * gate again); an undeclared custom set can be declared deliberately.
 */

import { ShieldAlert, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { withCandidate, withCustomDeclaration } from '@/lib/ids-studio/rejection';

export function RejectionBanner() {
  const { t } = useTranslation();
  const rejection = useViewerStore((s) => s.idsStudioRejection);
  const dispatch = useViewerStore((s) => s.idsStudioDispatch);
  const dismiss = useViewerStore((s) => s.idsStudioDismissRejection);
  if (!rejection) return null;
  const info = rejection.label ? { label: rejection.label } : undefined;
  return <div role="alert" className="space-y-1 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs">
    <div className="flex items-center gap-1.5">
      <ShieldAlert className="h-3.5 w-3.5 text-destructive" aria-hidden />
      <p className="flex-1 font-medium">{t('idsStudio.gate.refused')}</p>
      <button type="button" aria-label={t('idsStudio.gate.dismiss')} className="rounded p-0.5 hover:bg-muted" onClick={dismiss}><X className="h-3 w-3" aria-hidden /></button>
    </div>
    <ul className="space-y-1">
      {rejection.issues.map((issue, index) => {
        const declare = withCustomDeclaration(rejection.ops, issue);
        return <li key={index} className="space-y-0.5">
          <p className="break-words"><span className="font-mono text-2xs text-muted-foreground">{issue.code}</span> {issue.message}</p>
          {(issue.candidates.length > 0 || declare) && <div className="flex flex-wrap items-center gap-1">
            {issue.candidates.length > 0 && <span className="text-2xs text-muted-foreground">{t('idsStudio.gate.didYouMean')}</span>}
            {issue.candidates.map((candidate) => {
              const ops = withCandidate(rejection.ops, issue, candidate.value);
              return <button key={candidate.value} type="button" disabled={!ops} title={candidate.reason}
                className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-2xs hover:bg-muted disabled:opacity-60"
                onClick={() => { if (ops) dispatch(ops, info); }}>{candidate.value}</button>;
            })}
            {declare && <button type="button" className="rounded border border-border bg-background px-1.5 py-0.5 text-2xs hover:bg-muted"
              onClick={() => dispatch(declare, info)}>{t('idsStudio.gate.declareCustom', { name: issue.value ?? '' })}</button>}
          </div>}
        </li>;
      })}
    </ul>
  </div>;
}
