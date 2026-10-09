/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from './index.js';
import { getGlobalRenderer } from '../hooks/useBCF.js';
import { captureViewportFrame } from '@/lib/viewport-capture';

type BasketViewSource = 'selection' | 'visible' | 'hierarchy' | 'manual';

interface SelectionSnapshot {
  selectedEntityId: number | null;
  selectedEntityIds: Set<number>;
  selectedEntity: ReturnType<typeof useViewerStore.getState>['selectedEntity'];
  selectedEntitiesSet: Set<string>;
  selectedEntities: ReturnType<typeof useViewerStore.getState>['selectedEntities'];
  selectedModelId: string | null;
  chartOwned: boolean;
  selectionRevision: number;
}

function hasSelection(snapshot: SelectionSnapshot): boolean {
  return (
    snapshot.selectedEntityId !== null ||
    snapshot.selectedEntityIds.size > 0 ||
    snapshot.selectedEntity !== null ||
    snapshot.selectedEntitiesSet.size > 0 ||
    snapshot.selectedEntities.length > 0
  );
}

function snapshotSelectionState(): SelectionSnapshot {
  const state = useViewerStore.getState();
  return {
    selectedEntityId: state.selectedEntityId,
    selectedEntityIds: new Set(state.selectedEntityIds),
    selectedEntity: state.selectedEntity ? { ...state.selectedEntity } : null,
    selectedEntitiesSet: new Set(state.selectedEntitiesSet),
    selectedEntities: state.selectedEntities.map((ref) => ({ ...ref })),
    selectedModelId: state.selectedModelId,
    chartOwned: state.chartSelectionRevision != null
      && state.chartSelectionRevision === state.selectionRevision,
    selectionRevision: state.selectionRevision,
  };
}

function restoreSelectionState(snapshot: SelectionSnapshot): void {
  useViewerStore.setState({
    selectedEntityId: snapshot.selectedEntityId,
    selectedEntityIds: new Set(snapshot.selectedEntityIds),
    selectedEntity: snapshot.selectedEntity ? { ...snapshot.selectedEntity } : null,
    selectedEntitiesSet: new Set(snapshot.selectedEntitiesSet),
    selectedEntities: snapshot.selectedEntities.map((ref) => ({ ...ref })),
    selectedModelId: snapshot.selectedModelId,
    selectionRevision: snapshot.selectionRevision,
    ...(snapshot.chartOwned
      ? { chartSelectionRevision: snapshot.selectionRevision }
      : {}),
  });
}

/** Hide the outline for capture without publishing a new selection write. */
function temporarilyClearSelectionState(): void {
  useViewerStore.setState({
    selectedEntity: null,
    selectedEntitiesSet: new Set(),
    selectedEntities: [],
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    selectedModelId: null,
  });
}

async function captureCanvasThumbnail(): Promise<string | null> {
  const src = document.querySelector('canvas[data-viewport="main"]') as HTMLCanvasElement | null;
  if (!src) return null;

  const renderer = getGlobalRenderer();
  if (!renderer) return null;

  try {
    // Capture from the WebGPU canvas first (reliable), then downscale.
    const captured = await captureViewportFrame(renderer, { canvas: src,
      options: { selectedId: null, selectedIds: undefined, selectedModelIndex: undefined, hoverOutline: null },
      read: canvas => ({ image: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }),
    });
    if (!captured) return null;
    const fullFrameDataUrl = captured.image;

    const thumb = document.createElement('canvas');
    thumb.width = 320;
    thumb.height = 180;
    const ctx = thumb.getContext('2d');
    if (!ctx) return fullFrameDataUrl;

    // Preserve viewport aspect ratio while filling thumbnail bounds (crop, no stretch).
    ctx.fillStyle = '#0f0f12';
    ctx.fillRect(0, 0, thumb.width, thumb.height);

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to decode snapshot image'));
      img.src = fullFrameDataUrl;
    });

    const srcW = img.naturalWidth || captured.width;
    const srcH = img.naturalHeight || captured.height;
    if (srcW <= 0 || srcH <= 0) return null;

    const scale = Math.max(thumb.width / srcW, thumb.height / srcH);
    const drawW = Math.round(srcW * scale);
    const drawH = Math.round(srcH * scale);
    const offsetX = Math.floor((thumb.width - drawW) / 2);
    const offsetY = Math.floor((thumb.height - drawH) / 2);
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
    return thumb.toDataURL('image/jpeg', 0.75);
  } catch (error) {
    console.warn('[basket] Thumbnail capture failed:', error);
    return null;
  }
}

export async function saveBasketViewWithThumbnailFromStore(
  source: BasketViewSource = 'manual',
): Promise<string | null> {
  const before = snapshotSelectionState();
  const hadSelection = hasSelection(before);
  let clearedSelectionRevision: number | null = null;

  if (hadSelection) {
    temporarilyClearSelectionState();
    clearedSelectionRevision = useViewerStore.getState().selectionRevision;
  }

  try {
    const thumbnailDataUrl = await captureCanvasThumbnail();
    return useViewerStore.getState().saveCurrentBasketView({ source, thumbnailDataUrl });
  } finally {
    if (hadSelection && useViewerStore.getState().selectionRevision === clearedSelectionRevision) {
      restoreSelectionState(before);
    }
  }
}
