/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * FederationSession (spec §10).
 *
 * A federated project is N model rooms (one Y.Doc each) plus one
 * `_federation` Y.Doc that holds cross-model relationships, BCF topic
 * refs, and federation-level views.
 *
 * This class composes existing per-model `CollabSession`s. Presence is
 * project-scoped: a single awareness channel — backed by the
 * `_federation` doc — broadcasts cursors and selections across every
 * model. That's the §10.2 contract.
 *
 * The FederationSession does NOT reinvent the existing
 * `FederationRegistry` (per `AGENTS.md` §4) — it stores cross-model
 * references as `{ modelId, globalId }` pairs and asks the registry to
 * resolve them upstream.
 */

import * as Y from 'yjs';
import {
  createCollabSession,
  type CollabSession,
  type CollabSessionOptions,
  type ProviderKind,
} from '../session.js';
import { createPresence, type Presence, type UserIdentity } from '../awareness/presence.js';
import { createCollabDoc } from '../doc/schema.js';
import { federationRoomId, roomIdFor } from '../sync/room.js';

export interface FederationSessionOptions {
  projectId: string;
  user: UserIdentity;
  /** Initial set of models to load. More can be added later via `addModel`. */
  models: string[];
  provider?: ProviderKind;
  serverUrl?: string;
  token?: string;
  WebSocketPolyfill?: unknown;
  /** Forwarded to every per-model session. */
  presence?: CollabSessionOptions['presence'];
}

/**
 * A single cross-model record in `_federation`. Stored as plain JSON
 * inside a Y.Map so concurrent edits to the same record's fields merge
 * via LWW per field.
 */
export interface FederationRecord {
  /** Stable cross-model record ID. */
  recordId: string;
  /** 'clash', 'rfi', 'view', 'comment', custom… */
  type: string;
  refs: Array<{ modelId: string; globalId: string }>;
  /** Resolution status (free-form; common values: 'open' | 'discussed' | 'resolved'). */
  resolution?: string;
  /** BCF topic ID, if any. */
  bcfTopicId?: string;
  /** Free-form metadata. */
  meta?: Record<string, unknown>;
}

export interface FederationSession {
  readonly projectId: string;
  readonly federationDoc: Y.Doc;
  readonly federationRoomId: string;
  readonly presence: Presence;
  readonly user: UserIdentity;
  /** Per-model sessions keyed by modelId. */
  readonly models: ReadonlyMap<string, CollabSession>;

  /** Add a model to the session. Idempotent. */
  addModel(modelId: string): Promise<CollabSession>;
  /** Remove a model from the session and dispose its resources. */
  removeModel(modelId: string): Promise<void>;
  /** All loaded model IDs. */
  modelIds(): string[];

  /* Cross-model record API (records live in the `_federation` Y.Doc). */
  upsertRecord(record: FederationRecord): void;
  getRecord(recordId: string): FederationRecord | undefined;
  removeRecord(recordId: string): boolean;
  listRecords(): FederationRecord[];
  observeRecords(listener: (records: FederationRecord[]) => void): () => void;

  /** Resolves once every loaded session has finished its initial sync. */
  whenSynced(): Promise<void>;
  dispose(): Promise<void>;
}

const RECORDS_KEY = 'records';

/** Build a federation session and pre-load `models`. */
export async function createFederationSession(
  opts: FederationSessionOptions,
): Promise<FederationSession> {
  // The federation Y.Doc holds cross-model state and acts as the host
  // for project-scoped presence (§10.2).
  const federationDoc = createCollabDoc({ gc: true });
  const fedRoomId = federationRoomId(opts.projectId);

  const presence = createPresence(federationDoc, opts.presence ?? {});
  presence.setUser(opts.user);
  presence.setStatus('active');

  const recordsMap = federationDoc.getMap<FederationRecord>(RECORDS_KEY);

  const models = new Map<string, CollabSession>();

  async function loadModel(modelId: string): Promise<CollabSession> {
    const existing = models.get(modelId);
    if (existing) return existing;
    const session = await createCollabSession({
      roomId: roomIdFor({ projectId: opts.projectId, modelId }),
      user: opts.user,
      provider: opts.provider,
      serverUrl: opts.serverUrl,
      token: opts.token,
      WebSocketPolyfill: opts.WebSocketPolyfill,
      presence: opts.presence,
    });
    models.set(modelId, session);
    return session;
  }

  // Bootstrap the federation room itself if a websocket provider was
  // requested — share the same provider stack as model rooms.
  let federationCarrier: CollabSession | null = null;
  if (opts.provider && opts.provider !== 'memory') {
    federationCarrier = await createCollabSession({
      roomId: fedRoomId,
      user: opts.user,
      provider: opts.provider,
      serverUrl: opts.serverUrl,
      token: opts.token,
      WebSocketPolyfill: opts.WebSocketPolyfill,
      doc: federationDoc,
      presence: opts.presence,
    });
  }

  function listRecords(): FederationRecord[] {
    const out: FederationRecord[] = [];
    recordsMap.forEach((v) => out.push(cloneRecord(v)));
    return out;
  }

  await Promise.all(opts.models.map(loadModel));

  return {
    projectId: opts.projectId,
    federationDoc,
    federationRoomId: fedRoomId,
    presence,
    user: opts.user,
    models,

    async addModel(modelId: string) {
      return loadModel(modelId);
    },

    async removeModel(modelId: string) {
      const session = models.get(modelId);
      if (!session) return;
      session.dispose();
      models.delete(modelId);
    },

    modelIds: () => Array.from(models.keys()),

    upsertRecord(record: FederationRecord) {
      federationDoc.transact(() => {
        recordsMap.set(record.recordId, sanitiseRecord(record));
      });
    },

    getRecord(recordId: string) {
      const v = recordsMap.get(recordId);
      return v ? cloneRecord(v) : undefined;
    },

    removeRecord(recordId: string) {
      if (!recordsMap.has(recordId)) return false;
      recordsMap.delete(recordId);
      return true;
    },

    listRecords: listRecords,

    observeRecords(listener) {
      const fn = () => listener(listRecords());
      recordsMap.observeDeep(fn);
      return () => recordsMap.unobserveDeep(fn);
    },

    async whenSynced() {
      const synced = Array.from(models.values()).map((s) => s.whenSynced);
      if (federationCarrier) synced.push(federationCarrier.whenSynced);
      await Promise.all(synced);
    },

    async dispose() {
      for (const session of models.values()) session.dispose();
      models.clear();
      if (federationCarrier) federationCarrier.dispose();
      else presence.dispose();
    },
  };
}

function sanitiseRecord(r: FederationRecord): FederationRecord {
  return {
    recordId: r.recordId,
    type: r.type,
    refs: r.refs.map((ref) => ({ modelId: ref.modelId, globalId: ref.globalId })),
    resolution: r.resolution,
    bcfTopicId: r.bcfTopicId,
    meta: r.meta ? { ...r.meta } : undefined,
  };
}

function cloneRecord(r: FederationRecord): FederationRecord {
  return sanitiseRecord(r);
}
