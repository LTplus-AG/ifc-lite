/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Durable BCF publication outbox (#6896, P12).
 *
 * One record per (draft batch or Flow, server, project) holds an entry per
 * remote effect. Entry states:
 *
 *   queued ──► sending ──► done        (server receipt, or reconciled lookup)
 *                     ├──► failed      (definite: an HTTP refusal, nothing applied)
 *                     └──► uncertain   (no answer after dispatch: may have applied)
 *   blocked             (imported from a backup, or a remote edit conflicts with an update)
 *
 * `sending` is persisted BEFORE the request leaves; an entry found `sending`
 * after a reload is therefore `uncertain`. `uncertain` and `blocked` never
 * dispatch again automatically, and neither do entries depending on them;
 * only an explicit server check (or a definite receipt) moves them on.
 */

export type OutboxOperation = 'createTopic' | 'updateTopic' | 'createComment' | 'createViewpoint';
export type OutboxState = 'queued' | 'sending' | 'done' | 'failed' | 'uncertain' | 'blocked';
export type OutboxBlock = 'imported' | 'remote-conflict';

export interface OutboxReceipt {
  /** Server GUID of the created/updated topic, comment or viewpoint. */
  remoteGuid: string;
  at: string;
  /** How the effect is known: the write's own response, a server lookup, or a coordinator choice among lookup candidates. */
  evidence: 'response' | 'lookup' | 'user-choice';
  /** `authorization.topic_actions` the server reported for a created topic. */
  topicActions?: string[];
}

export interface OutboxFailure {
  code: 'auth' | 'permission' | 'vocabulary' | 'rejected' | 'no-response' | 'server-error' | 'conflict-exists'
    | 'interrupted' | 'confirmed-absent' | 'discarded';
  message: string;
  status?: number;
  at: string;
}

export interface OutboxCandidate {
  guid: string;
  title?: string;
  author?: string;
  date?: string;
}

/** Result of an explicit "check server" for an uncertain or imported entry. */
export interface OutboxCheck {
  at: string;
  result: 'committed' | 'absent' | 'ambiguous' | 'unavailable';
  candidates: OutboxCandidate[];
  note?: string;
}

export interface OutboxEntry {
  id: string;
  operation: OutboxOperation;
  /** Local draft topic GUID; empty for a Flow topic create. */
  topicGuid: string;
  /** Server topic GUID known when the entry was queued (Flow comments, updates). */
  remoteTopicGuid?: string;
  /** Entry whose receipt supplies the server topic GUID. */
  dependsOn?: string;
  /** Draft comment id or viewpoint GUID this entry publishes. */
  subject?: string;
  /** The exact request body, frozen when queued. */
  payload: Record<string, unknown>;
  /** Connector + project + effect + payload identity; equal digests are the same intended write. */
  digest: string;
  state: OutboxState;
  attempts: number;
  queuedAt: string;
  sentAt?: string;
  receipt?: OutboxReceipt;
  failure?: OutboxFailure;
  blocked?: OutboxBlock;
  check?: OutboxCheck;
  /** An update the coordinator chose to apply over a conflicting remote edit. */
  force?: boolean;
  /** Owned topic fields as last confirmed on the server, for update conflict checks. */
  baseline?: Record<string, unknown>;
}

export interface PublicationTarget {
  /** Normalised BCF API base URL. */
  serverUrl: string;
  projectId: string;
  projectName?: string;
  /** Signed-in user id at planning time; empty when unknown (Flow). */
  userId: string;
}

export interface BcfPublication {
  version: 1;
  id: string;
  origin: 'draft' | 'flow';
  batchId?: string;
  batchName?: string;
  target: PublicationTarget;
  createdAt: string;
  updatedAt: string;
  entries: OutboxEntry[];
  /** Set when the record arrived through a library backup import. */
  imported?: boolean;
}

export const OUTBOX_STATES: readonly OutboxState[] = ['queued', 'sending', 'done', 'failed', 'uncertain', 'blocked'];
export const OUTBOX_OPERATIONS: readonly OutboxOperation[] = ['createTopic', 'updateTopic', 'createComment', 'createViewpoint'];
