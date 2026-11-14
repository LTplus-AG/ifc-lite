/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Store reads for the dimension exports (`lib/export/dimension-export.ts`) and their omission warning. */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { exportableDimensions } from '@/store/slices/drawing2DDimensions';
import { formatDimensionValue, type DimensionGraphics } from '@/lib/drawing2d-markup/dimension-graphics';
import { dimensionGraphicsList } from '@/lib/export/dimension-export';
import { axisFlipForSection, type SectionAxis } from '@/hooks/pdfSectionLayout';
import { toast } from '@/components/ui/toast';
import type { UseTranslationResult } from '@/i18n';

/** Paper scale denominator (100 for 1:100) and the section flip (or the axis to derive it from) an export draws with. */
export type ExportDimensionGraphics = (paperScale: number, flip: SectionAxis | { flipX: boolean; flipY: boolean }) => DimensionGraphics[];

/**
 * The graphics of the dimensions the drawing exports carry: those on the cut
 * now drawn (`exportableDimensions`), formatted with the viewer's length unit.
 * Dimensions drawn on another cut are left out of every export.
 */
export function useExportDimensionGraphics(): ExportDimensionGraphics {
  const dimensions2D = useViewerStore((s) => s.dimensions2D);
  const plane = useViewerStore((s) => s.drawing2DPlane);
  const overrides = useViewerStore((s) => s.unitDisplayOverrides);
  return useMemo(() => {
    const dimensions = exportableDimensions(dimensions2D, plane);
    const format = (metres: number) => formatDimensionValue(metres, overrides);
    return (paperScale, flip) => dimensionGraphicsList(dimensions, {
      paperScale,
      format,
      flip: typeof flip === 'string' ? axisFlipForSection(flip) : flip,
    });
  }, [dimensions2D, plane, overrides]);
}

/** How many dimensions every export leaves out because they were drawn on another cut. */
export function useOtherCutDimensionCount(): number {
  const dimensions2D = useViewerStore((s) => s.dimensions2D);
  const plane = useViewerStore((s) => s.drawing2DPlane);
  return useMemo(() => dimensions2D.length - exportableDimensions(dimensions2D, plane).length, [dimensions2D, plane]);
}

/**
 * SVG export and Print have no omission dialog (PDF and DXF list
 * `otherCutDimensions` before exporting), so after they run, tell the user
 * how many dimensions drawn on another cut they left out. Silent when none.
 */
export function noticeOtherCutDimensionsLeftOut(t: UseTranslationResult['t']): void {
  const { dimensions2D, drawing2DPlane } = useViewerStore.getState();
  const count = dimensions2D.length - exportableDimensions(dimensions2D, drawing2DPlane).length;
  if (count > 0) toast.info(t('section2d.export.otherCutDimensionsLeftOut', { count }));
}
