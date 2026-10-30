/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The persistent viewport chip for a retained-kernel model (#7955 M2, §2.2):
 * "Retained · shape-only · 91/119 products · 28 refused", its state
 * (running / complete / incomplete / stopped), and a tooltip naming the
 * presentation obligations the shape-only meshes leave unmet. It is the M1
 * marker obligation on screen, and the entry to the Retained geometry panel.
 * Renders nothing unless a model carries a retained summary.
 */

import { useState } from 'react';
import { Shapes } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';
import { HudItem, HudSurface } from '../viewport-ui/hud';
import { RetainedGeometryPanel, useObligationList } from './RetainedGeometryPanel';

export interface RetainedGeometryChipProps {
  /** Loads a file as the primary model ("Reload with exact kernel"). */
  reload: (file: File) => unknown;
}

function chipState(summary: RetainedGeometrySummary): 'running' | 'complete' | 'incomplete' | 'stopped' {
  return summary.failure ? 'stopped' : summary.completeness;
}

export function RetainedGeometryChip({ reload }: RetainedGeometryChipProps) {
  // The model object itself: a stable reference until the model changes.
  const model = useViewerStore((state) => {
    for (const candidate of state.models.values()) if (candidate.retainedGeometry) return candidate;
    return null;
  });
  if (!model?.retainedGeometry) return null;
  return <RetainedGeometryChipBody modelId={model.id} summary={model.retainedGeometry} sourceFile={model.sourceFile} reload={reload} />;
}

function RetainedGeometryChipBody({ modelId, summary, sourceFile, reload }: {
  modelId: string; summary: RetainedGeometrySummary; sourceFile?: File; reload: RetainedGeometryChipProps['reload'];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const obligations = useObligationList(summary.obligationsUnmet);
  const state = chipState(summary);
  const refused = summary.refused.length - summary.cancelled;
  const final = summary.published > 0 && summary.obligationsUnmet.length === 0;
  const presentation = t(final ? 'retainedGeometry.final' : 'retainedGeometry.shapeOnly');
  const counts = { presentation, published: String(summary.published), candidates: String(summary.candidates), refused: String(refused), cancelled: String(summary.cancelled) };
  const label = summary.completeness === 'running' && !summary.failure
    ? !summary.started
      ? t('retainedGeometry.chip.starting', { presentation })
      : t('retainedGeometry.chip.running', { presentation, done: String(summary.published + summary.refused.length), candidates: counts.candidates })
    : summary.cancelled > 0 ? t('retainedGeometry.chip.labelCancelled', counts) : t('retainedGeometry.chip.label', counts);
  const title = obligations ? t('retainedGeometry.chip.title', { obligations })
    : t(final ? 'retainedGeometry.chip.titleFinal' : 'retainedGeometry.chip.titleNone');

  // Order 4: after the edit-mode (0), level (1), section (2) and measurements (3) chips.
  return (
    <HudItem region="top-left" order={4}>
      <HudSurface className="flex max-w-[22rem] items-center px-0.5 py-0.5 text-xs">
        <button type="button" onClick={() => setOpen(true)} title={title} aria-label={t('retainedGeometry.chip.aria')}
          data-retained-chip={state} className="flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left hover:bg-accent">
          <Shapes aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 tabular-nums">{label}</span>
          <span className={state === 'complete' ? 'shrink-0 text-muted-foreground' : 'shrink-0 font-medium text-amber-600 dark:text-amber-400'}>
            {t(`retainedGeometry.chip.state.${state}`)}
          </span>
        </button>
      </HudSurface>
      <RetainedGeometryPanel modelId={modelId} summary={summary} sourceFile={sourceFile} open={open} onOpenChange={setOpen} reload={reload} />
    </HudItem>
  );
}
