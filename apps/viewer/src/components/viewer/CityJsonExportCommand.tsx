/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense } from 'react';
import type { ExportSurface } from '@/lib/analytics-export-events';

const CityJsonExportDialog = lazy(() =>
  import('./CityJsonExportDialog').then((m) => ({ default: m.CityJsonExportDialog })),
);

export function CityJsonExportCommand(props: { surface: ExportSurface; trigger?: React.ReactNode }) {
  return <Suspense fallback={props.trigger ?? null}><CityJsonExportDialog {...props} /></Suspense>;
}
