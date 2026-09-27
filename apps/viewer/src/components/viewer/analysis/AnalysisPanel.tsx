/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The analysis-panel scaffold (#5834, charter #5613): the chrome IDS, Clash,
 * Compare and BCF each used to re-implement, in one place and in one order.
 *
 *   header      icon + title (+ badge) · panel actions · run slot · clear · close
 *   error       one error surface (#5600's dismissable alert)
 *   progress    one progress component
 *   stale       the #5820 banner, while the result on screen predates an edit
 *   body        the panel's own controls and results
 *
 * The run slot is the ONE place a finished analysis is re-run or a running one
 * cancelled (#5816, #5818, #5831): Re-run repeats the run that produced the
 * result on screen, and turns into Cancel while a run is in flight. The body
 * keeps each panel's first-run control, because what a first run needs (an IDS
 * document, a detection mode, an A/B pair) is the panel's own business.
 *
 * Staleness reaches the body through context, so a panel dims exactly the
 * regions that show the old result by wrapping them in `AnalysisStaleRegion`,
 * instead of repeating `stale && 'opacity-60'` next to every one of them.
 */

import { createContext, useContext, type HTMLAttributes, type ReactNode } from 'react';
import { Eraser, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { analysisStampOf, useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import { AnalysisError } from './AnalysisError';
import { AnalysisProgress, type AnalysisProgressState } from './AnalysisProgress';
import { AnalysisRerunAction, type AnalysisRunSlot } from './AnalysisRunActions';
import { StaleResultBanner } from './StaleResultBanner';

const StaleContext = createContext(false);

interface AnalysisPanelProps {
  icon: ReactNode;
  title: string;
  /** Beside the title, e.g. BCF's topic count. */
  badge?: ReactNode;
  /** Panel-specific header actions (load, import, settings, help…). */
  actions?: ReactNode;
  /** Re-run / Cancel for a finished analysis; absent for a panel that runs nothing. */
  run?: AnalysisRunSlot;
  /** Drop the result on screen and keep the panel's inputs. */
  onClearResults?: () => void;
  onClose?: () => void;
  /** Hosted inside another panel's header (IDS inside Data validation):
   *  the host owns the title and the close button. */
  embedded?: boolean;
  /** Render no header row at all. */
  headerHidden?: boolean;
  error?: string | null;
  onDismissError?: () => void;
  progress?: AnalysisProgressState | null;
  /** The report the result on screen was computed from (stamped at run time,
   *  #5820); once the model changes under it the result is stale, and
   *  `run.onRerun` refreshes it. */
  staleFor?: object | null;
  className?: string;
  children: ReactNode;
}

export function AnalysisPanel({
  icon, title, badge, actions, run, onClearResults, onClose, embedded = false, headerHidden = false,
  error = null, onDismissError, progress = null, staleFor = null, className, children,
}: AnalysisPanelProps) {
  const { t } = useTranslation();
  const hasResult = run?.hasResult ?? false;
  const stale = useAnalysisStaleness(analysisStampOf(staleFor));
  return (
    <div className={cn('h-full flex flex-col bg-background text-foreground overflow-hidden min-w-0', className)}>
      {!headerHidden && (
        <div className="flex items-center gap-2 p-3 border-b border-border">
          {!embedded && (
            <>
              <span aria-hidden="true" className="flex shrink-0 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
              <h2 className="text-sm font-semibold tracking-tight min-w-0 truncate">{title}</h2>
              {badge}
            </>
          )}
          <div className="ml-auto flex items-center gap-1 shrink-0">
            {run && hasResult && <AnalysisRerunAction {...run} />}
            {onClearResults && hasResult && (
              <IconButton label={t('analysisPanel.clearResults')} className="h-7 w-7" onClick={onClearResults}>
                <Eraser className="h-4 w-4" />
              </IconButton>
            )}
            {actions}
            {onClose && !embedded && (
              <IconButton label={t('analysisPanel.close')} className="h-7 w-7" onClick={onClose}>
                <X className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        </div>
      )}
      {error && <AnalysisError message={error} onDismiss={onDismissError} />}
      {progress && <AnalysisProgress {...progress} />}
      {run && hasResult && stale && <StaleResultBanner disabled={run.running || run.busy} onRerun={run.onRerun} />}
      <StaleContext.Provider value={hasResult && stale}>{children}</StaleContext.Provider>
    </div>
  );
}

/** Whether the result on screen is stale; for regions that dim themselves. */
function useAnalysisResultStale(): boolean {
  return useContext(StaleContext);
}

/** A region showing the result on screen, dimmed while that result is stale. */
export function AnalysisStaleRegion({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const stale = useAnalysisResultStale();
  return <div className={cn(className, stale && 'opacity-60')} {...rest}>{children}</div>;
}
