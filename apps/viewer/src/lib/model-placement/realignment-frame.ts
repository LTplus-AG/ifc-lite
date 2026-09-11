/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore, type FederatedModel } from '@/store';
import type { ModelGeoref } from '@/hooks/ingest/federationAlign';
import { georeferencedPlacementFrameKey } from './persistence';

/** Re-alignment may replace model records while retaining their source/store
 * and geometry. A cleared, replaced or expanded federation is a different job. */
export function commitRealignmentFrame(
  models: ReadonlyMap<string, FederatedModel>, georef: ModelGeoref,
): boolean {
  const current = useViewerStore.getState();
  if (current.models.size !== models.size || [...models].some(([id, model]) => {
    const live = current.models.get(id);
    return !live || live.geometryResult !== model.geometryResult || live.ifcDataStore !== model.ifcDataStore ||
      live.sourceFile !== model.sourceFile || live.sourceFingerprint !== model.sourceFingerprint;
  })) return false;
  useViewerStore.setState({ modelPlacement: { ...current.modelPlacement,
    frameKey: georeferencedPlacementFrameKey(georef),
    revision: current.modelPlacement.revision + 1 } });
  return true;
}
