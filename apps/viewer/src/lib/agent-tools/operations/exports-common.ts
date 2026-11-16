/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isFeatureEnabled } from '@/lib/features';
import type { ViewerOperationContext } from './contract';
export const exportOutputSchema = { type: 'object', properties: {
  artifact: { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer', minimum: 0 } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false },
  diagnostics_json: { type: 'string' },
}, required: ['artifact', 'diagnostics_json'], additionalProperties: false };
export const exportMetadata = (id: string, description: string) => ({ id, owner: 'exports', description,
  features: ['export.files'] as const, effects: ['artifact'] as const, capability: 'commands-and-edits' as const,
  implementation: 'native-store' as const, policy: { artifact: 'native-export' as const }, outputSchema: exportOutputSchema });
/** Native export preparation may await hydration/workers; never publish bytes for a stale source. */
export function exportCheckpoint(c: ViewerOperationContext, modelIds: readonly string[]) {
  const before = useViewerStore.getState();
  const models = modelIds.map(id => [id, before.models.get(id)] as const);
  return () => {
    c.checkpoint?.();
    const now = useViewerStore.getState();
    if (!isFeatureEnabled('export.files')) throw new Error('Export is switched off in this viewer.');
    if (now.ifcDataStore !== before.ifcDataStore || now.mutationVersion !== before.mutationVersion || now.geometryContentVersion !== before.geometryContentVersion
      || models.some(([id, model]) => now.models.get(id) !== model)
      || now.modelPlacement !== before.modelPlacement || now.sceneState !== before.sceneState
      || now.scheduleData !== before.scheduleData || now.scheduleIsEdited !== before.scheduleIsEdited
      || now.scheduleSourceModelId !== before.scheduleSourceModelId) throw new Error('Source, placement, scene or schedule changed during export. Inspect and retry.');
  };
}
