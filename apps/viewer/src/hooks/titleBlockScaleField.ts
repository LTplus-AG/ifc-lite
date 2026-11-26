/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { formatScaleFactorLabel, type TitleBlockConfig } from '@ifc-lite/drawing-2d';

/**
 * Make the exported title block's "Scale" text state the scale the drawing
 * was actually placed at.
 *
 * The field is plain static content: it was written once, by
 * `sheetSlice.ts`'s `autoPopulateTitleBlock`, from the REQUESTED
 * `sheet.scale.factor`. A restored sheet, saved template or agent
 * `drawing.replaceSheet` can carry text that disagrees with it (#11458);
 * this corrects it while the field still auto-populates from `drawing.scale`.
 * And `calculateDrawingTransform`'s
 * `fitScale = min(scaleX, scaleY, 1)` (`sheet-types.ts`) can shrink the
 * drawing below that requested scale to fit the sheet's fixed viewport, and
 * when it does, `effectiveScaleFactor` (already fed to the scale BAR as
 * `TitleBlockExtras.effectiveScaleFactor` in `useDrawingExport.ts`) is the
 * actual mm-per-metre the drawing was placed at. Left uncorrected, the field
 * would keep printing the requested ratio next to a bar and a drawing
 * rendered at a materially different one — a silently wrong deliverable, the
 * same defect class PR #2131 fixed for the plain (non-sheet) SVG exporter's
 * title block.
 *
 * A field that auto-populates from `drawing.scale` always gets the placed
 * scale; a field merely named 'scale' (auto-populate off, user text) is only
 * corrected when the fit clamped the drawing. Returns `titleBlock` itself when
 * no field needs a new value, and a shallow copy with only those fields'
 * `value` replaced otherwise. The on-screen preview still reads the stored
 * text; this applies to export only.
 */
export function titleBlockWithEffectiveScale(
  titleBlock: TitleBlockConfig,
  requestedScaleFactor: number,
  effectiveScaleFactor: number
): TitleBlockConfig {
  const nominalScaleFactor = 1000 / requestedScaleFactor;
  const clamped = Math.abs(effectiveScaleFactor - nominalScaleFactor) > 1e-9;
  const label = `1:${formatScaleFactorLabel(1000 / effectiveScaleFactor)}`;
  // Auto-populate off means user text: like `autoPopulateTitleBlock` (`sheetSlice.ts`) it is kept,
  // except that a field with the id 'scale' is still corrected when the fit clamped the drawing (#2131).
  const needsValue = (field: TitleBlockConfig['fields'][number]): boolean => field.value !== label
    && ((field.autoPopulate && field.autoPopulateSource === 'drawing.scale') || (clamped && field.id === 'scale'));
  if (!titleBlock.fields.some(needsValue)) return titleBlock;
  return {
    ...titleBlock,
    fields: titleBlock.fields.map((field) => (needsValue(field) ? { ...field, value: label } : field)),
  };
}
