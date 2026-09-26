/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The **Suggestions** section of the compare results list (issue #4955): what
 * the engine found but would not decide, each with the evidence it rests on.
 *
 * - A **successor** row ("Replaced · footprint 0.81 · 0.02 m · agrees on ...")
 *   has Accept and Not the same. Accept mints an identity-map entry in the
 *   store; the next re-diff replays it as a key alias and the pair leaves
 *   this list, classified by key.
 * - A **split / merge** row is grouped display only: identity is not a
 *   relation that survives a split, so there is nothing to accept. The
 *   lineage sidecar carries it.
 * - An **unresolved group** (ambiguous / duplicated / deduplicated) offers a
 *   1:1 pairing: pick one A and one B candidate, then Accept or Not the same
 *   for THAT pair. The engine never mints these (`04-identity.md` §4.5); the
 *   entry's reason is `accepted:ambiguous`.
 *
 * None of these rows recolours the 3D scene: every participant keeps its
 * add / delete colour (`overlay.ts` reads retiring matches only).
 */

import { useState } from 'react';
import { TriangleAlert, MousePointerClick } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { rgbaCss, type RGBA } from '@/lib/compare/overlay';
import { pairIsOpen, type SuggestionCandidate, type SuggestionDecisions, type SuggestionRow } from '@/lib/compare/suggestions';
import { MAX_ROWS_PER_GROUP } from './changeRow';

/** Amber, matching the panel's existing warning text colour (`#e0af68`). */
export const SUGGESTION_COLOR: RGBA = [0.878, 0.686, 0.408, 1];

export interface SuggestionDecision {
  row: SuggestionRow;
  base: string;
  here: string;
}

interface CompareSuggestionsProps {
  rows: SuggestionRow[];
  selectedKey: string | null;
  decisions: SuggestionDecisions;
  onFocus: (row: SuggestionRow) => void;
  onFocusGroup: (rows: SuggestionRow[]) => void;
  onAccept: (decision: SuggestionDecision) => void;
  onReject: (decision: SuggestionDecision) => void;
}

function candidateLabel(c: SuggestionCandidate): string {
  return c.name ? `${c.name} (${c.key})` : c.key;
}

/** Accept / Not the same for one 1:1 pair. A group with several candidates on
 *  a side gets a picker per side; the pair is whatever is picked. */
function SuggestionActions({
  row,
  decisions,
  onAccept,
  onReject,
}: Pick<CompareSuggestionsProps, 'decisions' | 'onAccept' | 'onReject'> & { row: SuggestionRow }) {
  const { t } = useTranslation();
  const [base, setBase] = useState(row.bases[0]?.key ?? '');
  const [here, setHere] = useState(row.heads[0]?.key ?? '');
  if (row.bases.length === 0 || row.heads.length === 0) return null;
  const open = pairIsOpen(row, base, here, decisions);
  const picker = row.bases.length > 1 || row.heads.length > 1;
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
      {picker && (
        <>
          <select
            aria-label={t('comparePanel.suggestions.candidateAAriaLabel')}
            className="h-6 max-w-[45%] truncate rounded border border-border bg-background text-2xs"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          >
            {row.bases.map((c) => <option key={c.key} value={c.key}>{candidateLabel(c)}</option>)}
          </select>
          <span className="text-2xs text-muted-foreground">{t('comparePanel.suggestions.isConnector')}</span>
          <select
            aria-label={t('comparePanel.suggestions.candidateBAriaLabel')}
            className="h-6 max-w-[45%] truncate rounded border border-border bg-background text-2xs"
            value={here}
            onChange={(e) => setHere(e.target.value)}
          >
            {row.heads.map((c) => <option key={c.key} value={c.key}>{candidateLabel(c)}</option>)}
          </select>
        </>
      )}
      <div className="ml-auto flex items-center gap-1">
        {!open && <span className="text-2xs text-muted-foreground">{t('comparePanel.suggestions.decidedLabel')}</span>}
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-2xs"
          disabled={!open}
          onClick={() => onAccept({ row, base, here })}
        >
          {t('comparePanel.suggestions.acceptButton')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-2xs"
          disabled={!open}
          onClick={() => onReject({ row, base, here })}
        >
          {t('comparePanel.suggestions.notSameButton')}
        </Button>
      </div>
    </div>
  );
}

export function CompareSuggestions({
  rows,
  selectedKey,
  decisions,
  onFocus,
  onFocusGroup,
  onAccept,
  onReject,
}: CompareSuggestionsProps) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  // Same display cap as every other section (see `MAX_ROWS_PER_GROUP`): the
  // header count and the header's select-all keep the FULL set.
  const shown = rows.length > MAX_ROWS_PER_GROUP ? rows.slice(0, MAX_ROWS_PER_GROUP) : rows;
  const truncated = rows.length - shown.length;
  return (
    <div>
      <button
        type="button"
        onClick={() => onFocusGroup(rows)}
        title={t('comparePanel.suggestions.selectAllTitle')}
        className="group w-full flex items-center gap-1.5 px-1 py-1 text-xs font-medium rounded hover:bg-muted transition-colors"
      >
        <TriangleAlert className="h-3.5 w-3.5" style={{ color: rgbaCss(SUGGESTION_COLOR) }} />
        <span>{t('comparePanel.suggestions.sectionLabel')}</span>
        <span className="text-muted-foreground">({rows.length})</span>
        <MousePointerClick className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-60 transition-opacity" />
      </button>
      <div className="space-y-0.5">
        {shown.map((row) => (
          <div key={row.key} className={cn('rounded', selectedKey === row.key && 'bg-muted')}>
            <button
              onClick={() => onFocus(row)}
              title={row.evidence}
              className="w-full text-left rounded px-2 py-1 flex items-center gap-2 hover:bg-muted transition-colors min-w-0"
            >
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: rgbaCss(SUGGESTION_COLOR) }} />
              <span className="min-w-0 flex-1 truncate text-xs">{row.name || row.ifcType}</span>
              {row.crossClass && (
                <span className="shrink-0 rounded border border-border px-1 text-2xs text-muted-foreground" title={t('comparePanel.suggestions.classChangedTitle')}>
                  {t('comparePanel.suggestions.classChangedLabel')}
                </span>
              )}
              <span className="shrink-0 text-2xs text-muted-foreground">{row.evidence}</span>
            </button>
            <SuggestionActions
              row={row}
              decisions={decisions}
              onAccept={onAccept}
              onReject={onReject}
            />
          </div>
        ))}
        {truncated > 0 && (
          <p className="px-2 py-1 text-2xs text-muted-foreground">
            {t('comparePanel.moreNotShown', { count: truncated })}
          </p>
        )}
      </div>
    </div>
  );
}
