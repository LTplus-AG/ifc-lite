/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lazy mount of the Georeference panel's diagnosis (#10608): the checker, the
 * CRS engine and the EPSG extents load with it, never with the entry chunk.
 * Its own module because `GeoreferencingPanel.tsx` is at its size budget.
 */

import { lazy, Suspense } from 'react';
import type { GeorefDiagnosisSectionProps } from './georef-diagnosis-section';

const GeorefDiagnosisSection = lazy(() => import('./georef-diagnosis-section'));

export function GeorefDiagnosis(props: GeorefDiagnosisSectionProps) {
  return (
    <Suspense fallback={null}>
      <GeorefDiagnosisSection {...props} />
    </Suspense>
  );
}
