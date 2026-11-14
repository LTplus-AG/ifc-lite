/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical blank/recovery routes; no second loader (#8947). */
import { FilePlus, RotateCcw, X, CircleX } from 'lucide-react';
import type { SurfaceCommandDefinition } from './surface-command-types';

export const LOAD_SURFACE_COMMANDS = [
  {
    id: 'file:new-blank', labelKey: 'commandPalette.file.newBlank.label',
    keywords: 'new blank empty model create wall', keywordsKey: 'commandPalette.file.newBlank.keywords',
    category: 'File', icon: FilePlus, surfaces: ['palette'], enabled: s => s.canEditInSession,
    run: c => { c.startBlank?.(); },
  },
  {
    id: 'file:cancel-load', labelKey: 'commandPalette.file.cancelLoad.label',
    keywords: 'cancel stop abort loading model', keywordsKey: 'commandPalette.file.cancelLoad.keywords',
    category: 'File', icon: CircleX, surfaces: ['palette'], enabled: () => true,
    run: c => { c.loadRecovery?.cancel(); },
  },
  {
    id: 'file:retry-load', labelKey: 'commandPalette.file.retryLoad.label',
    keywords: 'retry reload failed error model', keywordsKey: 'commandPalette.file.retryLoad.keywords',
    category: 'File', icon: RotateCcw, surfaces: ['palette'], enabled: () => true,
    run: c => { c.loadRecovery?.retry(); },
  },
  {
    id: 'file:dismiss-load-error', labelKey: 'commandPalette.file.dismissLoadError.label',
    keywords: 'dismiss close clear load error', keywordsKey: 'commandPalette.file.dismissLoadError.keywords',
    category: 'File', icon: X, surfaces: ['palette'], enabled: () => true,
    run: c => { c.loadRecovery?.dismiss(); },
  },
] as const satisfies readonly SurfaceCommandDefinition[];
