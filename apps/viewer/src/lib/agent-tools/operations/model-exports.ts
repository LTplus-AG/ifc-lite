/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isFeatureEnabled } from '@/lib/features';
import { buildChangedArtifacts, collectChangedModels } from '@/lib/export/model-changes';
import { defaultBuildArtifactsDeps } from '@/lib/export/changed-model-export';
import { zipArtifacts } from '@/lib/export/artifact-bundle';
import { viewerOperation, emptySchema } from './contract';
const artifact = { type: 'object', properties: {
  artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer', minimum: 0 },
}, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false };
export const modelExportOperations = [
  viewerOperation({ id: 'exports.changedModels', owner: 'changes',
    description: 'Produce full native IFC/IFCX files with pending edits for every changed model, using the same exporter and ZIP bundler as Export modified IFC. Retains schedule attribution, portable appearance resources, native skips and format-loss diagnostics. Returns one connection-owned file or ZIP; no browser download or remote publication. Model/federation changes during production refuse the result.',
    features: ['export.files'], effects: ['artifact'], capability: 'commands-and-edits', implementation: 'native-store', policy: { artifact: 'native-export' },
    outputSchema: { type: 'object', properties: {
      artifact, files: { type: 'array', items: { type: 'object', properties: {
        filename: { type: 'string' }, model_id: { type: 'string' }, changes: { type: 'integer' }, skipped_psets: { type: 'integer' },
      }, required: ['filename', 'model_id', 'changes', 'skipped_psets'], additionalProperties: false } },
      skipped: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name', 'reason'], additionalProperties: false } },
      schedule_spliced: { type: 'boolean' },
    }, required: ['artifact', 'files', 'skipped', 'schedule_spliced'], additionalProperties: false },
  }, emptySchema, async (_, c) => {
    if (!isFeatureEnabled('export.files')) throw new Error('Export is switched off in this viewer.');
    const state = useViewerStore.getState(), revision = state.mutationVersion;
    const models = [...state.models.entries()];
    const current = () => {
      c.checkpoint?.();
      const now = useViewerStore.getState();
      if (now.mutationVersion !== revision || now.models.size !== models.length
        || models.some(([id, model]) => now.models.get(id) !== model)) throw new Error('Model/federation changed during export; discard and retry.');
      if (!isFeatureEnabled('export.files')) throw new Error('Export was switched off.');
    };
    if (!collectChangedModels(state).models.length) throw new Error('No models have pending exportable changes.');
    const result = await buildChangedArtifacts(state, defaultBuildArtifactsDeps);
    current();
    if (!result.files.length) throw new Error(`Native exporter produced no files: ${result.skipped.map(item => `${item.name}: ${item.reason}`).join('; ')}`);
    const first = result.files[0];
    const data = result.files.length === 1 ? first.content : await zipArtifacts(result.files);
    current();
    const saved = await c.artifacts.create({ filename: result.files.length === 1 ? `${first.base}.${first.ext}` : 'ifc-lite-changes.zip',
      mimeType: result.files.length === 1 ? first.mime : 'application/zip', data });
    return { artifact: saved, files: result.files.map(file => ({ filename: `${file.base}.${file.ext}`, model_id: file.modelId, changes: file.changeCount, skipped_psets: file.skippedCount })),
      skipped: result.skipped, schedule_spliced: result.scheduleSpliced };
  }),
];
