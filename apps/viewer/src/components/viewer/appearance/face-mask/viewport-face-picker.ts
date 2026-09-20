/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Intersection } from '@ifc-lite/renderer';
import type { TranslationKey } from '@/i18n';

export interface ViewportFacePickTarget {
  globalId: number;
  modelIndex: number;
  geometryItemIds: ReadonlySet<number>;
  triangleCount: number;
  canPick(): boolean;
  onToggle(triangle: number): void;
}

export type ViewportFacePickResult =
  | 'inactive'
  | 'miss'
  | 'different-surface'
  | 'ambiguous'
  | 'busy'
  | 'picked';

let active: ViewportFacePickTarget | null = null;

/** Register the face editor that owns the sticky main-viewport pick tool. */
export function registerViewportFacePicker(target: ViewportFacePickTarget): () => void {
  active = target;
  return () => { if (active === target) active = null; };
}

/** Route one exact renderer hit without mutating ordinary viewer selection. */
export function pickViewportAppearanceFace(hit: Intersection | null): ViewportFacePickResult {
  if (!active) return 'inactive';
  if (!active.canPick()) return 'busy';
  if (!hit) return 'miss';
  if (hit.expressId !== active.globalId || hit.modelIndex !== active.modelIndex) return 'different-surface';
  const triangle = hit.sourceTriangleIndex;
  if (hit.geometryItemId === undefined || !active.geometryItemIds.has(hit.geometryItemId)
    || triangle === undefined || triangle < 0 || triangle >= active.triangleCount) return 'ambiguous';
  active.onToggle(triangle);
  return 'picked';
}

export function viewportFacePickError(result: ViewportFacePickResult): TranslationKey | undefined {
  if (result === 'miss') return 'appearance.facePicker.error.miss';
  if (result === 'different-surface') return 'appearance.facePicker.error.differentSurface';
  if (result === 'ambiguous') return 'appearance.facePicker.error.ambiguous';
  if (result === 'busy') return 'appearance.facePicker.error.busy';
  return undefined;
}
