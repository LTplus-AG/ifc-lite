/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer exports that rebuild geometry from the model's FILE (GLB from source bytes, USD, the energy models) run
 * the exact engine. For a model the viewer holds from the retained kernel (#7955) that is a different geometry
 * from the one on screen: it would include products the retained kernel refused and omit nothing it published,
 * under a UI that says "retained". Such an export either takes the meshes the viewer holds or refuses. This is
 * the one place that says which models that applies to.
 *
 * A data predicate only (`retainedGeometry` is set by the retained load and is never set in a default build), so
 * the default viewer graph carries no retained code.
 */

import type { RetainedGeometrySummary } from '@/store/retainedGeometry';

export function isRetainedKernelModel(model: { retainedGeometry?: RetainedGeometrySummary } | null | undefined): boolean {
  return Boolean(model?.retainedGeometry);
}
