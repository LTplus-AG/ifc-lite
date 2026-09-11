/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcAttributeValue, Mutation, NewEntity } from './types.js';

export type EntityOperation =
  | { kind: 'create'; expressId: number; type: string; attributes: IfcAttributeValue[] }
  | { kind: 'setPositionalAttribute'; expressId: number; index: number; value: IfcAttributeValue; skipHistory?: boolean }
  | { kind: 'remove'; expressId: number };

export type EntityOperationEffect =
  | { kind: 'create'; entity: NewEntity }
  | { kind: 'setPositionalAttribute'; expressId: number; index: number; present: boolean; value: IfcAttributeValue | undefined }
  | { kind: 'remove'; expressId: number; entity: NewEntity | null };

export interface EntityPreparationOptions {
  signal?: AbortSignal;
  /** Must yield to a browser/host task, not only a microtask. No draft is passed. */
  yieldTask?: () => Promise<void>;
  /** Cooperative target, not a guarantee for uninterruptible host operations. Default 4ms. */
  maxSliceMs?: number;
  /** Cumulative visited values/entries across all snapshots. Default 16 million. */
  maxWork?: number;
  /** Conservative cumulative allocation accounting; not measured JS heap size. Default 512MiB. */
  maxBytes?: number;
}

export interface PreparedEntityOperations {
  /** Detached caller-owned records; changing these cannot edit publication/checkpoints. */
  readonly effects: readonly EntityOperationEffect[];
  readonly mutations: readonly Mutation[];
  /** Exact synchronous live-overlay AND operation-input fence. Linear in their size. */
  validate(): void;
  commit(): void;
  rollback(): void;
  /** Idempotent. Before commit discards work; after commit relinquishes rollback. */
  dispose(): void;
}
