/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A bulk action that names its scope (U02, #6925): the label is a complete
 * message with the count in it ("Draft topics from 3 selected groups",
 * "Apply 18 reviewed changes"), written by the panel that owns the noun.
 * `acts` says which membership the action applies to; the button is enabled
 * only when that membership is authoritative and non-empty, so an action over
 * "all matching" cannot run on a page-sized or still-loading subset.
 */

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { canActOnPopulation, canActOnSelection, type ResultSelection } from '@/lib/result/selection-model';

type Acts = 'selected' | 'population' | 'batch';

interface ResultActionProps {
  acts: Acts;
  selection: ResultSelection;
  /** Complete, counted message naming the scope. */
  label: string;
  /** Longer explanation, shown as the tooltip. */
  title?: string;
  icon?: ReactNode;
  onRun: (keys: ReadonlySet<string>) => void;
  disabled?: boolean;
}

function members(acts: Acts, selection: ResultSelection): ReadonlySet<string> | null {
  if (acts === 'batch') return selection.included.size > 0 ? selection.included : null;
  if (acts === 'population') return canActOnPopulation(selection) ? selection.selected : null;
  return canActOnSelection(selection) ? selection.selected : null;
}

export function ResultAction({ acts, selection, label, title, icon, onRun, disabled = false }: ResultActionProps) {
  const target = members(acts, selection);
  return (
    <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-2xs" title={title} disabled={disabled || target === null}
      onClick={() => { if (target) onRun(target); }}>
      {icon}
      {label}
    </Button>
  );
}

interface SelectionSummaryProps {
  /** Whether a row is focused (its evidence / 3D target shown). */
  highlighted: boolean;
  selected: number;
  /** Rows pinned into a prepared batch; omit where the panel has no batch. */
  included?: number;
}

/** Highlighted, selected and in-batch, stated separately; nothing when all are empty. */
export function SelectionSummary({ highlighted, selected, included }: SelectionSummaryProps) {
  const { t, locale } = useTranslation();
  const n = (count: number) => ({ count, countDisplay: formatLocaleNumber(locale, count) });
  const parts = [
    highlighted && t('resultSelection.highlighted'),
    selected > 0 && t('resultSelection.selected', n(selected)),
    included !== undefined && included > 0 && t('resultSelection.included', n(included)),
  ].filter((part): part is string => typeof part === 'string');
  return (
    <p className="text-2xs text-muted-foreground tabular-nums" aria-live="polite">
      {parts.join(' · ')}
    </p>
  );
}
