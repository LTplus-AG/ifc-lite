/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { getViewerStoreApi } from '@/store';
import { toast } from '@/components/ui/toast';
import { readNativeFile } from '@/services/file-dialog';

const exportHydrationByModel = new Map<string, Promise<IfcDataStore | null>>();

function isDesktopRuntime(): boolean {
  // `globalThis` and `Window` aren't structurally compatible per TS, so
  // route through `unknown` first — the cast is intentional.
  const win = globalThis as unknown as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } };
  return typeof win.__TAURI_INTERNALS__?.invoke === 'function';
}

function hasFullStepSource(dataStore: IfcDataStore | null | undefined): dataStore is IfcDataStore {
  return Boolean(dataStore?.source?.length && dataStore.entityIndex?.byId?.size);
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

export async function ensureModelExportReady(modelId: string): Promise<IfcDataStore | null> {
  const store = getViewerStoreApi();
  const state = store.getState();

  if (modelId === '__legacy__') {
    return state.ifcDataStore;
  }

  const model = state.models.get(modelId);
  if (!model) {
    return null;
  }

  if (hasFullStepSource(model.ifcDataStore)) {
    return model.ifcDataStore;
  }

  if (!isDesktopRuntime() || !model.nativeMetadata?.filePath) {
    return model.ifcDataStore;
  }

  const pending = exportHydrationByModel.get(modelId);
  if (pending) {
    return pending;
  }

  const hydrationPromise = (async () => {
    toast.info(`Preparing ${model.name} for IFC export...`);
    const bytes = await readNativeFile(model.nativeMetadata!.filePath);
    const parser = new IfcParser();
    const hydratedStore = await parser.parseColumnar(toExactArrayBuffer(bytes));

    store.getState().updateModel(modelId, {
      ifcDataStore: hydratedStore,
      schemaVersion: hydratedStore.schemaVersion,
      metadataLoadState: 'complete',
    });

    return hydratedStore;
  })().finally(() => {
    exportHydrationByModel.delete(modelId);
  });

  exportHydrationByModel.set(modelId, hydrationPromise);
  return hydrationPromise;
}
