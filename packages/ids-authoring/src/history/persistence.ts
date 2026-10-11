/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence boundary for Studio documents and their history.
 *
 * This package ships only the adapter INTERFACE and an in-memory adapter
 * (tests, CLI, server-side sessions). The viewer provides the IndexedDB
 * implementation (FR-A03); nothing here touches browser storage.
 *
 * Adapters store `PersistedStudioState`, a plain-JSON snapshot. Loading
 * validates the format tag and the node-index invariant, so a corrupt or
 * foreign record is refused instead of producing a document whose ids no
 * longer line up.
 */

import { verifyNodeIndex } from '../document/node-index.js';
import { STUDIO_SCHEMA_VERSION } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import type { History, StudioState } from './history.js';

export const PERSISTED_FORMAT = 'ifc-lite.ids-studio.state';

export interface PersistedStudioState {
  format: typeof PERSISTED_FORMAT;
  version: typeof STUDIO_SCHEMA_VERSION;
  savedAt: string;
  state: StudioState;
}

export interface PersistedSummary {
  docId: Uuid;
  title: string;
  savedAt: string;
}

export interface PersistenceAdapter {
  load(docId: Uuid): Promise<PersistedStudioState | undefined>;
  save(snapshot: PersistedStudioState): Promise<void>;
  remove(docId: Uuid): Promise<void>;
  list(): Promise<PersistedSummary[]>;
}

export function toPersisted(state: StudioState, savedAt: string = new Date().toISOString()): PersistedStudioState {
  return { format: PERSISTED_FORMAT, version: STUDIO_SCHEMA_VERSION, savedAt, state };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isHistory(v: unknown): v is History {
  return isRecord(v) && Array.isArray(v.past) && Array.isArray(v.future);
}

/**
 * Validate an untrusted persisted record and return its state. Throws an
 * `Error` naming the first problem.
 */
export function fromPersisted(value: unknown): StudioState {
  if (!isRecord(value) || value.format !== PERSISTED_FORMAT) throw new Error('not an IDS Studio state record');
  if (value.version !== STUDIO_SCHEMA_VERSION) throw new Error(`unsupported IDS Studio state version ${String(value.version)}`);
  const state = value.state;
  if (!isRecord(state) || !isRecord(state.doc) || !isHistory(state.history)) throw new Error('IDS Studio state record is incomplete');
  const restored = state as unknown as StudioState;
  const problems = verifyNodeIndex(restored.doc);
  if (problems.length) throw new Error(`IDS Studio state has an inconsistent node index: ${problems[0]}`);
  return restored;
}

/**
 * In-memory adapter. Records round-trip through JSON, exactly like a real
 * store, so what loads is never the object that was saved.
 */
export function createMemoryPersistenceAdapter(): PersistenceAdapter {
  const records = new Map<Uuid, string>();
  return {
    async load(docId) {
      const json = records.get(docId);
      return json === undefined ? undefined : (JSON.parse(json) as PersistedStudioState);
    },
    async save(snapshot) {
      records.set(snapshot.state.doc.docId, JSON.stringify(snapshot));
    },
    async remove(docId) {
      records.delete(docId);
    },
    async list() {
      return [...records.values()].map((json) => {
        const s = JSON.parse(json) as PersistedStudioState;
        return { docId: s.state.doc.docId, title: s.state.doc.ids.info.title, savedAt: s.savedAt };
      });
    },
  };
}
