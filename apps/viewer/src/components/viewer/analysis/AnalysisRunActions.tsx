/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run, Re-run and Cancel (#5834). One control that turns into Cancel while its
 * run is in flight, in two sizes:
 *
 * - `AnalysisRerunAction`, the header run slot once a result exists. Re-run
 *   repeats the run that produced the result on screen (#5816's report model,
 *   #5818's last run kind); the panel supplies that closure and a label
 *   naming it ("Re-run the duplicate scan").
 * - `AnalysisRunButton`, a panel's first-run control in its body ("Run
 *   Validation", "Detect all clashes", "Run comparison").
 *
 * `busy` is work in flight that cannot be cancelled (IDS parsing its document
 * before the worker reports progress): the control spins and is disabled
 * rather than offering a Cancel that would do nothing.
 */

import type { HTMLAttributes, ReactNode } from 'react';
import { Play, RotateCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

export interface AnalysisRunSlot {
  /** A result is on screen, so there is something to re-run. */
  hasResult: boolean;
  /** A cancellable run is in flight. */
  running: boolean;
  /** Uncancellable work is in flight. */
  busy?: boolean;
  onRerun: () => void;
  onCancel: () => void;
  /** Names the run Re-run repeats; the button's accessible name and tooltip. */
  rerunLabel: string;
  /** Names the run Cancel stops. */
  cancelLabel: string;
}

export function AnalysisRerunAction({ running, busy = false, onRerun, onCancel, rerunLabel, cancelLabel }: AnalysisRunSlot) {
  const { t } = useTranslation();
  const label = running ? cancelLabel : rerunLabel;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1 px-2 text-xs"
      aria-label={label}
      title={label}
      disabled={busy && !running}
      onClick={running ? onCancel : onRerun}
    >
      {running
        ? <Square className="h-3.5 w-3.5" aria-hidden="true" />
        : busy ? <Spinner size="sm" /> : <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
      {t(running ? 'analysisPanel.cancel' : 'analysisPanel.rerun')}
    </Button>
  );
}

interface AnalysisRunButtonProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> {
  running: boolean;
  busy?: boolean;
  /** False while the inputs cannot run yet (Compare without an A/B pair). */
  canRun?: boolean;
  onRun: () => void;
  onCancel: () => void;
  runLabel: string;
  cancelLabel: string;
  /** The panel's own run glyph (Clash's crosshair); a play arrow otherwise. */
  icon?: ReactNode;
  /** Visual size: the body's primary action, or a compact secondary row. */
  size?: 'default' | 'sm';
}

export function AnalysisRunButton({
  running, busy = false, canRun = true, onRun, onCancel, runLabel, cancelLabel, icon, size = 'default', className, ...rest
}: AnalysisRunButtonProps) {
  return (
    <Button
      size={size}
      className={cn('w-full gap-1.5', className)}
      disabled={running ? false : busy || !canRun}
      onClick={running ? onCancel : onRun}
      {...rest}
    >
      {running
        ? <Square className="h-4 w-4" aria-hidden="true" />
        : busy ? <Spinner size="md" /> : (icon ?? <Play className="h-4 w-4" aria-hidden="true" />)}
      {running ? cancelLabel : runLabel}
    </Button>
  );
}
