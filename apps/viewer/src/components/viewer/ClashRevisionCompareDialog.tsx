/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare clash runs across model revisions (issue #3928).
 *
 * `@ifc-lite/clash` already ships the matching engine (`compareClashRuns`,
 * `compareClashRevisions`) — the issue is explicitly that it had no viewer
 * consumer. This is that consumer: a self-contained trigger + dialog, mirroring
 * `ClashSettingsDialog`'s shape (own `Dialog`, no external open/close state) so
 * it drops into the clash panel header as a single element.
 *
 * "Baseline" is ONE saved run (issue scope: one baseline vs one current run,
 * not history), persisted to localStorage (`lib/clash/revision-baseline.ts`)
 * independently of the zustand store — the panel/hook/slice trio for clash
 * detection is already at its module-size budget, so this feature holds its
 * own small piece of state rather than growing them.
 *
 * The three-way outcome is `added` / `persistent` / `resolved`, plus a fourth,
 * `unretested`: a previously-found clash this run could not confirm as fixed
 * (its rule was dropped from the matrix, its rule matched nothing on a side,
 * or one of its two models is no longer part of the comparison). It is never
 * folded into `resolved` — see `compareClashRevisions`'s module doc.
 */

import { useCallback, useMemo, useState } from 'react';
import { GitCompare, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { compareClashRevisions, type Clash, type ClashRevisionComparison } from '@ifc-lite/clash';
import {
  captureModelNames,
  loadRevisionBaseline,
  saveRevisionBaseline,
  type ClashRevisionBaseline,
} from '@/lib/clash/revision-baseline';

function formatWhen(takenAt: number): string {
  return new Date(takenAt).toLocaleString();
}

function clashLabel(c: Clash): string {
  return `${c.a.tag} × ${c.b.tag} (${c.rule})`;
}

/**
 * The banner lines explaining why `comparison.unretested` is non-empty.
 *
 * `comparison.reasons` only covers the three RULE/MODEL-granularity
 * conditions (revision.ts's module doc: a skipped rule, a rule that matched
 * nothing, or a missing model). `compareClashRevisions` also reclassifies a
 * clash via a finer, per-ELEMENT check (`elementsReexamined` — #3947: a
 * narrowed selector or membership list that drops just the one element a
 * clash depended on, while the rule and both models otherwise look fine to
 * the three coarser checks). That path leaves all three `reasons` arrays
 * empty, so a caller that renders a banner only when `reasons` has content
 * would show nothing for it — silently, since `comparison.unretested` is
 * still populated and rendered in its own bucket below, just without the
 * explanation the banner exists to give. Exported standalone so this case is
 * unit-testable without mounting the dialog.
 */
export function warningLines(comparison: ClashRevisionComparison | null): string[] {
  if (!comparison) return [];
  const { reasons } = comparison;
  const lines: string[] = [];
  if (reasons.skippedRuleIds.length > 0) {
    lines.push(`Not re-run this time: ${reasons.skippedRuleIds.join(', ')}.`);
  }
  if (reasons.noMatchRuleIds.length > 0) {
    lines.push(`Matched no elements this run: ${reasons.noMatchRuleIds.join(', ')}.`);
  }
  if (reasons.missingModelNames.length > 0) {
    lines.push(`Model(s) no longer in the comparison: ${reasons.missingModelNames.join(', ')}.`);
  }
  if (lines.length === 0 && comparison.unretested.length > 0) {
    lines.push(
      'One or more elements a clash depended on were not matched by the same rule this run ' +
        '(a narrowed selector or membership change) — it can no longer be confirmed as fixed.',
    );
  }
  return lines;
}

interface BucketProps {
  title: string;
  clashes: Clash[];
  tone: 'new' | 'persistent' | 'resolved' | 'unretested';
}

const TONE_CLASS: Record<BucketProps['tone'], string> = {
  new: 'text-[#f7768e]',
  persistent: 'text-[#e0af68]',
  resolved: 'text-[#9ece6a]',
  unretested: 'text-muted-foreground',
};

function Bucket({ title, clashes, tone }: BucketProps) {
  if (clashes.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className={`text-xs font-semibold ${TONE_CLASS[tone]}`}>
        {title} ({clashes.length})
      </div>
      <ul className="space-y-0.5 max-h-28 overflow-y-auto pr-1">
        {clashes.map((c) => (
          <li key={c.id} className="text-[11px] text-foreground/80 truncate" title={clashLabel(c)}>
            {clashLabel(c)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ClashRevisionCompareDialog() {
  const clashResult = useViewerStore((s) => s.clashResult);
  const models = useViewerStore((s) => s.models);

  const [baseline, setBaseline] = useState<ClashRevisionBaseline | null>(() => loadRevisionBaseline());
  const [comparison, setComparison] = useState<ClashRevisionComparison | null>(null);

  const saveBaseline = useCallback(() => {
    if (!clashResult) return;
    const next: ClashRevisionBaseline = {
      result: clashResult,
      modelNames: captureModelNames(clashResult, models),
      takenAt: Date.now(),
    };
    const outcome = saveRevisionBaseline(next);
    if (outcome.ok) {
      setBaseline(next);
      setComparison(null);
      toast.success(`Saved baseline (${clashResult.clashes.length} clash${clashResult.clashes.length === 1 ? '' : 'es'}).`);
    } else {
      toast.error(outcome.message);
    }
  }, [clashResult, models]);

  const compare = useCallback(() => {
    if (!baseline || !clashResult) return;
    const currentNames = captureModelNames(clashResult, models);
    setComparison(
      compareClashRevisions(
        { result: baseline.result, modelNames: baseline.modelNames },
        { result: clashResult, modelNames: currentNames },
      ),
    );
  }, [baseline, clashResult, models]);

  const warnings = useMemo(() => warningLines(comparison), [comparison]);

  return (
    <Dialog onOpenChange={(open) => { if (!open) setComparison(null); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Compare clash runs across revisions">
          <GitCompare className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-[#f7768e]" />
            Compare clash runs
          </DialogTitle>
          <DialogDescription>
            Save the current result as a baseline, then compare it against a later run — new,
            persisting, and no-longer-detected clashes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5">
            <div className="text-xs min-w-0">
              {baseline ? (
                <>
                  <div className="font-medium">Baseline saved {formatWhen(baseline.takenAt)}</div>
                  <div className="text-muted-foreground">
                    {baseline.result.clashes.length} clash{baseline.result.clashes.length === 1 ? '' : 'es'}
                  </div>
                </>
              ) : (
                <div className="text-muted-foreground">No baseline saved yet.</div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1"
              disabled={!clashResult}
              onClick={saveBaseline}
              title={clashResult ? 'Save the current result as the baseline' : 'Run clash detection first'}
            >
              <Save className="h-3.5 w-3.5" />
              Save current as baseline
            </Button>
          </div>

          <Button
            className="w-full h-8"
            disabled={!baseline || !clashResult}
            onClick={compare}
            title={!clashResult ? 'Run clash detection first' : !baseline ? 'Save a baseline first' : undefined}
          >
            Compare current result to baseline
          </Button>

          {comparison && (
            <div className="space-y-3 rounded-md border border-border p-2.5">
              {comparison.unretested.length > 0 && (
                <div className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground space-y-0.5">
                  <div className="font-medium text-foreground">
                    {comparison.unretested.length} clash{comparison.unretested.length === 1 ? '' : 'es'} could not
                    be confirmed as fixed:
                  </div>
                  {warnings.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              )}
              <Bucket title="New" clashes={comparison.added} tone="new" />
              <Bucket title="Persisting" clashes={comparison.persistent} tone="persistent" />
              <Bucket title="No longer detected" clashes={comparison.resolved} tone="resolved" />
              <Bucket title="Unconfirmed (not re-tested)" clashes={comparison.unretested} tone="unretested" />
              {comparison.added.length === 0 &&
                comparison.persistent.length === 0 &&
                comparison.resolved.length === 0 &&
                comparison.unretested.length === 0 && (
                  <div className="text-xs text-muted-foreground">No differences.</div>
                )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
