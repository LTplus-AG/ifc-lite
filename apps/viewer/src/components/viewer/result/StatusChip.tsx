/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One status vocabulary for results, artifacts and jobs (U02, #6925).
 *
 * Proposal/artifact states (Draft, Ready to review, Applying, Applied,
 * Partial, Stale, Failed) and run outcomes (Complete, Running, Cancelled,
 * Interrupted, ...) share one chip so the same word always looks the same.
 * Every chip carries an icon AND its label; colour is never the only signal.
 * There is deliberately no score: a chip states an outcome, not a grade.
 */

import type { ComponentType } from 'react';
import {
  AlertTriangle, Ban, CheckCircle2, CircleDashed, CircleMinus, Clock, FilePen, HelpCircle, PauseCircle,
  ShieldAlert, Sparkles, XCircle,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { statusLabelKey, type ResultStatus } from './status-labels';

export { statusLabelKey, type ResultStatus };

type Tone = 'neutral' | 'progress' | 'good' | 'warn' | 'bad';

/** `null`: the shared spinner (running work). */
const STATUS: Record<ResultStatus, { icon: ComponentType<{ className?: string }> | null; tone: Tone }> = {
  complete: { icon: CheckCircle2, tone: 'good' },
  partial: { icon: AlertTriangle, tone: 'warn' },
  failed: { icon: XCircle, tone: 'bad' },
  running: { icon: null, tone: 'progress' },
  stale: { icon: Clock, tone: 'warn' },
  cancelled: { icon: CircleMinus, tone: 'neutral' },
  interrupted: { icon: PauseCircle, tone: 'warn' },
  queued: { icon: CircleDashed, tone: 'neutral' },
  uncertain: { icon: HelpCircle, tone: 'warn' },
  blocked: { icon: ShieldAlert, tone: 'bad' },
  unsupported: { icon: Ban, tone: 'neutral' },
  draft: { icon: FilePen, tone: 'neutral' },
  ready: { icon: Sparkles, tone: 'progress' },
  applying: { icon: null, tone: 'progress' },
  applied: { icon: CheckCircle2, tone: 'good' },
};

const TONE: Record<Tone, string> = {
  neutral: 'border-border text-muted-foreground',
  progress: 'border-primary/40 text-primary',
  good: 'border-green-600/40 text-green-700 dark:text-green-400',
  warn: 'border-amber-500/50 text-amber-700 dark:text-amber-400',
  bad: 'border-destructive/50 text-destructive',
};

export function StatusChip({ status, className }: { status: ResultStatus; className?: string }) {
  const { t } = useTranslation();
  const { icon: Icon, tone } = STATUS[status];
  return (
    <span
      data-status={status}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-2xs font-medium', TONE[tone], className)}
    >
      {Icon ? <Icon className="h-3 w-3" aria-hidden="true" /> : <Spinner size="xs" />}
      {t(statusLabelKey(status))}
    </span>
  );
}
