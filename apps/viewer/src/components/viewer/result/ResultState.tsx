/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why a result shows no rows (U02, #6925). Five different situations used to
 * look alike in several panels ("0 clashes" read as "your model is clean"
 * even when no rule applied to anything):
 *
 *   no-population  the check had nothing it applies to
 *   no-findings    it applied and found nothing
 *   failed         the run did not finish
 *   unsupported    this source or host cannot produce the result
 *   partial        some of the run produced nothing to show; the rest did not run
 *   filtered       findings exist but the current filters hide all of them
 *
 * Each kind has its own icon and default heading; the panel supplies the
 * explanation, which only it can word truthfully.
 */

import type { ComponentType, ReactNode } from 'react';
import { AlertTriangle, Ban, CheckCircle2, Filter, SearchX, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation, type TranslationKey } from '@/i18n';

export type ResultStateKind = 'no-population' | 'no-findings' | 'failed' | 'unsupported' | 'partial' | 'filtered';

const KIND: Record<ResultStateKind, { titleKey: TranslationKey; icon: ComponentType<{ className?: string }>; iconClass: string }> = {
  'no-population': { titleKey: 'resultState.noPopulation', icon: SearchX, iconClass: 'text-amber-500' },
  'no-findings': { titleKey: 'resultState.noFindings', icon: CheckCircle2, iconClass: 'text-muted-foreground' },
  failed: { titleKey: 'resultState.failed', icon: XCircle, iconClass: 'text-destructive' },
  unsupported: { titleKey: 'resultState.unsupported', icon: Ban, iconClass: 'text-muted-foreground' },
  partial: { titleKey: 'resultState.partial', icon: AlertTriangle, iconClass: 'text-amber-500' },
  filtered: { titleKey: 'resultState.filtered', icon: Filter, iconClass: 'text-muted-foreground' },
};

interface ResultStateProps {
  kind: ResultStateKind;
  /** Overrides the kind's default heading with the panel's own wording. */
  title?: string;
  /** One or more explanation lines, most important first. */
  details?: readonly (string | null | false | undefined)[];
  action?: ReactNode;
  className?: string;
}

export function ResultState({ kind, title, details = [], action, className }: ResultStateProps) {
  const { t } = useTranslation();
  const { titleKey, icon: Icon, iconClass } = KIND[kind];
  const lines = details.filter((line): line is string => typeof line === 'string' && line.length > 0);
  return (
    <div
      role={kind === 'failed' ? 'alert' : 'status'}
      data-result-state={kind}
      className={cn('flex flex-col items-center justify-center p-8 text-center', className)}
    >
      <Icon className={cn('h-6 w-6 mb-2', iconClass)} aria-hidden="true" />
      <p className="text-sm font-medium">{title ?? t(titleKey)}</p>
      {lines.map((line, index) => (
        <p key={index} className={cn('mt-1.5 max-w-xs text-muted-foreground', index === 0 ? 'text-xs' : 'text-2xs')}>{line}</p>
      ))}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
