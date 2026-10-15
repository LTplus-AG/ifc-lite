/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CLI host adapters over the SDK's shared headless implementation. */
import type { BimBackend, BimEventType, EntityRef, SpacesBackendMethods, StoreBackendMethods } from '@ifc-lite/sdk';
import { resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import { HeadlessBackend as SharedHeadlessBackend, createQueryAdapter } from '@ifc-lite/sdk/headless';
import type { IfcDataStore } from '@ifc-lite/parser';
import { expandTypes, isQueryableObjectType } from '@ifc-lite/parser';
import { normalizeBooleanValue } from '@ifc-lite/query';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { TableAccess } from '@ifc-lite/flow-nodes';
import { addDoorToStore, addWindowToStore, resolveSpatialAnchor, generateSpaces, listStoreys,
  type DoorInStoreParams, type WindowInStoreParams, type GenerateSpacesAllOptions } from '@ifc-lite/create';
import { createStoreAuthoring } from './headless-backend-store-authoring.js';
import { createStructuralAdapter } from './headless-backend-structural.js';
import { createScheduleAdapter } from './headless-backend-schedule.js';
import { exportHbjson, exportDfjson } from './energy-export.js';

export { expandTypes, normalizeBooleanValue };
export const isProductType = isQueryableObjectType;
const MODEL_ID = 'default';

export function normalizePropertyValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    // Cyclic structures or BigInt values that JSON.stringify can't handle —
    // log so the CLI surface is debuggable and fall back to String coercion.
    // eslint-disable-next-line no-console
    console.warn('[headless-backend] normalizePropertyValue: JSON.stringify failed', err);
    return String(value);
  }
}

export class HeadlessBackend implements BimBackend {
  readonly model: BimBackend['model'];
  readonly query: BimBackend['query'];
  readonly selection: BimBackend['selection'];
  readonly mutate: BimBackend['mutate'];
  readonly style: BimBackend['style'];
  readonly spatial: BimBackend['spatial'];
  readonly export: BimBackend['export'];
  readonly lens: BimBackend['lens'];
  readonly files: BimBackend['files'];
  readonly schedule: BimBackend['schedule'];
  readonly structural: BimBackend['structural'];
  readonly cost: BimBackend['cost'];
  readonly store: StoreBackendMethods;
  readonly spaces: SpacesBackendMethods;
  viewer: BimBackend['viewer'];
  visibility: BimBackend['visibility'];
  private readonly shared: SharedHeadlessBackend;

  constructor(private readonly dataStore: IfcDataStore, modelName: string) {
    this.shared = new SharedHeadlessBackend(dataStore, modelName, MODEL_ID, {}, modelName === MODEL_ID ? [] : [modelName]);
    this.model = this.shared.model;
    this.selection = this.shared.selection;
    this.mutate = this.shared.mutate;
    this.style = this.shared.style;
    this.spatial = this.shared.spatial;
    this.lens = this.shared.lens;
    this.files = this.shared.files;
    this.cost = this.shared.cost;
    this.viewer = this.shared.viewer;
    this.visibility = this.shared.visibility;
    this.query = createQueryAdapter(dataStore, MODEL_ID, () => this.shared.pendingOverlay(), () => this.getMutationView(), {
      paginationError: TypeError,
      normalizeTypePropertyValue: normalizePropertyValue,
    });
    this.store = this.createStoreAdapter();
    this.schedule = createScheduleAdapter(dataStore, id => this.assertKnownModelId(id));
    this.structural = createStructuralAdapter(dataStore, id => this.assertKnownModelId(id));
    this.spaces = this.createSpacesAdapter();
    // Explicit display names retain dots; only the filename-derived fallback loses its IFC suffix.
    const fallbackName = modelName.replace(/\.(ifc|ifcx|ifczip)$/i, '');
    this.export = {
      ...this.shared.export,
      hbjson: name => exportHbjson(dataStore, this.mutationView, name ?? fallbackName),
      dfjson: name => exportDfjson(dataStore, this.mutationView, name ?? fallbackName),
    };
  }

