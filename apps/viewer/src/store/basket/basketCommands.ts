/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from '../types.js';
import { useViewerStore } from '../index.js';
import { saveBasketViewWithThumbnailFromStore } from '../basketSave.js';
import {
  getSmartBasketInputFromStore,
  isBasketIsolationActiveFromStore,
} from '../basketVisibleSet.js';

type BasketViewSource = 'selection' | 'visible' | 'hierarchy' | 'manual';

/**
 * Resolve basket refs: smart input first, optional context entity as fallback.
 */
function getBasketRefs(contextEntityRef?: EntityRef | null): EntityRef[] {
  const { refs } = getSmartBasketInputFromStore();
  if (refs.length > 0) return refs;
  if (contextEntityRef) return [contextEntityRef];
  return [];
}

export function executeBasketSet(contextEntityRef?: EntityRef | null): void {
  const refs = getBasketRefs(contextEntityRef);
  if (refs.length > 0) {
    useViewerStore.getState().setBasket(refs);
  }
}

/**
 * Isolate: set basket from context if refs available, else re-show existing basket.
 */
export function executeBasketIsolate(contextEntityRef?: EntityRef | null): void {
  const refs = getBasketRefs(contextEntityRef);
  if (refs.length > 0) {
    useViewerStore.getState().setBasket(refs);
    return;
  }
  const state = useViewerStore.getState();
  if (state.pinboardEntities.size > 0) {
    state.showPinboard();
  }
}

export function executeBasketAdd(contextEntityRef?: EntityRef | null): void {
  const refs = getBasketRefs(contextEntityRef);
  if (refs.length > 0) {
    useViewerStore.getState().addToBasket(refs);
  }
}

export function executeBasketRemove(contextEntityRef?: EntityRef | null): void {
  const refs = getBasketRefs(contextEntityRef);
  if (refs.length > 0) {
    useViewerStore.getState().removeFromBasket(refs);
  }
}

export function executeBasketToggleVisibility(): void {
  const state = useViewerStore.getState();
  if (state.pinboardEntities.size === 0) return;
  if (isBasketIsolationActiveFromStore()) {
    state.clearIsolation();
  } else {
    state.showPinboard();
  }
}

export async function executeBasketSaveView(source: BasketViewSource = 'manual'): Promise<string | null> {
  const state = useViewerStore.getState();
  if (state.pinboardEntities.size === 0) return null;
  const id = await saveBasketViewWithThumbnailFromStore(source);
  // Dock the `presentation` bottom panel exclusively (#5508) — setting the
  // flag directly left it true ALONGSIDE another bottom panel's flag (e.g.
  // Script), and by the table's precedence rule (`activeBottomPanel`,
  // `lib/panels/bottom-panels.ts`) presentation sorts last, so the save
  // silently failed to surface the new view behind whichever panel was open.
  state.openPanelInHome('presentation', 'programmatic');
  return id;
}

export function executeBasketClear(): void {
  useViewerStore.getState().clearBasket();
}
