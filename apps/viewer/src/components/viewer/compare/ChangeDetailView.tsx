/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-element "what changed" detail (issue #924): geometry move / reshape
 * summary + data field deltas. Extracted from ComparePanel.
 */

import { PencilLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useTranslation } from '@/i18n';
import type { ChangeDetail, FieldDelta } from '@/lib/compare/describeChange';
import type { GeometrySummary } from '@/lib/compare/geometrySummary';
import type { CompareRow } from './changeRow';

export function ChangeDetailView({ row, detail }: { row: CompareRow; detail: ChangeDetail }) {
  const { t } = useTranslation();
  return (
    <div className="border-t border-border shrink-0 max-h-[42%] overflow-auto" {...tourAnchor(TOUR_ANCHORS.compareDetail)}>
      <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-1.5 sticky top-0 bg-background">
        <PencilLine className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-semibold truncate">{row.name || row.ifcType}</span>
        <span className="ml-auto text-2xs text-muted-foreground shrink-0">{row.ifcType.replace(/^Ifc/, '')}</span>
      </div>
      <div className="px-3 pb-3 space-y-2.5 text-xs">
        {detail.geometry && (
          <div className="space-y-1">
            <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('comparePanel.changeDetail.geometryLabel')}
            </div>
            <GeometryDetail summary={detail.geometry} />
          </div>
        )}
        {detail.data.length > 0 ? (
          <div className="space-y-1">
            <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('comparePanel.changeDetail.dataLabel')} <span className="text-muted-foreground">({detail.data.length})</span>
            </div>
            <div className="space-y-1">
              {detail.data.map((d, i) => <FieldDeltaRow key={i} delta={d} />)}
            </div>
          </div>
        ) : detail.dataOnlyGeometric ? (
          <div className="text-2xs text-muted-foreground italic">
            {t('comparePanel.changeDetail.dataFingerprintOnly')}
          </div>
        ) : !detail.geometry ? (
          <div className="text-2xs text-muted-foreground italic">{t('comparePanel.changeDetail.noFieldDetail')}</div>
        ) : null}
      </div>
    </div>
  );
}

function GeometryDetail({ summary }: { summary: GeometrySummary }) {
  const { t } = useTranslation();
  const moved = summary.movedDistance > 0;
  const fmt = (n: number) => (Math.abs(n) < 1e-3 ? '0' : n.toFixed(Math.abs(n) >= 1 ? 2 : 3));
  const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
  const headline = summary.reshaped
    ? moved
      ? t('comparePanel.changeDetail.headlineReshapedMoved')
      : t('comparePanel.changeDetail.headlineReshaped')
    : moved
      ? t('comparePanel.changeDetail.headlineMoved')
      : t('comparePanel.changeDetail.headlineGeometryChanged');
  return (
    <div className="rounded border border-border/60 px-2 py-1.5 space-y-0.5">
      <div className="font-medium">{headline}</div>
      {moved && (
        <div className="text-muted-foreground tabular-nums">
          {t('comparePanel.changeDetail.movedLine', {
            distance: fmt(summary.movedDistance),
            dx: fmt(summary.delta.x),
            dy: fmt(summary.delta.y),
            dz: fmt(summary.delta.z),
          })}
        </div>
      )}
      {summary.reshaped && (
        <div className="text-muted-foreground tabular-nums">
          {t('comparePanel.changeDetail.sizeLine', {
            dx: signed(summary.sizeDelta.x),
            dy: signed(summary.sizeDelta.y),
            dz: signed(summary.sizeDelta.z),
          })}
        </div>
      )}
      {!moved && !summary.reshaped && (
        <div className="text-muted-foreground text-2xs">
          {t('comparePanel.changeDetail.unchangedShapeHash')}
        </div>
      )}
    </div>
  );
}

function FieldDeltaRow({ delta }: { delta: FieldDelta }) {
  const kindColor: Record<FieldDelta['kind'], string> = {
    changed: 'text-[#e0af68]',
    added: 'text-[#9ece6a]',
    removed: 'text-[#f7768e]',
  };
  return (
    <div className="rounded border border-border/40 px-2 py-1">
      <div className="flex items-baseline gap-1.5 min-w-0">
        {delta.group && <span className="text-2xs text-muted-foreground shrink-0 truncate max-w-[40%]">{delta.group}</span>}
        <span className="text-2xs font-medium truncate">{delta.name}</span>
        <span className={cn('ml-auto text-2xs shrink-0', kindColor[delta.kind])}>{delta.kind}</span>
      </div>
      <div className="flex items-center gap-1.5 text-2xs tabular-nums mt-0.5 min-w-0">
        <span className="text-muted-foreground line-through truncate max-w-[45%]">{delta.before ?? '—'}</span>
        <span className="text-muted-foreground shrink-0">→</span>
        <span className="truncate max-w-[45%]">{delta.after ?? '—'}</span>
      </div>
    </div>
  );
}
