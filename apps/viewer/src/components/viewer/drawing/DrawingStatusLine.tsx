/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Spinner } from '@/components/ui/spinner';

/**
 * The Drawing panel's status line (#5494): the active tool's hint on the
 * left, regeneration progress and the markup facts on the right. It replaces
 * the tips that floated at the canvas' bottom-right and the floating
 * "Updating…" chip, so nothing but the text editor sits over the canvas.
 */


import type { Annotation2DTool, SelectedAnnotation2D } from '@/store/slices/drawing2DSlice';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

export interface DrawingStatusLineProps {
  activeTool: Annotation2DTool;
  measureStarted: boolean;
  shiftLocked: boolean;
  snapped: boolean;
  polygonPointCount: number;
  cloudPointCount: number;
  textEditing: boolean;
  selection: SelectedAnnotation2D | null;
  counts: { measurements: number; areas: number; texts: number; clouds: number };
  underlayCount: number;
  updating: boolean;
}

export function DrawingStatusLine(p: DrawingStatusLineProps) {
  const { t } = useTranslation();

  let hint: string;
  switch (p.activeTool) {
    case 'measure':
      hint = p.measureStarted ? t('section2d.tip.measureSecond') : t('section2d.tip.measureFirst');
      break;
    case 'polygon-area':
      hint = p.polygonPointCount === 0 ? t('section2d.tip.polygonFirst')
        : p.polygonPointCount < 3 ? t('section2d.tip.polygonNeed', { count: p.polygonPointCount })
          : t('section2d.tip.polygonClose');
      break;
    case 'cloud':
      hint = p.cloudPointCount === 0 ? t('section2d.tip.cloudFirst') : t('section2d.tip.cloudSecond');
      break;
    case 'text':
      hint = p.textEditing ? t('section2d.tip.textEditing') : t('section2d.tip.text');
      break;
    default:
      hint = p.selection
        ? (p.selection.type === 'text' ? t('section2d.tip.selectionText') : t('section2d.tip.selectionOther'))
        : t('section2d.tip.pan');
  }

  const facts: string[] = [];
  if (p.counts.measurements > 0) facts.push(t('section2d.status.measurements', { count: p.counts.measurements }));
  if (p.counts.areas > 0) facts.push(t('section2d.status.areas', { count: p.counts.areas }));
  if (p.counts.texts > 0) facts.push(t('section2d.status.texts', { count: p.counts.texts }));
  if (p.counts.clouds > 0) facts.push(t('section2d.status.clouds', { count: p.counts.clouds }));
  if (p.underlayCount > 0) facts.push(t('section2d.status.underlays', { count: p.underlayCount }));
  if (facts.length === 0) facts.push(t('section2d.status.noMarkup'));

  return (
    <div role="status" className="flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground tabular-nums">
      <span className="min-w-0 flex-1 truncate">{hint}</span>
      {p.activeTool === 'measure' && p.measureStarted && (
        <span className={cn('shrink-0', p.shiftLocked && 'text-primary')}>{t('section2d.tip.shift')}</span>
      )}
      {p.snapped && <span className="shrink-0">{t('section2d.status.snapped')}</span>}
      {p.updating && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Spinner size="xs" />
          {t('section2d.updating')}
        </span>
      )}
      <span className="hidden shrink-0 sm:inline">{facts.join(' · ')}</span>
    </div>
  );
}
