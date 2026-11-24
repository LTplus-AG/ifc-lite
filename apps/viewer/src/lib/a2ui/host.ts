/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer side of an A2UI surface: everything a catalog component or
 * renderer function may read from, or do to, the loaded models. One interface,
 * implemented once over the SDK's `BimContext`, so components never reach into
 * the store and tests can drive the real backend.
 *
 * Refs are always model-aware (`{ modelId, expressId }`): express ids repeat
 * across federated models, so nothing here takes a bare number.
 */

import type { BimContext, EntityData, MaterialData, PropertySetData, QuantitySetData } from '@ifc-lite/sdk';
import { encodeRef, type WireEntityRef } from '@ifc-lite/a2ui';

export interface A2uiEntity {
  ref: WireEntityRef;
  /** `"modelId:expressId"`, the wire form. */
  key: string;
  globalId: string;
  name: string;
  /** IFC class, `IfcPascalCase`. */
  type: string;
  description: string;
  objectType: string;
}

export interface ColorBatch {
  refs: WireEntityRef[];
  color: string;
}

export interface A2uiViewerHost {
  /** Ids of the models loaded right now. */
  loadedModelIds(): string[];
  modelName(modelId: string): string | undefined;
  /** Candidate entities by class (descendants included) across every loaded model, or one. */
  candidates(types: readonly string[] | undefined, modelId: string | undefined): A2uiEntity[];
  entity(ref: WireEntityRef): A2uiEntity | null;
  properties(ref: WireEntityRef): PropertySetData[];
  quantities(ref: WireEntityRef): QuantitySetData[];
  /** IFC attributes by EXPRESS name. Re-parses the source, so callers cache. */
  attributes(ref: WireEntityRef): Array<{ name: string; value: string | number | boolean }>;
  materials(ref: WireEntityRef): MaterialData | null;
  storeyName(ref: WireEntityRef): string | undefined;
  classifications(ref: WireEntityRef): Array<{ system?: string; identification?: string; name?: string }>;
  spatialPath(ref: WireEntityRef): A2uiEntity[];
  select(refs: WireEntityRef[]): void;
  isolate(refs: WireEntityRef[]): void;
  hide(refs: WireEntityRef[]): void;
  show(refs: WireEntityRef[]): void;
  colorize(batches: ColorBatch[]): void;
  flyTo(refs: WireEntityRef[]): void;
  /** Show everything and clear colour overrides. */
  resetView(): void;
  getSelection(): WireEntityRef[];
}

export function toEntity(data: EntityData): A2uiEntity {
  return {
    ref: { modelId: data.ref.modelId, expressId: data.ref.expressId },
    key: encodeRef(data.ref),
    globalId: data.globalId,
    name: data.name,
    type: data.type,
    description: data.description,
    objectType: data.objectType,
  };
}

/** The production host: the SDK's `BimContext`, i.e. the viewer's `LocalBackend`. */
export function createBimViewerHost(bim: BimContext): A2uiViewerHost {
  const loaded = (refs: WireEntityRef[]): WireEntityRef[] => {
    const ids = new Set(bim.model.list().map((m) => m.id));
    return refs.filter((r) => ids.has(r.modelId));
  };
  return {
    loadedModelIds: () => bim.model.list().map((m) => m.id),
    modelName: (modelId) => bim.model.get(modelId)?.name,
    candidates(types, modelId) {
      const q = bim.query();
      if (modelId) q.model(modelId);
      if (types?.length) q.byType(...types);
      return q.toArray().map(toEntity);
    },
    entity(ref) {
      const data = bim.entity(ref);
      return data ? toEntity(data) : null;
    },
    properties: (ref) => bim.properties(ref),
    quantities: (ref) => bim.quantities(ref),
    attributes: (ref) => bim.attributes(ref),
    materials: (ref) => bim.materials(ref),
    storeyName: (ref) => bim.storey(ref)?.name || undefined,
    classifications: (ref) => bim.classifications(ref),
    spatialPath: (ref) => bim.path(ref).map(toEntity),
    select: (refs) => bim.viewer.select(loaded(refs)),
    isolate: (refs) => bim.viewer.isolate(loaded(refs)),
    hide: (refs) => bim.viewer.hide(loaded(refs)),
    show: (refs) => bim.viewer.show(loaded(refs)),
    colorize(batches) {
      bim.viewer.colorizeAll(batches.map((b) => ({ refs: loaded(b.refs), color: b.color })).filter((b) => b.refs.length > 0));
    },
    flyTo: (refs) => bim.viewer.flyTo(loaded(refs)),
    resetView() {
      bim.viewer.resetVisibility();
      bim.viewer.resetColors();
    },
    getSelection: () => bim.viewer.getSelection().map((r) => ({ modelId: r.modelId, expressId: r.expressId })),
  };
}
