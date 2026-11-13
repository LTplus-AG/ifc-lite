/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TagAnnotation2D } from '@/store/slices/drawing2DSlice';

/** Older drawings have no tags; malformed bindings must never cross model boundaries. */
export function validElementTags(value: unknown): TagAnnotation2D[] {
  if (!Array.isArray(value)) return [];
  const point = (v: unknown) => v !== null && typeof v === 'object' && 'x' in v && 'y' in v
    && typeof v.x === 'number' && Number.isFinite(v.x) && typeof v.y === 'number' && Number.isFinite(v.y);
  return value.filter((v): v is TagAnnotation2D => v !== null && typeof v === 'object'
    && typeof v.id === 'string' && v.id.length > 0 && typeof v.modelId === 'string' && v.modelId.length > 0
    && Number.isSafeInteger(v.entityId) && v.entityId > 0 && point(v.anchor) && point(v.offset) && v.template === 'auto');
}

/** Runtime model ids change on reload; only the saved drawing owner is rebound. */
export function restoreElementTags(tags: readonly TagAnnotation2D[] | undefined, owner: string | undefined, active: string): TagAnnotation2D[] {
  return (tags ?? []).map(tag => tag.modelId === owner ? { ...tag, modelId: active } : tag);
}
