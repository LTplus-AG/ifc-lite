/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BlobStore, LocalPlacement, ModelSlot, PropertyValue as CollabPropertyValue } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerModelPayload } from '@/hooks/ingest/viewerModelIngest';
import { bindRoomStepSource, loadRoomStepSource, type ParsedRoomStepSource } from './room-step-source';
import { registerRoomSymbolicSource } from './room-symbolic-source';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets';

const REGISTERED_RESOURCES = new WeakMap<IfcDataStore, Set<string>>();

export async function attachRoomStepSource(options: {
  payload: ViewerModelPayload;
  modelId: string;
  slot: ModelSlot;
  blobStore: BlobStore;
  sources: Map<string, Promise<ParsedRoomStepSource>>;
  placementForPath: (path: string) => LocalPlacement | undefined;
  baselineForPath: (path: string) => LocalPlacement | undefined;
  structuredForPath: (path: string) => {
    attributes: Record<string, unknown>;
    psets: Record<string, Record<string, CollabPropertyValue>>;
    quantities: Record<string, Record<string, number>>;
  } | undefined;
  live: () => boolean;
}): Promise<void> {
  const { payload, slot } = options;
  if (!slot.stepSourceBlobHash || !payload.pathToId) return;
  const key = `${slot.slotId}:${slot.stepSourceBlobHash}`;
  let source = options.sources.get(key);
  if (!source) {
    source = loadRoomStepSource(options.blobStore, slot.stepSourceBlobHash, slot.stepSourceFormat);
    options.sources.set(key, source);
  }
  const parsed = await source;
  if (!options.live()) return;
  if (parsed.resources) {
    const registered = REGISTERED_RESOURCES.get(parsed.dataStore) ?? new Set<string>();
    if (!registered.has(options.modelId)) {
      const lease = modelAppearanceAssets.begin(options.modelId);
      try {
        await lease.decode({
          originalResources: new Map(parsed.resources.resources),
          modelPath: parsed.resources.modelPath,
          resourcesIncomplete: false,
        });
      } catch (error) {
        lease.cancel();
        throw error;
      }
      if (!options.live()) { lease.cancel(); return; }
      lease.finish(true);
      registered.add(options.modelId);
      REGISTERED_RESOURCES.set(parsed.dataStore, registered);
    }
  }
  registerRoomSymbolicSource(payload.dataStore, bindRoomStepSource(
    parsed, slot, payload.pathToId, options.placementForPath, options.baselineForPath,
    options.structuredForPath,
  ));
}
