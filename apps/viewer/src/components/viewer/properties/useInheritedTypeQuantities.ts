/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo } from 'react';
import { RelationshipType } from '@ifc-lite/data';
import { extractTypeQuantitiesOnDemand, readCurrentTypeQuantities, type IfcDataStore, type CurrentTypeQuantityResult } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { withInheritedTypeQuantities } from '@/lib/zones/inherited-quantities';
import type { QuantitySet } from './encodingUtils';

/** Occurrence-first quantities and explicit current native type coverage (#7353). */
export function useInheritedTypeQuantities(own: QuantitySet[], store: IfcDataStore | null,
  expressId: number | undefined, view: MutablePropertyView | null | undefined) {
  const revision = view?.getMutationRevision();
  return useMemo(() => {
    const current = store?.source.byteLength && view && expressId !== undefined
      ? readCurrentTypeQuantities(store, expressId, view) : null;
    const quantities = withInheritedTypeQuantities(own, store, expressId, RelationshipType.DefinesByType,
      (source, id) => (current ? current.value?.quantities
        : extractTypeQuantitiesOnDemand(source as IfcDataStore, id)?.quantities) as QuantitySet[] | undefined);
    const status: CurrentTypeQuantityResult['status'] = current?.status ?? 'available';
    return { quantities, status, reason: current?.reason ?? null };
  }, [own, store, expressId, view, revision]);
}
