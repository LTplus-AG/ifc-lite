/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { getBrowserLayerStore, DEFAULT_LOCAL_REF } from './browser-store';
import { publishCollabDraft, publishViewerDraft } from './publish';
import { pendingCompositionMutations } from './pending';
import type { NativeCompositionHost } from '@/services/coordination-loader';
/** Native local draft publication and re-composition, shared by the panel and operation. */
export async function publishLocalLayerDraft(mode: 'viewer' | 'session', intent: string, author: string, host: Pick<NativeCompositionHost, 'addIfcxOverlays'>) {
  const state = useViewerStore.getState(), trimmedIntent = intent.trim(), principal = author.trim() || 'viewer-user';
  if (!trimmedIntent || state.layerStack.length === 0) throw new Error('A loaded IFCX layer stack and nonempty intent are required.');
  const mutations = pendingCompositionMutations(), store = await getBrowserLayerStore();
  const live = useViewerStore.getState(); if (live.models !== state.models || live.layerStack !== state.layerStack || live.mutationVersion !== state.mutationVersion) throw new Error('Composition changed during native draft preparation.');
  window.localStorage.setItem('ifc-lite:layer-author', principal);
  if (mode === 'viewer') {
    const idToPath = new Map<number, string>(); for (const [path, id] of state.layerStackPathToId ?? []) idToPath.set(id, path);
    const result = publishViewerDraft({ store, stackFiles: state.layerStack.map(entry => entry.file), mutations, pathOf: id => idToPath.get(id), intent: trimmedIntent, authorPrincipal: principal, refName: DEFAULT_LOCAL_REF });
    if (result.unresolved.length || result.skippedCount) return { state: 'partial' as const, mode, result, durability: 'native-best-effort' as const };
    useViewerStore.getState().clearAllMutations();
    const name = `${trimmedIntent.slice(0, 40).replace(/[^\w-]+/g, '-') || 'layer'}.ifcx`;
    await host.addIfcxOverlays([new File([JSON.stringify(result.file)], name, { type: 'application/json' })]);
    if (!useViewerStore.getState().layerStack.some(entry => entry.file.header?.id === result.layerId)) throw new Error('The layer is in the native local store, but re-composition did not load it.');
    return { state: 'completed' as const, mode, result, durability: 'native-best-effort' as const };
  }
  if (!state.collabSession || !state.collabDraftBaseline) throw new Error('A live native collaboration baseline is required.');
  const result = await publishCollabDraft({ store, doc: state.collabSession.doc, baseline: state.collabDraftBaseline, stackFiles: state.layerStack.map(entry => entry.file), intent: trimmedIntent, authorPrincipal: principal, hybrid: state.collabPeers.length > 0 || state.collabPeersSinceBaseline, refName: DEFAULT_LOCAL_REF });
  useViewerStore.getState().resetCollabDraftBaseline(); useViewerStore.getState().clearAllMutations();
  const name = `${trimmedIntent.slice(0, 40).replace(/[^\w-]+/g, '-') || 'session-layer'}.ifcx`;
  await host.addIfcxOverlays([new File([JSON.stringify(result.file)], name, { type: 'application/json' })]);
  if (!useViewerStore.getState().layerStack.some(entry => entry.file.header?.id === result.layerId)) throw new Error('The layer is in the native local store, but re-composition did not load it.');
  return { state: 'completed' as const, mode, result, durability: 'native-best-effort' as const };
}
