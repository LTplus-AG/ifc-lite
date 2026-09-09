/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StepExporter } from '@ifc-lite/export';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { appearanceRevision, captureAppearanceSource } from './command.js';
import { prepareAppearanceSerialization } from './serialization.js';
import type { AppearancePlanner } from './planner-worker-client.js';
import type { AppearanceCatalog } from './planner-types.js';

export interface AppearanceSnapshot {
  modelId: string;
  revision: string;
  schema: 'IFC4' | 'IFC4X3';
  nextExpressId: number;
  bytes: Uint8Array;
  productIds: readonly number[];
  catalog: AppearanceCatalog;
  source: ReturnType<typeof captureAppearanceSource>;
  validate(): void;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Appearance preparation was cancelled', 'AbortError');
}

/** One effective snapshot supplies both Rust metadata and geometry planning.
 * Cache validation includes SDK writes that do not advance mutationVersion. */
export async function prepareAppearanceSnapshot(
  previous: AppearanceSnapshot | null,
  modelId: string,
  productIds: readonly number[],
  planner: AppearancePlanner,
  signal: AbortSignal,
): Promise<AppearanceSnapshot> {
  checkAbort(signal);
  if (previous?.modelId === modelId && previous.productIds.length === productIds.length
    && previous.productIds.every((id, index) => id === productIds[index])) {
    try { previous.validate(); return previous; }
    catch {
      // A stale cache is expected after an SDK edit. Rebuild from the current
      // effective IFC; never reuse the old class/type membership or byte graph.
      previous = null;
    }
  }
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  const view = state.mutationViews.get(modelId);
  const dataStore = model?.ifcDataStore;
  if (!dataStore || !view) throw new Error('The model is not ready to prepare appearance.');
  if (!model.schemaVersion.startsWith('IFC4')) throw new Error('Appearance authoring requires IFC4 or IFC4X3.');
  if (productIds.length > 10_000 || dataStore.source.byteLength > 128 * 1024 * 1024) {
    throw new Error('This model exceeds the appearance preparation budget. Choose a smaller model.');
  }
  new StoreEditor(dataStore, view);
  const revision = appearanceRevision(modelId);
  const nextExpressId = view.peekNextExpressId();
  const source = captureAppearanceSource(view);
  const schema = model.schemaVersion.startsWith('IFC4X3') ? 'IFC4X3' : 'IFC4';
  const validate = () => {
    const current = useViewerStore.getState();
    if (current.models.get(modelId)?.ifcDataStore !== dataStore || appearanceRevision(modelId) !== revision) {
      throw new Error('The appearance model changed. Refresh its scope and preview.');
    }
    source.validate(current.mutationViews.get(modelId));
  };
  const serialized = prepareAppearanceSerialization(modelId, dataStore, view);
  const exported = await new StepExporter(dataStore, serialized.view).exportAsync({
    schema, applyMutations: true, includeGeometry: true, visibleOnly: false,
    onProgress: () => checkAbort(signal),
  });
  checkAbort(signal); validate();
  const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
  const catalog = await planner.catalog(bytes, { schema, sourceRevision: revision, productIds: [...productIds] }, { signal });
  checkAbort(signal); validate();
  return { modelId, revision, schema, nextExpressId, bytes, catalog, source,
    productIds: [...productIds], validate };
}
