/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkspacePanelId } from './registry';
import type { ComponentType } from 'react';

export type PanelModule = { default: ComponentType<{ onClose?: () => void }> };
export type DeferredPanelLoader = (() => Promise<PanelModule>) & { peek?: () => PanelModule | undefined };

function cachedPanel(importModule: () => Promise<PanelModule>): DeferredPanelLoader {
  let loaded: PanelModule | undefined;
  let pending: Promise<PanelModule> | undefined;
  const load = () => pending ??= importModule().then(module => { loaded = module; return module; });
  // A tour preload or an earlier mount must not flash a loading shell on reopen.
  load.peek = () => loaded;
  return load;
}

// Shared cached factories: tours and every host observe the same ready module.
export const loadBcfPanel = cachedPanel(() => import('@/components/viewer/BCFPanel').then(module => ({ default: module.BCFPanel })));
export const loadValidationPanel = cachedPanel(() => import('@/components/viewer/validation/ValidationPanel').then(module => ({ default: module.ValidationPanel })));
export const loadLensPanel = cachedPanel(() => import('@/components/viewer/LensPanel').then(module => ({ default: module.LensPanel })));
export const loadGanttPanel = cachedPanel(() => import('@/components/viewer/schedule/GanttPanel').then(module => ({ default: module.GanttPanel })));
export const loadListPanel = cachedPanel(() => import('@/components/viewer/lists/ListPanel').then(module => ({ default: module.ListPanel })));
export const loadExtensionsPanel = cachedPanel(() => import('@/components/extensions/ExtensionsPanel').then(module => ({ default: module.ExtensionsPanel })));

export async function preloadDeferredPanel(id: WorkspacePanelId): Promise<void> {
  switch (id) {
    case 'bcf': await loadBcfPanel(); break;
    case 'validation': await loadValidationPanel(); break;
    case 'lens': await loadLensPanel(); break;
    case 'gantt': await loadGanttPanel(); break;
    case 'lists': await loadListPanel(); break;
    case 'extensions': await loadExtensionsPanel(); break;
  }
}
