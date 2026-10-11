/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo } from 'react';
import { type IfcDataStore, type CurrentProjectUnitResult } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { currentProjectUnitContext } from '@/lib/units/current-project-unit-context';

/** Current unit context must not fall back to the source snapshot after refusal (#7353). */
export function useCurrentProjectUnits(store: IfcDataStore | null, view: MutablePropertyView | undefined): CurrentProjectUnitResult {
  const revision = view?.getMutationRevision();
  return useMemo(() => currentProjectUnitContext(store, view), [store, view, revision]);
}
