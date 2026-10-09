/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo } from 'react';
import { extractProjectUnits, ProjectUnits, readCurrentProjectUnits, type IfcDataStore, type CurrentProjectUnitResult } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** Current unit context must not fall back to the source snapshot after refusal (#7353). */
export function useCurrentProjectUnits(store: IfcDataStore | null, view: MutablePropertyView | undefined): CurrentProjectUnitResult {
  const revision = view?.getMutationRevision();
  return useMemo(() => {
    if (!store?.source.length) return { status: 'available', reason: null, value: ProjectUnits.empty() };
    return view ? readCurrentProjectUnits(store, view)
      : { status: 'available', reason: null, value: extractProjectUnits(store.source, store.entityIndex) };
  }, [store, view, revision]);
}
