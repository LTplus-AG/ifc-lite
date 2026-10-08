/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict decoder for durable outbox records. */

import { isRecord, isText } from '../bcf-drafts/draft-codec.js';
import {
  OUTBOX_OPERATIONS, OUTBOX_STATES, type BcfPublication, type OutboxCandidate, type OutboxCheck, type OutboxEntry,
  type OutboxFailure, type OutboxOperation, type OutboxReceipt, type OutboxState,
} from './outbox-types.js';

const FAILURES: ReadonlyArray<OutboxFailure['code']> = ['auth', 'permission', 'vocabulary', 'rejected', 'no-response', 'server-error',
  'conflict-exists', 'interrupted', 'confirmed-absent', 'discarded'];
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const optional = (value: unknown, max: number) => value === undefined || isText(value, max);

function receipt(value: unknown): OutboxReceipt | null {
  if (!isRecord(value) || !isText(value.remoteGuid, 200) || !isText(value.at, 40)
    || !['response', 'lookup', 'user-choice'].includes(String(value.evidence))
    || value.topicActions !== undefined && !strings(value.topicActions)) return null;
  return { remoteGuid: value.remoteGuid, at: value.at, evidence: value.evidence as OutboxReceipt['evidence'],
    ...(value.topicActions ? { topicActions: [...value.topicActions as string[]] } : {}) };
}

function failure(value: unknown): OutboxFailure | null {
  if (!isRecord(value) || !FAILURES.includes(value.code as OutboxFailure['code']) || !isText(value.message, 2_000, true)
    || !isText(value.at, 40) || value.status !== undefined && !Number.isSafeInteger(value.status)) return null;
  return { code: value.code as OutboxFailure['code'], message: value.message, at: value.at,
    ...(value.status !== undefined ? { status: value.status as number } : {}) };
}

function candidate(value: unknown): OutboxCandidate | null {
  if (!isRecord(value) || !isText(value.guid, 200) || !optional(value.title, 500) || !optional(value.author, 500) || !optional(value.date, 60)) return null;
  return { guid: value.guid, ...(value.title !== undefined ? { title: value.title as string } : {}),
    ...(value.author !== undefined ? { author: value.author as string } : {}), ...(value.date !== undefined ? { date: value.date as string } : {}) };
}

function check(value: unknown): OutboxCheck | null {
  if (!isRecord(value) || !isText(value.at, 40) || !['committed', 'absent', 'ambiguous', 'unavailable'].includes(String(value.result))
    || !Array.isArray(value.candidates) || value.candidates.length > 50 || !optional(value.note, 2_000)) return null;
  const candidates = value.candidates.map(candidate);
  if (candidates.some(item => !item)) return null;
  return { at: value.at, result: value.result as OutboxCheck['result'], candidates: candidates.flatMap(item => item ? [item] : []),
    ...(value.note !== undefined ? { note: value.note as string } : {}) };
}

export function decodeEntry(value: unknown): OutboxEntry | null {
  if (!isRecord(value) || !isText(value.id, 200) || !OUTBOX_OPERATIONS.includes(value.operation as OutboxOperation)
    || !isText(value.topicGuid, 200, true) || !optional(value.remoteTopicGuid, 200) || !optional(value.dependsOn, 200)
    || !optional(value.subject, 200) || !isRecord(value.payload) || !isText(value.digest, 100)
    || !OUTBOX_STATES.includes(value.state as OutboxState) || !Number.isSafeInteger(value.attempts) || !isText(value.queuedAt, 40)
    || !optional(value.sentAt, 40) || value.force !== undefined && typeof value.force !== 'boolean'
    || value.blocked !== undefined && value.blocked !== 'imported' && value.blocked !== 'remote-conflict'
    || value.baseline !== undefined && !isRecord(value.baseline)) return null;
  const decodedReceipt = value.receipt === undefined ? undefined : receipt(value.receipt);
  const decodedFailure = value.failure === undefined ? undefined : failure(value.failure);
  const decodedCheck = value.check === undefined ? undefined : check(value.check);
  if (decodedReceipt === null || decodedFailure === null || decodedCheck === null) return null;
  const state = value.state as OutboxState;
  // State and evidence must agree: a done entry always has its receipt, a blocked one its reason.
  if (state === 'done' && !decodedReceipt || state === 'blocked' && !value.blocked || (state === 'failed' || state === 'uncertain') && !decodedFailure) return null;
  return {
    id: value.id, operation: value.operation as OutboxOperation, topicGuid: value.topicGuid as string,
    ...(value.remoteTopicGuid !== undefined ? { remoteTopicGuid: value.remoteTopicGuid as string } : {}),
    ...(value.dependsOn !== undefined ? { dependsOn: value.dependsOn as string } : {}),
    ...(value.subject !== undefined ? { subject: value.subject as string } : {}),
    payload: JSON.parse(JSON.stringify(value.payload)) as Record<string, unknown>, digest: value.digest, state,
    attempts: value.attempts as number, queuedAt: value.queuedAt,
    ...(value.sentAt !== undefined ? { sentAt: value.sentAt as string } : {}),
    ...(decodedReceipt ? { receipt: decodedReceipt } : {}), ...(decodedFailure ? { failure: decodedFailure } : {}),
    ...(value.blocked !== undefined ? { blocked: value.blocked } : {}), ...(decodedCheck ? { check: decodedCheck } : {}),
    ...(value.force !== undefined ? { force: value.force } : {}),
    ...(value.baseline !== undefined ? { baseline: JSON.parse(JSON.stringify(value.baseline)) as Record<string, unknown> } : {}),
  };
}

export function decodePublication(value: unknown): BcfPublication | null {
  if (!isRecord(value) || value.version !== 1 || !isText(value.id, 200) || (value.origin !== 'draft' && value.origin !== 'flow')
    || !optional(value.batchId, 200) || !optional(value.batchName, 200) || !isRecord(value.target)
    || !isText(value.target.serverUrl, 2_000) || !isText(value.target.projectId, 500) || !optional(value.target.projectName, 500)
    || !isText(value.target.userId, 500, true) || !isText(value.createdAt, 40) || !isText(value.updatedAt, 40)
    || !Array.isArray(value.entries) || value.entries.length > 20_000
    || value.imported !== undefined && typeof value.imported !== 'boolean') return null;
  const entries = value.entries.map(decodeEntry);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || ids.has(entry.id)) return null;
    ids.add(entry.id);
  }
  const target = value.target;
  return {
    version: 1, id: value.id, origin: value.origin,
    ...(value.batchId !== undefined ? { batchId: value.batchId as string } : {}),
    ...(value.batchName !== undefined ? { batchName: value.batchName as string } : {}),
    target: { serverUrl: target.serverUrl as string, projectId: target.projectId as string,
      ...(target.projectName !== undefined ? { projectName: target.projectName as string } : {}), userId: target.userId as string },
    createdAt: value.createdAt, updatedAt: value.updatedAt, entries: entries.flatMap(entry => entry ? [entry] : []),
    ...(value.imported !== undefined ? { imported: value.imported } : {}),
  };
}
