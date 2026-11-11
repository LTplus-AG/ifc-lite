/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkspacePanelId } from './registry';

// Shared factories: tours can await the same modules React.lazy will mount.
export const loadBcfPanel = () => import('@/components/viewer/BCFPanel').then(module => ({ default: module.BCFPanel }));
export const loadValidationPanel = () => import('@/components/viewer/validation/ValidationPanel').then(module => ({ default: module.ValidationPanel }));
export const loadLensPanel = () => import('@/components/viewer/LensPanel').then(module => ({ default: module.LensPanel }));

export async function preloadDeferredPanel(id: WorkspacePanelId): Promise<void> {
  switch (id) {
    case 'bcf': await loadBcfPanel(); break;
    case 'validation': await loadValidationPanel(); break;
    case 'lens': await loadLensPanel(); break;
  }
}
