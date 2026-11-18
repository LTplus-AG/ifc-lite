/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { CachedSheetTransform } from './sheet-geometry-key';
interface Frame { drawing: Drawing2D | null; isPinned: boolean; cachedSheetTransformRef: { current: CachedSheetTransform | null } }
let latest: Frame | undefined;
export function publishDrawingExportFrame(frame: Frame) { latest = frame; }
/** The cache validates its own sheet/geometry key before reuse. Holding the last
 * rendered frame also preserves the native pinned placement when a panel closes. */
export function drawingExportFrame(drawing: Drawing2D): Frame | undefined {
  return latest?.drawing === drawing ? latest : undefined;
}
