/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isFeatureEnabled } from '@/lib/features';
import { buildChangedArtifacts, collectChangedModels } from '@/lib/export/model-changes';
import { defaultBuildArtifactsDeps } from '@/lib/export/changed-model-export';
import { zipArtifacts } from '@/lib/export/artifact-bundle';
import { viewerOperation, emptySchema } from './contract';
import { disabled, internal, stale, unavailable } from './refusals';
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
    if (!isFeatureEnabled('export.files')) throw disabled('Export is switched off in this viewer.');
    const state = useViewerStore.getState(), revision = state.mutationVersion;
    // Schedule import/clear replaces scheduleData without bumping mutationVersion.
    const schedule = [state.scheduleData, state.scheduleIsEdited, state.scheduleSourceModelId] as const;
    const models = [...state.models.entries()];
    const current = () => {
      c.checkpoint?.();
      const now = useViewerStore.getState();
      if (now.mutationVersion !== revision || now.models.size !== models.length
        || models.some(([id, model]) => now.models.get(id) !== model)
        || [now.scheduleData, now.scheduleIsEdited, now.scheduleSourceModelId].some((value, index) => value !== schedule[index])) throw stale('Model/federation changed during export; discard and retry.');
      if (!isFeatureEnabled('export.files')) throw disabled('Export was switched off.');
    };
    if (!collectChangedModels(state).models.length) throw unavailable('No models have pending exportable changes.');
    const result = await buildChangedArtifacts(state, defaultBuildArtifactsDeps);
    current();
    if (!result.files.length) throw internal(`Native exporter produced no files: ${result.skipped.map(item => `${item.name}: ${item.reason}`).join('; ')}`);
    const first = result.files[0];
    const single = result.files.length === 1;
    const data = single ? first.content : await zipArtifacts(result.files);
    current();
    const saved = await c.artifacts.create({ filename: single ? `${first.base}.${first.ext}` : 'ifc-lite-changes.zip',
      mimeType: single ? first.mime : 'application/zip', data });
    return { artifact: saved, files: result.files.map(file => ({ filename: single ? saved.filename : `${file.base}.${file.ext}`, model_id: file.modelId, changes: file.changeCount, skipped_psets: file.skippedCount })),
      skipped: result.skipped, schedule_spliced: result.scheduleSpliced };
  }),
];
