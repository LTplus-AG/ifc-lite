/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { hasRetainedGeometryModel, hasRetainedShapeOnlyModel, RETAINED_EXACT_ONLY_REASON, RETAINED_SHAPE_ONLY_REASON } from '@/store/retainedGeometry';
import type { ViewerState } from '@/store';
export const MESH_DERIVED_EXPORTS: ReadonlySet<string> = new Set(['glb', 'kmz', 'ion', 'usd', '3dm']);
export const EXACT_ONLY_EXPORTS: ReadonlySet<string> = new Set(['usd', '3dm', 'energy', 'ion']);
/** Same toolbar launch gate, also checked when automation runs without a menu. */
export function nativeExportBlockReason(format: string, state: ViewerState): string | null {
  if (MESH_DERIVED_EXPORTS.has(format) && hasRetainedShapeOnlyModel(state.models)) return RETAINED_SHAPE_ONLY_REASON;
  if (EXACT_ONLY_EXPORTS.has(format) && hasRetainedGeometryModel(state.models)) return RETAINED_EXACT_ONLY_REASON;
  return null;
}
