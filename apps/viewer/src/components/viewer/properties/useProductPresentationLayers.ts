/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { PresentationLayer } from '@/lib/presentation-layers';

/** Load code and resolve membership after render, without the global tree builder. */
export function useProductPresentationLayers(store: IfcDataStore | null | undefined, view: MutablePropertyView | undefined,
  productId: number, mutationVersion: number): readonly PresentationLayer[] | undefined {
  const revision = view?.getMutationRevision();
  const [result, setResult] = useState<{ store: typeof store; view: typeof view; revision: typeof revision;
    productId: number; layers: readonly PresentationLayer[] | undefined }>();
  useEffect(() => {
    if (!store) return;
    let active = true;
    void import('@/lib/presentation-layer-selection').then(module => {
      if (!active) return;
      const layers = module.presentationLayersByProduct(store, view).get(productId);
      setResult({ store, view, revision, productId, layers });
    }).catch((error: unknown) => { console.error('Failed to resolve presentation layer membership', error); });
    return () => { active = false; };
  }, [store, view, revision, productId, mutationVersion]);
  return result?.store === store && result?.view === view && result?.revision === revision && result?.productId === productId
    ? result?.layers : undefined;
}
