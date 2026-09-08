/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { formatScaleFactorLabel, type TitleBlockConfig } from '@ifc-lite/drawing-2d';

/**
 * Correct the title block's "Scale" text field for a fit-clamped sheet.
 *
 * The field is plain static content: it was written once, by
 * `sheetSlice.ts`'s `autoPopulateTitleBlock`, from the REQUESTED
 * `sheet.scale.factor`. `calculateDrawingTransform`'s
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
 * Returns `titleBlock` unchanged when the drawing was not clamped (the
 * common path incurs no allocation and never regresses a user-edited field
 * on the un-clamped path), and a shallow copy with only the 'scale' field's
 * `value` replaced otherwise.
 */
export function titleBlockWithEffectiveScale(
  titleBlock: TitleBlockConfig,
  requestedScaleFactor: number,
  effectiveScaleFactor: number
): TitleBlockConfig {
  const nominalScaleFactor = 1000 / requestedScaleFactor;
  if (Math.abs(effectiveScaleFactor - nominalScaleFactor) <= 1e-9) {
    return titleBlock;
  }
  return {
    ...titleBlock,
    fields: titleBlock.fields.map((field) =>
      field.id === 'scale'
        ? { ...field, value: `1:${formatScaleFactorLabel(1000 / effectiveScaleFactor)}` }
        : field
    ),
  };
}
