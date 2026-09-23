/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens class discovery hook — INSTANT, zero loading impact.
 *
 * Only discovers IFC class names from the entity table (O(n) array scan,
 * no STEP buffer parsing). Property sets, quantities, materials, and
 * classifications are discovered lazily on-demand when the user opens
 * a dropdown that needs them — see `useLazyDiscovery` in LensPanel.
 */

import { useEffect } from 'react';
import { discoverClasses } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { createLensDataProvider } from '@/lib/lens';

/**
 * Discover IFC classes when models change (instant).
 * Stores result in `discoveredLensData.classes` on the lens slice.
 */
export function useLensDiscovery(): void {
  const modelCount = useViewerStore((s) => s.models.size);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const setDiscoveredLensData = useViewerStore((s) => s.setDiscoveredLensData);

  useEffect(() => {
    const { models, ifcDataStore: ds, mutationViews, resolveGlobalIdFromModels } = useViewerStore.getState();
    if (models.size === 0 && !ds) {
      setDiscoveredLensData(null);
      return;
    }

    // Instant: just reads type names from entity arrays, no STEP parsing
    const provider = createLensDataProvider(models, ds, mutationViews, resolveGlobalIdFromModels);
    const classes = discoverClasses(provider);
    setDiscoveredLensData({
      classes,
      propertySets: null,    // lazy — discovered on-demand
      quantitySets: null,    // lazy — discovered on-demand
      classificationSystems: null, // lazy — discovered on-demand
      materials: null,       // lazy — discovered on-demand
    });
  }, [modelCount, ifcDataStore, mutationVersion, setDiscoveredLensData]);
}
