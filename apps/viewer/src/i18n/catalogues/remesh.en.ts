/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Notices from re-meshing edited elements (#6232 WP1,
 * `lib/remesh/remesh-service.ts`). Each says why an edited element's 3D
 * shape was NOT rebuilt; the edit itself is always kept.
 */
export const remeshEn = {
  'remesh.refused.noSource': "This model's 3D shapes can't be rebuilt after edits: it was not loaded from an IFC file.",
  'remesh.refused.noFrame': "This model's 3D shapes can't be rebuilt after edits: it was loaded without the engine's coordinate frame. Reload it to enable updates.",
  'remesh.refused.colourMerged': "The edited element shares one mesh with other elements, so its 3D shape can't be rebuilt on its own. The edit is kept.",
  'remesh.refused.unreadable': "The edited element's data could not be read back, so its 3D shape was not rebuilt. The edit is kept.",
  'remesh.refused.alignment': "The edited element's model is aligned to another model's coordinate system, and the rebuilt shape could not be aligned the same way. The edit is kept.",
  'remesh.failed': "The edited element's 3D shape could not be rebuilt: {message}. The edit is kept.",
} as const satisfies Record<string, TranslationValue>;
