/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The export registry's entry point for Rhino .3dm. The dialog, its fields and
 * options load in their own chunk, so the boot path carries only this shim
 * (docs/guide/performance.md, "Perf ratchet ceilings"). Until the chunk
 * arrives the caller's trigger renders as the fallback.
 */

import { lazy, Suspense } from 'react';
import type { ExportSurface } from '@/lib/analytics-export-events';

const RhinoExportDialog = lazy(() =>
  import('./RhinoExportDialog').then((m) => ({ default: m.RhinoExportDialog })),
);

export function RhinoExportCommand(props: { surface: ExportSurface; trigger?: React.ReactNode }) {
  return (
    <Suspense fallback={props.trigger ?? null}>
      <RhinoExportDialog {...props} />
    </Suspense>
  );
}
