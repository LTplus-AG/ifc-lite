/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationExtensions, coordinationSources } from '@/services/coordination-hosts';
import { loadResolvedSourcePrefs, isPrefsConfigured } from '@/lib/sources/preferences';
import { useViewerStore } from '@/store';
import { emptySchema } from './contract';
import { coordination, textSchema } from './coordination-common';
interface Browse { provider: string; kind: 'projects' | 'containers' | 'files'; project_id: string; container_id: string; query: string; cursor: string }
export const coordinationProviderOperations = [
  coordination('sources.read', 'Inspect registered native file providers, capability declarations, credential readiness and loaded-model provenance without returning stored credentials.', ['read'], emptySchema, () => {
    const host = coordinationSources(); return { providers: host.list().map(provider => ({ manifest: provider.manifest, configured: isPrefsConfigured(provider.manifest, loadResolvedSourcePrefs(provider.manifest)) })), failures: host.getRegistrationFailures(), source_tags: [...useViewerStore.getState().sourceTags] };
  }),
  coordination<Browse>('sources.browse', 'Browse one bounded catalog page through an already configured native provider and its declared network sandbox. Interactive OAuth must first be completed through the provider sign-in control.', ['read', 'network'], {
    type: 'object', properties: { provider: { type: 'string', minLength: 1, maxLength: 200 }, kind: { type: 'string', enum: ['projects', 'containers', 'files'] },
      project_id: { type: 'string', maxLength: 1000 }, container_id: { type: 'string', maxLength: 1000 }, query: { type: 'string', maxLength: 1000 }, cursor: { type: 'string', maxLength: 10000 } }, required: ['provider', 'kind', 'project_id', 'container_id', 'query', 'cursor'], additionalProperties: false,
  }, async (i: Browse, c) => {
    const host = coordinationSources(), provider = host.get(i.provider); if (!provider) throw new Error('Unknown source provider.');
    const prefs = loadResolvedSourcePrefs(provider.manifest); if (!isPrefsConfigured(provider.manifest, prefs)) throw new Error('Configure required provider credentials in Sources settings first.');
    const context = host.createContext(provider.manifest, prefs); c.checkpoint?.();
    if (provider.auth && !await provider.auth.getIdentity(context)) throw new Error('Sign in through the native source provider before browsing.');
    const options = { limit: 100, cursor: i.cursor || undefined, signal: c.signal };
    if (i.kind !== 'projects' && !i.project_id) throw new Error('project_id is required for containers or files.');
    if (i.kind === 'files' && !i.container_id) throw new Error('container_id is required for files.');
    const page = i.kind === 'projects' ? await provider.listProjects(context, { ...options, query: i.query || undefined })
      : i.kind === 'containers' ? await provider.listContainers(context, i.project_id, i.container_id || undefined, options)
      : await provider.listFiles(context, i.project_id, i.container_id, undefined, options);
    c.checkpoint?.(); return { kind: i.kind, page };
  }),
  coordination('extensions.read', 'Read installed extension grants and state from the current native extension host.', ['read'], emptySchema, async () => ({ installed: await coordinationExtensions().listInstalled() })),
  coordination('extensions.flows', 'Resolve and validate installed extension workflow contributions using the native loader and standard wiring validator.', ['read'], emptySchema, async () => ({ contributions: await coordinationExtensions().listContributedFlows() })),
  coordination('extensions.previewBundle', 'Validate base64 encoded .iflx bundle bytes through the native preview service. Does not install, activate, execute code or grant capabilities.', ['read'], textSchema, async (i, c) => {
    if (i.value.length > 1000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(i.value)) throw new Error('Expected bounded base64 bundle bytes.');
    const bytes = Uint8Array.from(atob(i.value), character => character.charCodeAt(0));
    c.checkpoint?.(); const result = await coordinationExtensions().previewBundle(bytes); c.checkpoint?.(); return { validation: result };
  }),
];
