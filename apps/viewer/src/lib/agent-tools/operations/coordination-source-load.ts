/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationSources } from '@/services/coordination-hosts';
import { coordinationModelAdder } from '@/services/coordination-loader';
import { loadResolvedSourcePrefs, isPrefsConfigured } from '@/lib/sources/preferences';
import { enqueueSourceLoad } from '@/lib/sources/loadQueue';
import { sanitizeModelFilename } from '@/lib/export/download';
import { useViewerStore } from '@/store';
import { coordination } from './coordination-common';
import { internal, invalidInput, stale, unavailable } from './refusals';
interface SourceLoad { provider: string; project_id: string; container_id: string; file_id: string; revision_id: string; filename: string }
export const coordinationSourceLoadOperations = [coordination<SourceLoad>('sources.loadModel', 'Download an exact native provider file and await canonical useIfcLoader.loadFile federation loading. Downloads support cancellation; after native load admission, cancellation waits for its actual terminal outcome.', ['network', 'configuration', 'view'], {
  type: 'object', properties: { provider: { type: 'string', minLength: 1, maxLength: 200 }, project_id: { type: 'string', minLength: 1, maxLength: 1000 }, container_id: { type: 'string', minLength: 1, maxLength: 1000 }, file_id: { type: 'string', minLength: 1, maxLength: 1000 }, revision_id: { type: 'string', maxLength: 1000 }, filename: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['provider', 'project_id', 'container_id', 'file_id', 'revision_id', 'filename'], additionalProperties: false,
}, async (i, c) => {
  const addModel = coordinationModelAdder(), host = coordinationSources(), provider = host.get(i.provider);
  if (!provider) throw invalidInput('unknown-target', 'Unknown native source provider.');
  const prefs = loadResolvedSourcePrefs(provider.manifest); if (!isPrefsConfigured(provider.manifest, prefs)) throw unavailable('Configure the source provider first.');
  const ctx = host.createContext(provider.manifest, prefs);
  if (provider.auth && !await provider.auth.getIdentity(ctx)) throw unavailable('Sign in through the native source provider first.');
  c.checkpoint?.(); const revisionId = i.revision_id || undefined;
  const buffer = await provider.download(ctx, { projectId: i.project_id, containerId: i.container_id, fileId: i.file_id, revisionId }, {
    signal: c.signal, onProgress: (done, total) => c.progress?.({ phase: 'download', done, total: total ?? 0 }),
  });
  c.checkpoint?.(); const filename = sanitizeModelFilename(i.filename), modelId = crypto.randomUUID();
  // Queue waiting is preparation, not native load admission. Recheck the live
  // grant only when this request actually reaches the serialized loader.
  return enqueueSourceLoad(() => c.commitAsync(async () => {
    if (host.get(i.provider) !== provider || JSON.stringify(loadResolvedSourcePrefs(provider.manifest)) !== JSON.stringify(prefs)) throw stale('Native source provider configuration changed before load admission.');
    const loadedId = await addModel(new File([buffer], filename), { modelId, name: filename });
    if (loadedId !== modelId) throw internal('Native federation admission or loading did not complete.');
    const state = useViewerStore.getState(), model = state.models.get(modelId);
    if (!model || model.loadState === 'error' || (model.loadState && model.loadState !== 'complete')) throw internal(model?.loadError ?? 'Native model load did not complete.');
    state.setSourceTag(modelId, host.createSourceTag(i.provider, i.project_id, i.container_id, i.file_id, i.revision_id));
    return { model_id: modelId, name: model.name, state: model.loadState ?? 'complete', bytes: buffer.byteLength };
  }));
})];
