/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Presence: a typed wrapper over `y-protocols/awareness`.
 *
 * Spec §5.4 / §7. Awareness is last-write-wins-by-clock and never
 * persisted. Updates are bursty — we cap them at 30 Hz with delta-only
 * payloads.
 */

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { colorForUser } from './color.js';

export interface UserIdentity {
  id: string;
  name: string;
  /** Optional. If omitted, a deterministic color is derived from `id`. */
  color?: string;
  avatar?: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface PresenceState {
  user: UserIdentity;
  cursor3d?: Vec3;
  cursor2d?: { viewport: string; pos: Vec2 };
  selection: string[];
  camera?: CameraState;
  activeView?: string;
  activeSection?: { plane: Vec4 };
  isolated?: string[];
  tool?: 'select' | 'measure' | 'comment' | 'edit' | 'create' | string;
  status: 'active' | 'idle' | 'offline';
  /** Wall-clock ms; used by stale-presence eviction. */
  lastUpdate: number;
  /** Optional model the cursor is currently in (for federated sessions). */
  modelId?: string;
}

export interface PresenceMap {
  /** clientID → state */
  [clientId: number]: PresenceState;
}

export type PresenceUpdateListener = (peers: PresenceMap, self: PresenceState | null) => void;

export interface PresenceOptions {
  /** Awareness update rate cap in Hz (default 30). */
  updateRateHz?: number;
  /** Stale eviction window in ms (default 10_000). */
  staleAfterMs?: number;
}

export interface Presence {
  readonly awareness: Awareness;
  readonly clientId: number;
  setUser(user: UserIdentity): void;
  setSelection(paths: string[]): void;
  setCursor3d(pos: Vec3 | null): void;
  setCursor2d(viewport: string, pos: Vec2 | null): void;
  setCamera(camera: CameraState | null): void;
  setActiveView(viewId: string | null): void;
  setActiveSection(plane: Vec4 | null): void;
  setIsolated(paths: string[] | null): void;
  setTool(tool: PresenceState['tool'] | null): void;
  setStatus(status: PresenceState['status']): void;
  setModelId(modelId: string | null): void;
  /** Patch arbitrary fields in one go. Use for camera+cursor on the same frame. */
  patch(partial: Partial<PresenceState>): void;
  getSelf(): PresenceState | null;
  getPeers(): PresenceMap;
  onUpdate(listener: PresenceUpdateListener): () => void;
  /** Force a stale sweep; normally automatic. */
  evictStale(): void;
  dispose(): void;
}

/** Create a presence object bound to a Y.Doc. */
export function createPresence(doc: Y.Doc, opts: PresenceOptions = {}): Presence {
  const awareness = new Awareness(doc);
  const updateRateMs = 1000 / (opts.updateRateHz ?? 30);
  const staleAfterMs = opts.staleAfterMs ?? 10_000;

  let pendingPatch: Partial<PresenceState> | null = null;
  let flushHandle: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<PresenceUpdateListener>();

  const flush = () => {
    if (!pendingPatch) return;
    const current = (awareness.getLocalState() as PresenceState | null) ?? null;
    const merged: PresenceState = {
      ...(current ?? {
        user: { id: 'anon', name: 'Anonymous', color: '#888888' },
        selection: [],
        status: 'active',
        lastUpdate: Date.now(),
      }),
      ...pendingPatch,
      lastUpdate: Date.now(),
    };
    awareness.setLocalState(merged);
    pendingPatch = null;
    flushHandle = null;
  };

  const enqueue = (patch: Partial<PresenceState>) => {
    pendingPatch = { ...(pendingPatch ?? {}), ...patch };
    if (flushHandle == null) {
      flushHandle = setTimeout(flush, updateRateMs);
    }
  };

  const onAwareness = () => {
    const peers: PresenceMap = {};
    awareness.getStates().forEach((value, clientId) => {
      peers[clientId] = value as PresenceState;
    });
    const self = (awareness.getLocalState() as PresenceState | null) ?? null;
    listeners.forEach((l) => l(peers, self));
  };
  awareness.on('change', onAwareness);

  const evictTimer = setInterval(() => evictStale(), Math.max(staleAfterMs / 2, 2_000));
  const evictStale = () => {
    const now = Date.now();
    const toRemove: number[] = [];
    awareness.getStates().forEach((value, clientId) => {
      const state = value as PresenceState;
      if (clientId === awareness.clientID) return;
      if (state?.lastUpdate && now - state.lastUpdate > staleAfterMs) {
        toRemove.push(clientId);
      }
    });
    if (toRemove.length > 0) {
      removeAwarenessStates(awareness, toRemove, 'stale-eviction');
    }
  };

  return {
    awareness,
    clientId: doc.clientID,
    setUser(user) {
      const resolved: UserIdentity = { ...user, color: user.color ?? colorForUser(user.id) };
      enqueue({ user: resolved });
    },
    setSelection(paths) { enqueue({ selection: paths }); },
    setCursor3d(pos) { enqueue({ cursor3d: pos ?? undefined }); },
    setCursor2d(viewport, pos) {
      enqueue({ cursor2d: pos ? { viewport, pos } : undefined });
    },
    setCamera(camera) { enqueue({ camera: camera ?? undefined }); },
    setActiveView(viewId) { enqueue({ activeView: viewId ?? undefined }); },
    setActiveSection(plane) { enqueue({ activeSection: plane ? { plane } : undefined }); },
    setIsolated(paths) { enqueue({ isolated: paths ?? undefined }); },
    setTool(tool) { enqueue({ tool: tool ?? undefined }); },
    setStatus(status) { enqueue({ status }); },
    setModelId(modelId) { enqueue({ modelId: modelId ?? undefined }); },
    patch(partial) { enqueue(partial); },
    getSelf() { return (awareness.getLocalState() as PresenceState | null) ?? null; },
    getPeers() {
      const peers: PresenceMap = {};
      awareness.getStates().forEach((value, clientId) => {
        peers[clientId] = value as PresenceState;
      });
      return peers;
    },
    onUpdate(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    evictStale,
    dispose() {
      clearInterval(evictTimer);
      if (flushHandle) clearTimeout(flushHandle);
      awareness.off('change', onAwareness);
      awareness.destroy();
      listeners.clear();
    },
  };
}

export { applyAwarenessUpdate, encodeAwarenessUpdate, Awareness };
