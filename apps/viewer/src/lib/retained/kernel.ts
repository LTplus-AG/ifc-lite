/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `@ifc-lite/viewer-retained` exports, whichever file the build maps it
 * to: `index.ts` (VITE_RETAINED_GEOMETRY=on) or `off.ts` (default viewer,
 * viewer-embed). Types only, so the default graph gains no code from it.
 */

import type { ComponentType } from 'react';
import type { GeometryKernelLoad } from '@/hooks/ingest/geometryEventSource';
import type { GeometryKernel } from '@/store/geometryKernel';

export interface RetainedKernel {
  /** The kernel the next load uses. */
  requested(): GeometryKernel;
  /** The retained kernel for this load (possibly already refused), or `null` for exact. */
  begin(file: File, target: { kind: 'primary' | 'federated' }, retry: () => void): GeometryKernelLoad | null;
  /** Viewport chip + Retained geometry panel; `reload` loads a file as the primary model. */
  Chip: ComponentType<{ reload: (file: File) => unknown }>;
  /** Settings → Performance: the geometry kernel choice. */
  KernelSetting: ComponentType;
}
