/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Renderer selection destination shared by the palette and Elements ribbon (#8947). */
import { useViewerStore, type ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';

export function selectedEntityActionTarget(s: ViewerState = useViewerStore.getState()): number | null {
  const scalar = s.selectedEntityId;
  const id = s.selectedEntityIds.size > 0
    ? scalar !== null && s.selectedEntityIds.has(scalar) ? scalar : s.selectedEntityIds.values().next().value
    : scalar;
  if (id == null) return null;
  // Prefer the store-backed resolver, which includes overlay allocated ids.
  const ref = s.resolveGlobalIdFromModels(id) ?? resolveEntityRef(id);
  const store = ref.modelId === 'legacy' ? s.ifcDataStore : s.models.get(ref.modelId)?.ifcDataStore;
  const view = s.mutationViews.get(ref.modelId);
  if (!store || view?.isDeleted(ref.expressId)) return null;
  return view?.getNewEntity(ref.expressId) || store.entities.expressId.includes(ref.expressId) ? id : null;
}

export function openSelectedEntityActions(anchor?: { x: number; y: number }, launcher?: HTMLElement | null): void {
  const id = selectedEntityActionTarget();
  if (id === null) return;
  // Capture the real launcher through the existing menu focus-return lifecycle.
  if (launcher?.isConnected) launcher.focus();
  // Palette activation runs after its dialog closes. Anchor centrally so the
  // actual menu stays in the viewport, with Radix collision/focus handling.
  useViewerStore.getState().openContextMenu(id,
    anchor?.x ?? Math.max(1, window.innerWidth / 2),
    anchor?.y ?? Math.max(1, window.innerHeight / 3));
  requestAnimationFrame(() => {
    // Let the palette's close autofocus and Radix's mount finish first.
    const state = useViewerStore.getState();
    if (!state.contextMenu.isOpen || state.contextMenu.entityId !== id) return;
    document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]:not([data-disabled])')?.focus();
  });
}
