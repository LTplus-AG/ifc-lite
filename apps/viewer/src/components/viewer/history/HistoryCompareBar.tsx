/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The A/B strip above the timeline, and the stored-diff preview under it.
 *
 * The preview is the cheap half of comparing (`useCommitCompare`): counts and
 * the first hundred changed elements, from one request, with no model loaded.
 * "Show in 3D" is the expensive half and is a separate, explicit click.
 */

import { ArrowRight } from 'lucide-react';
import type { SourceCommit, StoredDiffEntry } from '@ifc-lite/plugin-api';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { shortCommitId } from '@/lib/history/commitLabels';
import type { CommitCompareState } from '@/hooks/history/useCommitCompare';

const GROUP_LABEL: Readonly<Record<StoredDiffEntry['state'], TranslationKey>> = {
  added: 'history.compare.groupAdded',
  modified: 'history.compare.groupModified',
  deleted: 'history.compare.groupDeleted',
};

export interface HistoryCompareBarProps {
  readonly a: SourceCommit | null;
  readonly b: SourceCommit | null;
  readonly compare: CommitCompareState;
  readonly onClearSlot: (slot: 'A' | 'B') => void;
  readonly onShowIn3D: () => void;
  readonly showing3D: boolean;
}

function Slot({ label, commit, onClear }: { label: string; commit: SourceCommit | null; onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClear}
      disabled={!commit}
      className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-left text-[11px] disabled:opacity-60"
      title={commit?.message ?? undefined}
    >
      <span className="mr-1 font-semibold">{label}</span>
      <span className="truncate text-muted-foreground">
        {commit ? shortCommitId(commit.id) : t('history.compare.none')}
      </span>
    </button>
  );
}

export function HistoryCompareBar({ a, b, compare, onClearSlot, onShowIn3D, showing3D }: HistoryCompareBarProps) {
  const { t } = useTranslation();
  const counts = compare.diff?.counts;

  return (
    <div className="border-b px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">{t('history.compare.label')}</span>
        <Slot label={t('history.compare.slotA')} commit={a} onClear={() => onClearSlot('A')} />
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Slot label={t('history.compare.slotB')} commit={b} onClear={() => onClearSlot('B')} />
        <Button
          variant="secondary"
          size="sm"
          className="h-6 shrink-0 text-[11px]"
          onClick={onShowIn3D}
          disabled={!a || !b || showing3D}
        >
          {t('history.compare.showIn3D')}
        </Button>
      </div>

      {a && b && (
        <div className="mt-1.5 text-[11px]">
          {compare.calculating && <span className="text-muted-foreground">{t('history.compare.calculating')}</span>}
          {!compare.calculating && !compare.supported && (
            <span className="text-muted-foreground">{t('history.compare.unsupported')}</span>
          )}
          {compare.error && <span className="text-destructive">{compare.error}</span>}
          {counts && (
            <>
              <div className="tabular-nums text-muted-foreground">
                {t('history.compare.counts', {
                  added: counts.added,
                  modified: counts.modified,
                  deleted: counts.deleted,
                })}
              </div>
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                {compare.groups.map((group) => (
                  <li key={`${group.state}:${group.ifcType}`} className="flex items-baseline gap-1.5">
                    <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t(GROUP_LABEL[group.state])}
                    </span>
                    {/* The IFC type verbatim — it is the class the user will
                        look for in their own model, not a label to prettify. */}
                    <span className="truncate">{group.ifcType}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{group.entries.length}</span>
                  </li>
                ))}
              </ul>
              {compare.truncated > 0 && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {t('history.compare.more', { count: compare.truncated })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
