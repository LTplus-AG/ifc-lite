/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { getMountedFileHost } from '@/components/viewer/toolbar/mounted-file-host';
import { useViewerStore } from '@/store';
import { coordination } from './coordination-common';
export const coordinationCollabOperations = [
  coordination<{ room_id: string; token: string }>('collab.join', 'Join an exact room with a supplied existing token using native role parsing, sync/reconstruction and teardown. Never accepts a caller-chosen role or returns credentials. A join that would publish local annotations waits for native approval.', ['network', 'configuration', 'view'], {
    type: 'object', properties: { room_id: { type: 'string', minLength: 1, maxLength: 200 }, token: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['room_id', 'token'], additionalProperties: false,
  }, async (i, c) => {
    const [{ parseRoleFromToken }, { liveCollabAttempt }] = await Promise.all([import('@/lib/collab/share-link'), import('@/lib/collab/session-attempt')]);
    const role = parseRoleFromToken(i.token) ?? 'viewer';
    if (role !== 'viewer' && [...useViewerStore.getState().annotations.values()].some(annotation => !annotation.remote)) return { state: 'waiting-for-approval', room_id: i.room_id, reason: 'This native join shares existing local annotations. Confirm through the native room UI.' };
    let owned: ReturnType<typeof liveCollabAttempt>;
    const cancel = () => { if (owned && liveCollabAttempt() === owned) useViewerStore.getState().stopCollab(); };
    c.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await c.commitAsync(async () => {
        const pending = useViewerStore.getState().startCollab({ roomId: i.room_id, role, token: i.token }); owned = liveCollabAttempt(); if (c.signal?.aborted) cancel(); await pending;
        const state = useViewerStore.getState();
        if (c.signal?.aborted || liveCollabAttempt() !== owned) return { state: 'cancelled', room_id: i.room_id };
        if (!state.collabSession || state.collabRoomId !== i.room_id) return { state: 'failed', room_id: i.room_id, reason: state.collabSeedFailure ?? 'Native room startup or synchronization failed.' };
        return { state: 'joined', room_id: i.room_id, role: state.collabRole, status: state.collabStatus, model_ids: [...state.collabRoomModels.keys()], geometry_notice: state.collabGeometryNotice };
      }, outcome => outcome.state === 'joined');
    } finally { c.signal?.removeEventListener('abort', cancel); }
  }),
  coordination<{ name: string; color: string }>('collab.identity', 'Edit the native local display identity and, when connected, its authorized presence record. Does not change account id, room token or role.', ['configuration', 'network'], {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' } }, required: ['name', 'color'], additionalProperties: false,
  }, (i, c) => c.commit(() => { if (!i.name.trim()) throw new Error('A nonempty native display name is required.'); useViewerStore.getState().setCollabIdentity({ name: i.name, color: i.color }); const identity = useViewerStore.getState().collabIdentity; return { name: identity.name, color: identity.color }; })),
  coordination<{ scope: 'active' | 'all'; role: 'viewer' | 'commenter' | 'editor'; expected_mutation_version: number; expected_geometry_version: number }>('collab.prepareRoom', 'Validate and prepare an exact native share scope/role for the real Share consent dialog. New room creation uploads models only after the native Create link approval. For an existing room the candidate waits until the user opens Share, so no invite is minted unasked; no token is returned.', ['configuration', 'view'], {
    type: 'object', properties: { scope: { type: 'string', enum: ['active', 'all'] }, role: { type: 'string', enum: ['viewer', 'commenter', 'editor'] }, expected_mutation_version: { type: 'integer', minimum: 0 }, expected_geometry_version: { type: 'integer', minimum: 0 } }, required: ['scope', 'role', 'expected_mutation_version', 'expected_geometry_version'], additionalProperties: false,
  }, async (i, c) => {
    const [{ prepareShareSeed, shareRefusesEveryModel }, { useCollabShareReview }, { isCollabSeedInFlight }, { isCollabEnabled }] = await Promise.all([import('@/lib/collab/share-scope'), import('@/lib/collab/share-review'), import('@/lib/collab/seed-phase'), import('@/lib/collab/config')]);
    if (!isCollabEnabled()) throw new Error('Collaboration is not enabled in this viewer.');
    // An open dialog keeps the user's current choices; a candidate is only applied as Share opens.
    if (useCollabShareReview.getState().dialogOpen) throw new Error('The Share dialog is already open. Close it, then prepare the share again.');
    const state = useViewerStore.getState();
    if (state.mutationVersion !== i.expected_mutation_version || state.geometryContentVersion !== i.expected_geometry_version) throw new Error('Model revisions changed before share preparation.');
    if (state.collabRoomId && isCollabSeedInFlight(state.collabSeedPhase)) throw new Error('The native room seed is still in flight.');
    const rank = { viewer: 0, commenter: 1, editor: 2, admin: 3 };
    if (state.collabRole && rank[i.role] > rank[state.collabRole]) throw new Error('This native room role cannot grant the requested invite access.');
    // Only an admin mints role-scoped links; any other member can only forward the invite it holds.
    if (state.collabRoomId && state.collabRole && state.collabRole !== 'admin') throw new Error('Only the room admin can prepare a role-scoped invite.');
    if (!state.collabRoomId && shareRefusesEveryModel(state.models, state.activeModelId, i.scope)) throw new Error('No model in the selected native scope can be shared.');
    const shareHost = getMountedFileHost();
    if (!shareHost?.preloadShareDialog || !shareHost.openShareDialog) throw new Error('The Share consent dialog is unavailable in this viewer.');
    try { await shareHost.preloadShareDialog(); }
    catch (cause) { throw new Error('The Share consent dialog could not load. Reload the viewer before preparing a share.', { cause }); }
    c.checkpoint?.();
    const prepared = state.collabRoomId ? null : await prepareShareSeed(state.models, state.mutationViews, state.activeModelId, i.scope, state.georefMutations); c.checkpoint?.();
    return c.commit(() => {
      const currentHost = getMountedFileHost();
      if (!currentHost?.openShareDialog || currentHost.owner !== shareHost.owner || currentHost.preloadShareDialog !== shareHost.preloadShareDialog) {
        throw new Error('The Share consent dialog changed during share preparation.');
      }
      if (useCollabShareReview.getState().dialogOpen) throw new Error('The Share dialog is already open. Close it, then prepare the share again.');
      const live = useViewerStore.getState(); if (live.models !== state.models || live.mutationVersion !== state.mutationVersion || live.geometryContentVersion !== state.geometryContentVersion || live.collabRoomId !== state.collabRoomId) throw new Error('Model scope or room changed during share preparation.');
      const candidate = { id: crypto.randomUUID(), scope: i.scope, role: i.role, modelIds: prepared?.models.map(model => model.modelId) ?? [...state.collabRoomModels.keys()], activeModelId: state.activeModelId, loadedModelIds: [...state.models.keys()], mutationVersion: state.mutationVersion, geometryVersion: state.geometryContentVersion, roomId: state.collabRoomId };
      useCollabShareReview.setState({ candidate });
      // Opening the dialog on an existing room mints an invite at once, so only a
      // new room (created on the dialog's explicit Create link) is opened for the
      // user; otherwise the candidate waits until the user opens Share.
      if (!state.collabRoomId) currentHost.openShareDialog();
      return { state: 'waiting-for-approval', candidate, seed_failure: state.collabSeedFailure };
    });
  }),
  coordination<{ expected_room_id: string }>('collab.revokeInvite', 'Revoke the last native share link with the current native admin token. Does not disclose either token.', ['network', 'configuration'], {
    type: 'object', properties: { expected_room_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['expected_room_id'], additionalProperties: false,
  }, (i, c) => c.commitAsync(async () => { const state = useViewerStore.getState(); if (state.collabRoomId !== i.expected_room_id || state.collabRole !== 'admin') throw new Error('The exact native room admin role is required.'); return { revoked: await state.revokeCollabLink() }; }, outcome => outcome.revoked)),
  coordination<{ expected_room_id: string; peer_client_id: number }>('collab.removePeer', 'Use native room administration to disconnect an exact peer client id; server token authority remains authoritative.', ['network', 'configuration'], {
    type: 'object', properties: { expected_room_id: { type: 'string', minLength: 1, maxLength: 200 }, peer_client_id: { type: 'integer', minimum: 0 } }, required: ['expected_room_id', 'peer_client_id'], additionalProperties: false,
  }, (i, c) => c.commitAsync(async () => { const state = useViewerStore.getState(); if (state.collabRoomId !== i.expected_room_id || state.collabRole !== 'admin') throw new Error('The exact native room admin role is required.'); if (!state.collabSession?.presence.awareness.getStates().has(i.peer_client_id)) throw new Error('Unknown native room peer.'); return { removed: await state.kickPeer(i.peer_client_id) }; }, outcome => outcome.removed)),
];
