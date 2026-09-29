/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The isolation allowlist the 3D viewport draws with: storey selection (Solo)
 * ∩ class filter ∩ manual isolation (`computeVisibilityIsolation`), memoised.
 *
 * The mutation revision is a dependency on purpose. An element drawn this
 * session joins its storey by an IN-PLACE edit of the loaded spatial tree
 * (`registerAuthoredElement`), so neither `models` nor any other input changes
 * identity, and a memo keyed on those alone kept the storey set from before the
 * draw: with Solo on, a newly drawn wall was left out of the isolation and
 * disappeared from 3D the moment it was committed (#6232 ledger defect).
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { computeVisibilityIsolation } from '@/lib/visibility/effective-empty';

export function useVisibilityIsolation(): Set<number> | null {
  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const resolveGlobalIdFromModels = useViewerStore((s) => s.resolveGlobalIdFromModels);
  // Only while a storey is isolated does an edit move the result.
  const storeyRevision = useViewerStore((s) => (s.selectedStoreys.size > 0 ? s.mutationVersion : 0));
  return useMemo(() => {
    void storeyRevision;
    return computeVisibilityIsolation({
      models, ifcDataStore, selectedStoreys, isolatedEntities, classFilter, resolveGlobalIdFromModels,
    });
  }, [models, ifcDataStore, selectedStoreys, isolatedEntities, classFilter, resolveGlobalIdFromModels, storeyRevision]);
}
