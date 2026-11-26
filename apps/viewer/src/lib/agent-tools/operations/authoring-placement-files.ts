/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation, emptySchema } from './contract';
import { assertToolActive } from '../cancellation';
import { isFeatureEnabled } from '@/lib/features';
import { disabled, invalidInput, stale, decodedInput, unavailable } from './refusals';
const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const artifactOutput = { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false };
export const placementFileOperations = [
  viewerOperation({ id: 'placement.manifest.export', owner: 'placement', description: 'Export the native placement manifest with source hashes, instance IDs, frame identity, rotation pivots and locks. Metres, engineering Z-up.', effects: ['artifact'], capability: 'commands-and-edits', implementation: 'native-store', outputSchema: artifactOutput, policy: { artifact: 'native-export' } }, emptySchema, async (_, c) => {
    const [{ makePlacementManifest }, { placementFrameKey }] = await Promise.all([import('@/lib/model-placement/manifest'), import('@/lib/model-placement/persistence')]); assertToolActive(c);
    const s = useViewerStore.getState(); return c.artifacts.create({ filename: 'model-placements.json', mimeType: 'application/json', data: JSON.stringify(makePlacementManifest(s.models, s.modelPlacement.placements, placementFrameKey(s)), null, 2) });
  }),
  viewerOperation<{ content: string; bindings: Array<{ saved_instance_id: string; model_id: string }>; placement_revision: number }>({ id: 'placement.manifest.import', owner: 'placement', description: 'Import the complete native manifest atomically, with explicit source-instance bindings for ambiguous copies. Preserves native frame/source mismatch and rotation refusals.', effects: ['view', 'configuration'], capability: 'commands-and-edits', implementation: 'native-store', outputSchema: jsonOutput }, {
    type: 'object', properties: { content: { type: 'string', maxLength: 2000000 }, placement_revision: { type: 'integer', minimum: 0 }, bindings: { type: 'array', maxItems: 1000, items: { type: 'object', properties: { saved_instance_id: { type: 'string', minLength: 1, maxLength: 4096 }, model_id: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['saved_instance_id', 'model_id'], additionalProperties: false } } }, required: ['content', 'bindings', 'placement_revision'], additionalProperties: false,
  }, async (i, c) => {
    const { parsePlacementManifest, PlacementManifestTargetError } = await import('@/lib/model-placement/manifest'); assertToolActive(c);
    if (!isFeatureEnabled('edit.placement')) throw disabled('The host disabled model placement.');
    const manifest = decodedInput('content', () => parsePlacementManifest(i.content), { json: true });
    const bindings = new Map<string, string>(); for (const row of i.bindings) { if (bindings.has(row.saved_instance_id)) throw invalidInput('invalid-value', 'Duplicate saved-instance binding.'); bindings.set(row.saved_instance_id, row.model_id); }
    return c.commit(() => { const s = useViewerStore.getState(); if (s.modelPlacement.revision !== i.placement_revision) throw stale('Placement changed. Inspect again.');
      try { s.importModelPlacements(manifest, bindings); }
      catch (error) {
        if (error instanceof PlacementManifestTargetError) {
          if (error.reason === 'rotation') throw unavailable(error.message);
          throw invalidInput(error.reason, error.message);
        }
        throw error;
      }
      return { native_json: JSON.stringify({ revision: useViewerStore.getState().modelPlacement.revision, imported: manifest.models.length }) };
    });
  }),
];