  private get mutationView(): MutablePropertyView | null { return this.shared.getMutationView(); }
  getMutationView(): MutablePropertyView | null { return this.shared.getMutationView(); }
  private getOrCreateMutationView(): MutablePropertyView { return this.shared.getOrCreateMutationView(); }
  private getOrCreateStoreEditor(): StoreEditor { return this.shared.ensureEditor(); }
  private assertKnownModelId(modelId: string): void { this.shared.assertKnownModelId(modelId); }

  tableAccess(modelId?: string): TableAccess {
    if (modelId) this.assertKnownModelId(modelId);
    return { entities: this.dataStore.entities, mutationView: this.getOrCreateMutationView(), strings: this.dataStore.strings ?? null };
  }

  subscribe(event: BimEventType, handler: (data: unknown) => void): () => void {
    return this.shared.subscribe(event, handler);
  }

  attachStreamingAdapters(viewer: BimBackend['viewer'], visibility: BimBackend['visibility']): void {
    this.shared.attachStreamingAdapters(viewer, visibility);
    this.viewer = viewer;
    this.visibility = visibility;
  }

  private createSpacesAdapter(): SpacesBackendMethods {
    return {
      // The session's edited model (#5249): deleted walls/storeys out, spaces
      // and storeys created earlier in the session in.
      listStoreys: () => listStoreys(this.dataStore, this.mutationView ?? undefined),
      // Spaces are written via the shared StoreEditor/MutablePropertyView, so
      // they're picked up by this backend's export adapter (StepExporter).
      generate: (options?: GenerateSpacesAllOptions) => {
        const editor = this.getOrCreateStoreEditor();
        return generateSpaces(editor, this.dataStore, options, editor.getMutationView());
      },
    };
  }

  private createStoreAdapter(): StoreBackendMethods {
    const get = () => this.getOrCreateStoreEditor();
    const dataStore = () => this.dataStore;
    const mutationView = () => this.getOrCreateMutationView();
    // Every `add*` mints an `EntityRef` carrying the model id it was called
    // with, and `bim.mutate.*` refuses one this backend does not answer for.
    // Checking here, before the entity exists, is what keeps the two from
    // disagreeing: no ref is handed back that the next call rejects.
    const assertModel = (modelId: string) => this.assertKnownModelId(modelId);
    return {
      addEntity(modelId: string, def: { type: string; attributes: unknown[] }): EntityRef {
        assertModel(modelId);
        const ref = get().addEntity(def.type, def.attributes as Parameters<StoreEditor['addEntity']>[1]);
        return { modelId, expressId: ref.expressId };
      },
      removeEntity(ref: EntityRef): boolean {
        return get().removeEntity(ref.expressId);
      },
      setPositionalAttribute(ref: EntityRef, index: number, value: unknown): void {
        get().setPositionalAttribute(ref.expressId, index, value as Parameters<StoreEditor['setPositionalAttribute']>[2]);
      },
      addDoor(modelId: string, storeyExpressId: number, params: DoorInStoreParams): EntityRef {
        assertModel(modelId);
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId, mutationView());
        const result = addDoorToStore(editor, anchor, params);
        return { modelId, expressId: result.doorId };
      },
      addWindow(modelId: string, storeyExpressId: number, params: WindowInStoreParams): EntityRef {
        assertModel(modelId);
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId, mutationView());
        const result = addWindowToStore(editor, anchor, params);
        return { modelId, expressId: result.windowId };
      },
      // Cost (#4857) and structural (#5167 S.1) authoring share one resolver
      // so an entity authored through either is visible to the next call on
      // the other; see `headless-backend-store-authoring.ts`.
      ...createStoreAuthoring({
        assertModel, defaultModelId: MODEL_ID,
        dataStore, editor: get,
        mutationView: () => this.getOrCreateMutationView(),
        ownerHistoryId: () => resolveLiveOwnerHistoryId(dataStore(), get(), this.getOrCreateMutationView()),
        cost: { data: (modelId, options) => this.cost.data(modelId, options) },
      }),
    };
  }

}
