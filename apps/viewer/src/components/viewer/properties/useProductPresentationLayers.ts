/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { PresentationLayer } from '@/lib/presentation-layers';

export type PresentationLayerLoader = () => Promise<Pick<typeof import('@/lib/presentation-layer-selection'), 'presentationLayersByProduct'>>;
const loadLookup: PresentationLayerLoader = () => import('@/lib/presentation-layer-selection');

/** Load code and resolve membership after render, without the global tree builder. */
export function useProductPresentationLayers(store: IfcDataStore | null | undefined, view: MutablePropertyView | undefined,
  productId: number, mutationVersion: number, load: PresentationLayerLoader = loadLookup) {
  const revision = view?.getMutationRevision();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ store: typeof store; view: typeof view; revision: typeof revision;
    productId: number; attempt: number; layers?: readonly PresentationLayer[]; error?: Error }>();
  useEffect(() => {
    if (!store) return;
    let active = true;
    void load().then(module => {
      if (!active) return;
      const layers = module.presentationLayersByProduct(store, view).get(productId);
      setResult({ store, view, revision, productId, attempt, layers });
    }).catch((error: unknown) => {
      if (active) setResult({ store, view, revision, productId, attempt,
        error: error instanceof Error ? error : new Error(String(error)) });
    });
    return () => { active = false; };
  }, [store, view, revision, productId, mutationVersion, attempt, load]);
  const current = result?.store === store && result?.view === view && result?.revision === revision
    && result?.productId === productId && result?.attempt === attempt ? result : undefined;
  return { layers: current?.layers, error: current?.error ?? null,
    retry: () => setAttempt(value => value + 1) };
}
