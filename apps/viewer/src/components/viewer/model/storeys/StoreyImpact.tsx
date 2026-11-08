/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a typed storey edit changes (#9013), shown while it is typed: which of
 * the two edits it is, a compact impact ("Moves 1 storey · moves 24 elements
 * · resizes 8 walls · refits 1 stair"), and anything the edit leaves as it is,
 * with a way to select those elements.
 */

import type { StoreySummary } from '@ifc-lite/create';
import { Eye, Info } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { impactParts, noticeText } from '@/lib/storeys/storey-text';
import type { LevelDraft } from './useStoreyManager';

interface StoreyImpactProps {
  draft: LevelDraft;
  rows: readonly StoreySummary[];
  onSelect: (ids: readonly number[]) => void;
}

export function StoreyImpact({ draft, rows, onSelect }: StoreyImpactProps) {
  const { t } = useTranslation();
  const shared = useViewerStore((s) => s.collabSession !== null);
  const storey = rows.find((row) => row.expressId === draft.storeyId)?.Name ?? '';
  const plan = draft.plan;
  return (
    <section
      aria-live="polite"
      aria-label={t('storeyManager.impact.title')}
      data-storey-impact
      className="mx-2 mb-2 space-y-1 rounded-md border border-border bg-muted/40 p-2 text-2xs"
    >
      <p className="text-muted-foreground">
        {t(draft.field === 'elevation' ? 'storeyManager.mode.elevation' : 'storeyManager.mode.height', { storey })}
      </p>
      {plan && plan.refusals.length === 0 && (
        <>
          <p data-storey-impact-summary className="font-medium text-foreground">{impactParts(t, plan).join(' · ')}</p>
          {plan.notices.map((notice) => (
            <div key={notice.code} className="flex items-start gap-1.5 text-warn">
              <Info aria-hidden className="mt-px h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1">{noticeText(t, notice)}</span>
              <Button size="sm" variant="link" className="h-auto p-0 text-2xs" onClick={() => onSelect(notice.elementIds)}>
                {t('storeyManager.notice.select')}
              </Button>
            </div>
          ))}
          <p className="flex items-center gap-1 text-muted-foreground">
            <Eye aria-hidden className="h-3 w-3" />
            {t(shared ? 'storeyManager.impact.planOnly' : 'storeyManager.impact.preview')}
            <span aria-hidden>·</span>
            {t('storeyManager.field.hint')}
          </p>
        </>
      )}
      {draft.error && plan?.refusals[0]?.elementIds?.length ? (
        <Button size="sm" variant="link" className="h-auto p-0 text-2xs" onClick={() => onSelect(plan.refusals[0].elementIds ?? [])}>
          {t('storeyManager.notice.select')}
        </Button>
      ) : null}
    </section>
  );
}
