/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Drawing2DState } from '@/store/slices/drawing2DSlice';

/** Canonical metre depth contract shared by input, runtime updates and storage. */
export function isManualProjectionDepth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Ignore invalid depth updates while preserving unrelated display changes. */
export function validateDrawingDisplayOptions(options: Partial<Drawing2DState['drawing2DDisplayOptions']>) {
  const validated = { ...options };
  if (validated.constructionProjectionDepth !== null && !isManualProjectionDepth(validated.constructionProjectionDepth)) {
    delete validated.constructionProjectionDepth;
  }
  return validated;
}
