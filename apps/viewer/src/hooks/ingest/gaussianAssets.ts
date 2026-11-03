/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type MutableRefObject } from 'react';
import type { GaussianSplatApi, GaussianSplatBounds, GaussianSplatHandle, Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type FederatedModel } from '@/store';
import { toast } from '@/components/ui/toast';
import { getGlobalRenderer } from '../useBCF.js';

/** `splats` issued `handle`; every call on the handle goes to that adapter alone. */
interface OwnedAsset { handle: GaussianSplatHandle; splats: GaussianSplatApi; visible?: boolean }

interface Registry {
  /** modelId -> the exact renderer-issued handle its model was published with. */
  owned: Map<string, OwnedAsset>;
  /** Models whose handle was issued by a renderer that has since been replaced. */
  replaced: Set<string>;
  subscribed: boolean;
}

/**
 * One registry per page, kept on `globalThis` like the viewer store, so a
 * re-evaluated module (HMR) or a remounted viewport reuses it and never
 * installs a second store subscription.
 */
const host = globalThis as { __ifc_lite_gaussian_assets__?: Registry };
const registry: Registry = host.__ifc_lite_gaussian_assets__ ??= { owned: new Map(), replaced: new Set(), subscribed: false };

/**
 * Publication hands a capture to its model; from then on the store alone
 * decides its lifetime (#8565). Every models change reconciles synchronously,
 * so removal, replacement, a primary reload and clear free the renderer asset
 * in the same tick, and model visibility/isolate mirror onto it.
 */
export function adoptGaussianAsset(modelId: string, handle: GaussianSplatHandle, splats: GaussianSplatApi): void {
  registry.owned.set(modelId, { handle, splats });
  registry.replaced.delete(modelId);
  if (!registry.subscribed) {
    registry.subscribed = true;
    useViewerStore.subscribe((state, previous) => {
      if (state.models !== previous.models) reconcileGaussianAssets(state.models);
    });
  }
  reconcileGaussianAssets(useViewerStore.getState().models);
}

export function reconcileGaussianAssets(models: ReadonlyMap<string, FederatedModel>): void {
  for (const modelId of registry.replaced) if (!models.has(modelId)) registry.replaced.delete(modelId);
  for (const [modelId, asset] of registry.owned) {
    const model = models.get(modelId);
    if (model?.gaussianSplat?.handle !== asset.handle) {
      registry.owned.delete(modelId);
      asset.splats.remove(asset.handle); // its own adapter: a no-op false once that renderer is gone
      continue;
    }
    if (asset.visible !== model.visible) {
      asset.visible = model.visible;
      asset.splats.setVisible(asset.handle, model.visible);
    }
  }
}

/**
 * A viewport's renderer became ready. Assets issued by any other renderer
 * (replaced or destroyed; it released its own allocations) can never be drawn
 * here, and their handles are never passed to this one: forget them, mark
 * their models for an explicit reload, and say so.
 */
export function rebindGaussianAssets(splats: GaussianSplatApi): void {
  const orphaned: string[] = [];
  for (const [modelId, asset] of registry.owned) {
    if (asset.splats === splats) continue;
    registry.owned.delete(modelId);
    registry.replaced.add(modelId);
    orphaned.push(useViewerStore.getState().models.get(modelId)?.name ?? modelId);
  }
  if (orphaned.length) toast.error(`The viewer renderer restarted. Reload from the model list: ${orphaned.join(', ')}.`);
}

/** Mounted with the viewport: a ready renderer adopts no handle another renderer issued. */
export function useGaussianRendererBinding(rendererRef: MutableRefObject<Renderer | null>, initialized: boolean): void {
  useEffect(() => {
    if (initialized && rendererRef.current) rebindGaussianAssets(rendererRef.current.gaussianSplats);
  }, [initialized, rendererRef]);
}

/** Renderer state for a published capture. A failed handle is terminal: its rows are released. */
export type GaussianCaptureState =
  | { state: 'resident' | 'pending' }
  | { state: 'failed'; reason: string }
  | { state: 'invalid'; reason?: 'renderer-replaced' };

/** Never resident on a renderer that did not issue the handle. */
/** The model's asset only while it belongs to the current renderer and still carries the model's handle. */
function currentAsset(model: FederatedModel) {
  const asset = registry.owned.get(model.id);
  const current = getGlobalRenderer()?.gaussianSplats;
  if (registry.replaced.has(model.id) || (asset && current && asset.splats !== current)) return 'renderer-replaced' as const;
  return asset && asset.handle === model.gaussianSplat?.handle ? asset : null;
}

export function gaussianModelState(model: FederatedModel): GaussianCaptureState {
  const asset = currentAsset(model);
  if (asset === 'renderer-replaced') return { state: 'invalid', reason: 'renderer-replaced' };
  if (!asset) return { state: 'invalid' };
  return asset.splats.getState(asset.handle);
}

/** A failed, replaced or vanished capture comes back only through a reload from its source. */
export function gaussianNeedsReload(state: GaussianCaptureState): boolean {
  return state.state === 'failed' || state.state === 'invalid';
}

/** Re-read while mounted: loss, recovery and renderer replacement change state without a store update. */
export function useGaussianCaptureState(model: FederatedModel): GaussianCaptureState {
  const [state, setState] = useState(() => gaussianModelState(model));
  useEffect(() => {
    const read = () => setState((previous) => {
      const next = gaussianModelState(model);
      const reason = (s: GaussianCaptureState) => ('reason' in s ? s.reason : undefined);
      return previous.state === next.state && reason(previous) === reason(next) ? previous : next;
    });
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [model]);
  return state;
}

/** Centre bounds of one capture, in the camera-fit frame. Framing only. */
export function gaussianModelBounds(model: FederatedModel): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  const asset = currentAsset(model);
  if (!asset || asset === 'renderer-replaced') return null; // never ask a replaced renderer's adapter
  return gaussianFitBox(asset.splats.getBounds(asset.handle));
}

/** The renderer's centre bounds as the viewer's camera-fit box. */
export function gaussianFitBox(bounds: GaussianSplatBounds | null) {
  if (!bounds) return null;
  const [x0, y0, z0] = bounds.min, [x1, y1, z1] = bounds.max;
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}
