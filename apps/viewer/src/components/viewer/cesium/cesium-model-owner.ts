/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { whenModelRenderable, type CesiumModelPrimitive, type RenderableCancellation } from './cesium-model-renderable';

export interface CesiumModelOwner extends CesiumModelPrimitive {
  addModel(model: CesiumModelPrimitive, castsShadows: boolean): void;
  whenRenderable(
    viewer: Parameters<typeof whenModelRenderable>[0],
    cancellation: RenderableCancellation,
  ): Promise<void>;
}

/**
 * One logical IFC model, owned by a native collection (#7562). Its children
 * differ only in shadow policy. Native collection disposal releases each child;
 * the parent scene owns the collection once the existing swap accepts it.
 * Cesium is injected so this module does not eagerly load the World engine.
 */
export function createCesiumModelOwner(
  Cesium: typeof import('cesium'),
  matrix: import('cesium').Matrix4,
): CesiumModelOwner {
  return new class extends Cesium.PrimitiveCollection {
    private currentMatrix = matrix;
    private currentShadows = Cesium.ShadowMode.DISABLED;
    private readonly models: Array<{ model: CesiumModelPrimitive; castsShadows: boolean }> = [];

    get modelMatrix(): import('cesium').Matrix4 { return this.currentMatrix; }
    set modelMatrix(value: import('cesium').Matrix4) {
      this.currentMatrix = value;
      for (const { model } of this.models) model.modelMatrix = value;
    }

    get shadows(): import('cesium').ShadowMode { return this.currentShadows; }
    set shadows(value: import('cesium').ShadowMode) {
      this.currentShadows = value;
      for (const part of this.models) this.applyShadows(part, value);
    }

    private applyShadows(
      part: { model: CesiumModelPrimitive; castsShadows: boolean },
      value: import('cesium').ShadowMode,
    ): void {
      part.model.shadows = part.castsShadows ? value
        : value === Cesium.ShadowMode.ENABLED ? Cesium.ShadowMode.RECEIVE_ONLY
        : value === Cesium.ShadowMode.CAST_ONLY ? Cesium.ShadowMode.DISABLED : value;
    }

    addModel(model: CesiumModelPrimitive, castsShadows: boolean): void {
      try { this.add(model); }
      catch (error) { model.destroy?.(); throw error; }
      const part = { model, castsShadows };
      this.models.push(part);
      model.modelMatrix = this.currentMatrix;
      this.applyShadows(part, this.currentShadows);
    }

    async whenRenderable(
      viewer: Parameters<typeof whenModelRenderable>[0],
      cancellation: RenderableCancellation,
    ): Promise<void> {
      let retired = cancellation.isRetired();
      const listeners = new Set<() => void>();
      const retire = () => { retired = true; for (const cb of listeners) cb(); };
      const off = cancellation.onRetire(retire);
      const combined: RenderableCancellation = {
        isRetired: () => retired,
        onRetire(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      };
      try {
        await Promise.all(this.models.map(({ model }) => whenModelRenderable(viewer, model, 5_000, combined)));
      } finally {
        // A failed child must not leave sibling readiness listeners/timers alive.
        retire();
        off();
      }
    }
  }();
}
