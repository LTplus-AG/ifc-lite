/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationSources } from '@/services/coordination-hosts';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { coordination, idSchema } from './coordination-common';
import { emptySchema } from './contract';
async function providerOwner(providerId: string) {
  const host = coordinationSources(), provider = host.get(providerId); if (!provider) throw new Error('Unknown source provider.');
  const identity = provider.auth ? await provider.auth.getIdentity(host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest))) : null;
  if (provider.auth && !identity) throw new Error('Sign in through the native source provider first.'); return identity?.id ?? null;
}
export const coordinationSourceCatalogOperations = [
  coordination('sources.favourites', 'Read only native favourites belonging to the current authenticated provider identity.', ['read', 'network'], idSchema, async (i, c) => {
    const { loadFavourites, visibleFavourites, favouriteKey } = await import('@/lib/sources/favourites'); const owner = await providerOwner(i.id); c.checkpoint?.();
    return { provider: i.id, favourites: visibleFavourites(loadFavourites(i.id), owner).map(favourite => ({ key: favouriteKey(favourite), favourite })) };
  }),
  coordination<{ provider: string; kind: 'folder' | 'file'; project_id: string; project_name: string; file_area_id: string; file_area_name: string; container_id: string; container_name: string; file_id: string; file_name: string }>('sources.toggleFavourite', 'Toggle one exact native file/folder bookmark, stamped with the current provider identity. Does not accept a caller-supplied account identity.', ['configuration', 'network'], {
    type: 'object', properties: { provider: { type: 'string', minLength: 1, maxLength: 200 }, kind: { type: 'string', enum: ['folder', 'file'] }, project_id: { type: 'string', minLength: 1, maxLength: 1000 }, project_name: { type: 'string', maxLength: 500 }, file_area_id: { type: 'string', minLength: 1, maxLength: 1000 }, file_area_name: { type: 'string', maxLength: 500 }, container_id: { type: 'string', minLength: 1, maxLength: 1000 }, container_name: { type: 'string', maxLength: 500 }, file_id: { type: 'string', maxLength: 1000 }, file_name: { type: 'string', maxLength: 500 } }, required: ['provider', 'kind', 'project_id', 'project_name', 'file_area_id', 'file_area_name', 'container_id', 'container_name', 'file_id', 'file_name'], additionalProperties: false,
  }, async (i, c) => {
    const { toggleFavourite, visibleFavourites } = await import('@/lib/sources/favourites'); const owner = await providerOwner(i.provider);
    if (i.kind === 'file' && (!i.file_id || !i.file_name)) throw new Error('File bookmarks require the exact file id and name.');
    return c.commit(() => { const result = toggleFavourite({ providerId: i.provider, kind: i.kind, projectId: i.project_id, projectName: i.project_name, fileAreaId: i.file_area_id, fileAreaName: i.file_area_name, containerId: i.container_id, containerName: i.container_name, fileId: i.kind === 'file' ? i.file_id : undefined, fileName: i.kind === 'file' ? i.file_name : undefined, identityId: owner, addedAt: Date.now() }); if (!result.ok) throw new Error(`Native bookmark write refused: ${result.reason ?? 'storage'}`); return { ...result, items: visibleFavourites(result.items, owner) }; });
  }),
  coordination<{ provider: string; key: string; name: string }>('sources.renameFavourite', 'Rename the label of one native bookmark owned by the current provider account.', ['configuration', 'network'], {
    type: 'object', properties: { provider: { type: 'string', minLength: 1, maxLength: 200 }, key: { type: 'string', minLength: 1, maxLength: 10000 }, name: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['provider', 'key', 'name'], additionalProperties: false,
  }, async (i, c) => {
    const { loadFavourites, visibleFavourites, favouriteKey, renameFavourite } = await import('@/lib/sources/favourites'); const owner = await providerOwner(i.provider);
    if (!visibleFavourites(loadFavourites(i.provider), owner).some(item => favouriteKey(item) === i.key)) throw new Error('Unknown bookmark for this provider identity.');
    return c.commit(() => { const items = visibleFavourites(renameFavourite(i.provider, i.key, i.name), owner); const renamed = items.find(item => favouriteKey(item) === i.key); if ((renamed?.kind === 'file' ? renamed.fileName : renamed?.containerName) !== i.name) throw new Error('Native bookmark rename was not persisted.'); return { items }; });
  }),
  coordination<{ provider: string; key: string }>('sources.removeFavourite', 'Remove one native bookmark belonging to the current provider identity.', ['configuration', 'network'], {
    type: 'object', properties: { provider: { type: 'string', minLength: 1, maxLength: 200 }, key: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['provider', 'key'], additionalProperties: false,
  }, async (i, c) => {
    const { loadFavourites, visibleFavourites, favouriteKey, removeFavourite } = await import('@/lib/sources/favourites'); const owner = await providerOwner(i.provider);
    if (!visibleFavourites(loadFavourites(i.provider), owner).some(item => favouriteKey(item) === i.key)) throw new Error('Unknown bookmark for this provider identity.');
    return c.commit(() => { const items = removeFavourite(i.provider, i.key); if (items.some(item => favouriteKey(item) === i.key)) throw new Error('Native bookmark removal was not persisted.'); return { removed: true, items: visibleFavourites(items, owner) }; });
  }),
  coordination('sources.refreshRevisions', 'Perform one native source revision-change pass for loaded tagged models; no recurring watcher is created. Reports provider failures and unsupported change-detection coverage.', ['network', 'configuration'], emptySchema, async (_, c) => {
    const [{ watchSourceRevisions }, { useViewerStore }] = await Promise.all([import('@/lib/sources/revisionWatch'), import('@/store')]); const host = coordinationSources(), tags = useViewerStore.getState().sourceTags;
    const failures: Array<{ provider: string; project_id: string }> = [];
    const unsupported = [...tags].filter(([, tag]) => { const provider = host.get(tag.provider); return !provider?.watchRevisions || !provider.manifest.capabilities.changeDetection; }).map(([id]) => id);
    const updates = await watchSourceRevisions(host, tags, c.signal, (provider, projectId) => failures.push({ provider, project_id: projectId })); c.checkpoint?.();
    if (useViewerStore.getState().sourceTags !== tags) throw new Error('Loaded source identities changed during revision checking.'); return { updates, failures, unsupported_model_ids: unsupported, partial: failures.length > 0 || unsupported.length > 0 };
  }),
];
