/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration slice (M1 scaffolding).
 *
 * Owns the live `CollabSession`, the local ephemeral identity, the resolved
 * access role, and the presence roster. This is the viewer-side counterpart
 * to `@ifc-lite/collab`; see `docs/architecture/essen-multiuser-collab-plan.md`
 * (§7.1) for the full M1 task list.
 *
 * What this scaffolding wires up today:
 *   - identity bootstrap (accountless, persisted handle + color),
 *   - session lifecycle (`startCollab` / `stopCollab`),
 *   - status + presence subscriptions feeding the store.
 *
 * What it deliberately stubs for later milestones (TODOs inline):
 *   - `seedFromStep` model seeding into the Y.Doc (plan §4.2, M1),
 *   - mutation binding + remote→local apply (plan §7.5, M2),
 *   - presence overlay mounting in the viewport (plan §7.4 — done at mount
 *     time in the viewport component, not here).
 */

import type { StateCreator } from 'zustand';
import {
  createCollabSession,
  type CollabSession,
  type PresenceState,
  type ProviderKind,
  type UserIdentity,
  type WebSocketStatus,
} from '@ifc-lite/collab';
import { collabServerUrl } from '@/lib/collab/config';
import {
  loadOrCreateIdentity,
  persistIdentity,
  type EphemeralIdentity,
} from '@/lib/collab/identity';

/**
 * Access roles, mirrored from `@ifc-lite/collab-server`'s `Role`. Kept as a
 * local type so the viewer doesn't depend on the server package. The role is
 * authoritative on the server (token-derived); the client value only gates
 * UI affordances.
 */
export type CollabRole = 'viewer' | 'commenter' | 'editor' | 'admin';

export type CollabStatus = 'disconnected' | WebSocketStatus | 'memory' | 'indexeddb';

export interface StartCollabOptions {
  /** Room to join. Owner-minted random id, or the `?room=` deep-link value. */
  roomId: string;
  /** Role this client believes it has (server re-checks via the token). */
  role: CollabRole;
  /** Bearer room token forwarded to the collab-server (plan §3.1). */
  token?: string;
}

export interface CollabSlice {
  // ── State ────────────────────────────────────────────────────────────────
  /** The live session, or `null` when not in a shared room. */
  collabSession: CollabSession | null;
  /** Connection/persistence status surfaced for the toolbar indicator. */
  collabStatus: CollabStatus;
  /** Current room id, or `null`. */
  collabRoomId: string | null;
  /** This client's resolved role (UI gating only). */
  collabRole: CollabRole | null;
  /** Local ephemeral identity (handle + color). */
  collabIdentity: EphemeralIdentity;
  /** Remote peers currently present (excludes self). */
  collabPeers: PresenceState[];
  /** True while a session is being established. */
  collabConnecting: boolean;

  // ── Actions ──────────────────────────────────────────────────────────────
  /** Rename / recolor the local identity and persist it. */
  setCollabIdentity: (patch: Partial<Pick<EphemeralIdentity, 'name' | 'color'>>) => void;
  /** Join (or create) a collaborative room. Idempotent: stops any prior session. */
  startCollab: (opts: StartCollabOptions) => Promise<void>;
  /** Leave the current room and tear everything down. */
  stopCollab: () => void;
  /** Whether this client may write the model (editor/admin). */
  canCollabEdit: () => boolean;
  /** Whether this client may write comments (commenter/editor/admin). */
  canCollabComment: () => boolean;
}

function pickProvider(): ProviderKind {
  // With a server configured we run both local persistence and live sync;
  // without one we stay local-only (still multi-tab via BroadcastChannel),
  // which is enough to exercise the UI without a backend (plan §5 hosting).
  return collabServerUrl() ? 'indexeddb+websocket' : 'indexeddb';
}

function remotePeers(peers: Record<number, PresenceState>, selfClientId: number): PresenceState[] {
  const out: PresenceState[] = [];
  for (const [clientId, state] of Object.entries(peers)) {
    if (Number(clientId) === selfClientId) continue;
    out.push(state);
  }
  return out;
}

export const createCollabSlice: StateCreator<CollabSlice, [], [], CollabSlice> = (set, get) => ({
  // Initial state
  collabSession: null,
  collabStatus: 'disconnected',
  collabRoomId: null,
  collabRole: null,
  collabIdentity: loadOrCreateIdentity(),
  collabPeers: [],
  collabConnecting: false,

  setCollabIdentity: (patch) => {
    const next: EphemeralIdentity = { ...get().collabIdentity, ...patch };
    persistIdentity(next);
    set({ collabIdentity: next });
    // Reflect the rename into a live session's presence immediately.
    const session = get().collabSession;
    if (session) {
      const user: UserIdentity = { id: next.id, name: next.name, color: next.color };
      session.presence.setUser(user);
    }
  },

  startCollab: async ({ roomId, role, token }) => {
    // Tear down any existing session first (idempotent join).
    get().stopCollab();
    set({ collabConnecting: true, collabRoomId: roomId, collabRole: role });

    const identity = get().collabIdentity;
    const user: UserIdentity = { id: identity.id, name: identity.name, color: identity.color };

    let session: CollabSession;
    try {
      session = await createCollabSession({
        roomId,
        user,
        provider: pickProvider(),
        serverUrl: collabServerUrl() ?? undefined,
        token,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] failed to start session:', err);
      set({ collabConnecting: false, collabStatus: 'disconnected' });
      return;
    }

    // If a newer start/stop happened while we were awaiting, discard.
    if (get().collabRoomId !== roomId) {
      session.dispose();
      return;
    }

    const selfClientId = session.clientId;
    session.presence.onUpdate((peers) => {
      set({ collabPeers: remotePeers(peers, selfClientId) });
    });
    session.onStatus((status) => set({ collabStatus: status }));

    // TODO(M1, plan §4.2): seed the active model into the Y.Doc via
    // `seedFromStep` (legacy STEP) or `seedFromIfcx` (IFCX) so recipients can
    // reconstruct it from the room. Until then a session only carries presence.
    // TODO(M2, plan §7.5): `bindMutationsToCollab` + remote→local observer.

    set({
      collabSession: session,
      collabStatus: session.status(),
      collabConnecting: false,
    });
  },

  stopCollab: () => {
    const session = get().collabSession;
    if (session) {
      try {
        session.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] error disposing session:', err);
      }
    }
    set({
      collabSession: null,
      collabStatus: 'disconnected',
      collabRoomId: null,
      collabRole: null,
      collabPeers: [],
      collabConnecting: false,
    });
  },

  canCollabEdit: () => {
    const role = get().collabRole;
    // Not in a shared room → fall back to the local single-user editing rules
    // (handled by the UI's existing `editEnabled` gate), so treat as allowed.
    if (role === null) return true;
    return role === 'editor' || role === 'admin';
  },

  canCollabComment: () => {
    const role = get().collabRole;
    if (role === null) return true;
    return role === 'commenter' || role === 'editor' || role === 'admin';
  },
});
