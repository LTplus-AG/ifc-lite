/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "what the sheet looks like" half of the to-scale 3D-view PDF dialog
 * (#2042): render mode, hidden edges, and the resolution the shading will
 * actually get.
 *
 * WHY THE TWO CONTROLS ARE COUPLED. Dashed hidden edges exist so an engineer
 * can tell a real edge from one that is occluded. Draw them over a solidly
 * shaded surface and a dash across a wall reads as an edge ON that wall, which
 * is the one reading dashes exist to rule out - so the exporter forces them off
 * in shaded mode, and this switch says so instead of moving a control that
 * changes nothing. (A disabled switch that still LOOKED live would be the same
 * defect one layer up: a control the user moves and the PDF ignores.)
 *
 * WHY THE RESOLUTION IS STATED. The shading is a raster, and on a very large
 * sheet its pixel count hits a memory cap, so the image gets softer. That costs
 * sharpness and nothing else: the placement rectangle comes from the world
 * bounds through the one scale transform, never from the pixel grid, and every
 * line stays a vector stroke. Saying the number out loud is what stops a soft
 * print being read as a mis-scaled one.
 */

import { useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MAX_SHADING_DIMENSION_PX,
  MAX_SHADING_PIXELS,
  fitRasterPixels,
} from '@ifc-lite/drawing-2d';
import { VIEW_PDF_SHADING_DPI } from '@/lib/export/view-pdf/view-pdf-shading';
import type { ViewPdfRenderMode } from '@/lib/export/view-pdf/generate-view-pdf';

export interface PdfViewAppearanceSectionProps {
  renderMode: ViewPdfRenderMode;
  onRenderModeChange: (mode: ViewPdfRenderMode) => void;
  showHiddenEdges: boolean;
  onShowHiddenEdgesChange: (show: boolean) => void;
  /** Ink area of the sheet (page minus margins), or `null` when unknown yet. */
  drawingWidthMm: number | null;
  drawingHeightMm: number | null;
}

/**
 * The shading resolution sentence for a drawing of this size, or `null` when
 * the page is not known yet.
 *
 * The fit is computed by the SAME function the exporter hands the rasteriser,
 * so the number shown is the number the sheet gets. `fitRasterPixels` throws on
 * a non-positive size rather than inventing a grid, so the guard below is a
 * precondition check and not a swallowed failure.
 */
export function describeShadingResolution(
  drawingWidthMm: number | null,
  drawingHeightMm: number | null,
): string | null {
  if (
    drawingWidthMm === null || drawingHeightMm === null ||
    !Number.isFinite(drawingWidthMm) || !Number.isFinite(drawingHeightMm) ||
    drawingWidthMm <= 0 || drawingHeightMm <= 0
  ) {
    return null;
  }
  const fit = fitRasterPixels(
    drawingWidthMm,
    drawingHeightMm,
    VIEW_PDF_SHADING_DPI,
    MAX_SHADING_PIXELS,
    MAX_SHADING_DIMENSION_PX,
  );
  const dpi = Math.round(fit.effectiveDpi);
  if (!fit.capped) return `Shading resolution: ${dpi} dpi.`;
  return (
    `Shading resolution: ${dpi} dpi (reduced from ${VIEW_PDF_SHADING_DPI} to keep the ` +
    'image within memory limits). Line work stays vector and exact.'
  );
}

export function PdfViewAppearanceSection({
  renderMode,
  onRenderModeChange,
  showHiddenEdges,
  onShowHiddenEdgesChange,
  drawingWidthMm,
  drawingHeightMm,
}: PdfViewAppearanceSectionProps) {
  const shaded = renderMode === 'shaded';
  const resolution = useMemo(
    () => (shaded ? describeShadingResolution(drawingWidthMm, drawingHeightMm) : null),
    [shaded, drawingWidthMm, drawingHeightMm],
  );

  return (
    <>
      <div className="flex items-center gap-4">
        <Label className="w-24" htmlFor="pdf-view-render-mode">
          Appearance
        </Label>
        <Select
          value={renderMode}
          onValueChange={(value) => onRenderModeChange(value as ViewPdfRenderMode)}
        >
          <SelectTrigger id="pdf-view-render-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="shaded">Shaded surfaces</SelectItem>
            <SelectItem value="lines">Line work only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="pdf-view-appearance-note">
        {shaded
          ? 'Surfaces print in their model colours, shaded the way the 3D viewport shows them. ' +
            'The line work on top stays vector, so the sheet is still measurable.'
          : 'Monochrome line work only. No fills, materials, textures or point clouds.'}
        {resolution ? ` ${resolution}` : ''}
      </p>

      <div className="flex items-center justify-between gap-4">
        <Label className="text-sm font-normal" htmlFor="pdf-view-hidden-edges">
          Show hidden edges as dashed lines
        </Label>
        <Switch
          id="pdf-view-hidden-edges"
          checked={shaded ? false : showHiddenEdges}
          disabled={shaded}
          onCheckedChange={onShowHiddenEdgesChange}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {shaded
          ? 'Hidden edges apply to the line work mode. The shaded image already hides occluded surfaces.'
          : showHiddenEdges
            ? 'Edges behind other geometry print as dashed lines.'
            : 'Only edges you can actually see are printed.'}
      </p>
    </>
  );
}
