/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one analysis progress component (#5834). Extracted from IDS's
 * validation progress (headline, detail line, bar); Clash's hand-rolled
 * checking bar and BCF's busy row are the same thing with no detail or no
 * known total, so they render here too.
 *
 * `percent: null` is indeterminate work (Clash preparing geometry, a BCF
 * archive being read, a comparison without per-step counts). `complete` drops
 * the spinner for the frame between the last step and the result landing.
 */

import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';

export interface AnalysisProgressState {
  label: string;
  detail?: string | null;
  /** 0–100, or `null` while the total is unknown. */
  percent?: number | null;
  complete?: boolean;
}

export function AnalysisProgress({ label, detail = null, percent = null, complete = false }: AnalysisProgressState) {
  return (
    <output className="block space-y-1.5 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        {!complete && <Spinner size="sm" className="shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate font-medium tabular-nums">{label}</span>
      </div>
      {detail && <div className="text-2xs text-muted-foreground tabular-nums">{detail}</div>}
      {percent === null
        ? <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-muted"><div className="h-full w-2/5 animate-pulse bg-primary" /></div>
        : <Progress value={Math.max(0, Math.min(100, percent))} aria-hidden="true" className="h-1" />}
    </output>
  );
}
