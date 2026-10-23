/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The export registry's entry point for LandXML (terrain) (#7600). The dialog,
 * its preflight and the exporter glue load in their own chunk, so the boot
 * path carries only this shim (docs/guide/performance.md, "Perf ratchet
 * ceilings": a dialog belongs behind a dynamic `import()`). Until the chunk
 * arrives the caller's trigger renders as the fallback, so every toolbar
 * still shows the command from first paint.
 */

import { lazy, Suspense } from 'react';
import type { ExportSurface } from '@/lib/analytics-export-events';

const LandXmlTerrainExportDialog = lazy(() =>
  import('./LandXmlTerrainExportDialog').then((m) => ({ default: m.LandXmlTerrainExportDialog })),
);

export function LandXmlTerrainExportCommand(props: { surface: ExportSurface; trigger?: React.ReactNode }) {
  return (
    <Suspense fallback={props.trigger ?? null}>
      <LandXmlTerrainExportDialog {...props} />
    </Suspense>
  );
}
