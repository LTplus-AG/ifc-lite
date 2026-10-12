/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { normalizeBcfBaseUrl } from '@ifc-lite/bcf-api';
import type { BcfWriteIntent } from './bcf-write-gateway.js';
import type { StoredBcfAttempt, StoredBcfCheck, StoredBcfOutcome } from './bcf-publication-types.js';

export const MAX_RECORD_BYTES = 256 * 1024;
export const MAX_GENERATIONS = 256;
export const MAX_RECORDS = 4 * MAX_GENERATIONS;
export const MAX_CHECKS = 16;
const TOPIC_FIELDS = ['title', 'topic_type', 'topic_status', 'priority', 'labels', 'assigned_to', 'stage', 'description', 'due_date'];
const COMMENT_FIELDS = ['comment', 'viewpoint_guid', 'reply_to_comment_guid'];
// These are protocol keys, not user credential data. Context-specific decoders
// still reject a known key appearing in the wrong record/payload location.
const SCHEMA_KEYS = new Set([...TOPIC_FIELDS, ...COMMENT_FIELDS,
  'nodeType', 'operation', 'baseUrl', 'version', 'projectId', 'topicGuid', 'payload', 'intent',
  'id', 'digest', 'generation', 'queuedAt', 'owner', 'pid', 'host', 'boot', 'domain', 'instance',
  'state', 'receipt', 'remoteGuid', 'at', 'evidence', 'failure', 'code', 'message', 'status',
  'checkId', 'check', 'result', 'candidates', 'fullReadAccessConfirmed', 'guid', 'candidateGuid', 'settlement', 'outcome', 'proofCheckId',
  'assertion', 'epoch', 'previous', 'attempt', 'checks', 'checkPending', 'reconciled', 'ownerStatus', 'ownerConfirmed']);
const FAILURES = ['auth', 'permission', 'rejected', 'no-response', 'server-error', 'conflict-exists', 'interrupted'];
/** Shared construction/decoding values; the representability guard must not drift from saved records. */
export const NATIVE_METADATA = {
  state: { done: 'done', failed: 'failed', uncertain: 'uncertain', sending: 'sending' },
  evidence: { response: 'response', reconciled: 'reconciled' },
  check: { absent: 'absent', ambiguous: 'ambiguous', unavailable: 'unavailable' },
  owner: { alive: 'alive', dead: 'dead', unknown: 'unknown' },
  fullReadAccessConfirmed: true,
  assertion: 'owner-stopped', confirmedAbsent: 'confirmed-absent', failures: FAILURES,
  message: { refused: 'The request was refused without a confirmed effect.',
    unknown: 'The server outcome is unknown; check before sending again.',
    absent: 'Explicitly confirmed absent after a successful server check.' },
} as const;
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 20_000;
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
export function refuse(message: string): never { throw new Error(`BCF publication refused: ${message}`); }
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Stable object-key ordering; arrays retain their intentional order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function credentialFree(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  if (/authorization\s*:\s*bearer\s+|"Bearer (?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}"|[?&](?:access_token|token|password|secret)=|"(?:authorization|password|access_token|token|secret)"\s*:/i.test(serialized)
  ) refuse('credentials must not enter durable state');
  const sensitive = secrets.filter(secret => secret.length > 0).map(secret => JSON.stringify(secret).slice(1, -1));
  if (!sensitive.length) return;
  const reject = (item: unknown) => {
    const encoded = JSON.stringify(item);
    if (encoded !== undefined && sensitive.some(secret => encoded.includes(secret))) refuse('credentials must not enter durable state');
  };
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const field of item) pending.push(field); }
    else if (record(item)) {
      for (const [key, field] of Object.entries(item)) {
        if (!SCHEMA_KEYS.has(key)) reject(key);
        pending.push(field);
      }
    } else reject(item);
  }
}

/** Refuse an unrepresentable bearer before effect, never success followed by unreadable generated metadata. */
export function assertNativeRepresentable(secrets: readonly string[]): void {
  credentialFree([...Object.values(NATIVE_METADATA.state), ...Object.values(NATIVE_METADATA.evidence),
    ...Object.values(NATIVE_METADATA.check), ...Object.values(NATIVE_METADATA.owner), ...NATIVE_METADATA.failures,
    NATIVE_METADATA.assertion, NATIVE_METADATA.fullReadAccessConfirmed, NATIVE_METADATA.confirmedAbsent, ...Object.values(NATIVE_METADATA.message)], secrets);
}

function validatePayload(value: unknown, comment: boolean): asserts value is BcfWriteIntent['payload'] {
  if (!record(value)) refuse('invalid write payload');
  const allowed = comment ? COMMENT_FIELDS : TOPIC_FIELDS;
  if (Object.keys(value).some(k => !allowed.includes(k)) || !text(value[comment ? 'comment' : 'title'])) refuse('invalid write payload');
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    if (key === 'labels') {
      if (!Array.isArray(item) || item.length > 500 || !item.every(v => typeof v === 'string' && v.length <= 20_000)) refuse('invalid labels');
    } else if (typeof item !== 'string' || item.length > 20_000) refuse('invalid payload field');
  }
}

export function normalizeIntent(value: unknown, secrets: readonly string[] = []): BcfWriteIntent {
  if (!record(value) || !text(value.nodeType) || !text(value.baseUrl) || !text(value.version) || !text(value.projectId)
    || !['createTopic', 'createComment'].includes(String(value.operation)) || !record(value.payload)) refuse('invalid intent');
  const keys = ['nodeType', 'operation', 'baseUrl', 'version', 'projectId', 'topicGuid', 'payload'];
  if (Object.keys(value).some(k => !keys.includes(k))) refuse('unknown intent fields');
  let url: URL;
  try { url = new URL(value.baseUrl); } catch { refuse('invalid server URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) refuse('server URL must be credential-free HTTPS');
  if (!/^[A-Za-z0-9.-]{1,32}$/.test(value.version)) refuse('invalid API version');
  const comment = value.operation === 'createComment';
  if (value.nodeType !== (comment ? 'bcf.addComment' : 'bcf.createTopic')) refuse('node and operation disagree');
  if (comment ? !text(value.topicGuid) : value.topicGuid !== undefined) refuse('invalid topic target');
  validatePayload(value.payload, comment);
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value.payload); } catch { refuse('invalid write payload'); }
  if (serialized === undefined) refuse('invalid write payload');
  if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES / 2) refuse('intent exceeds storage bound');
  let payload: unknown;
  try { payload = JSON.parse(serialized); } catch { refuse('invalid write payload'); }
  validatePayload(payload, comment);
  // Custom serialization errors must not expose their message/cause to callers.
  try { credentialFree(value, secrets); } catch { refuse('credentials must not enter durable state'); }
  // Canonical identity must match the exact JSON schema persisted on disk.
  // Spreading an own undefined optional key hashes data that JSON omits.
  const normalized: BcfWriteIntent = { nodeType: value.nodeType, operation: comment ? 'createComment' : 'createTopic',
    baseUrl: normalizeBcfBaseUrl(value.baseUrl), version: value.version, projectId: value.projectId,
    ...(comment && text(value.topicGuid) ? { topicGuid: value.topicGuid } : {}),
    payload };
  credentialFree(normalized, secrets);
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_RECORD_BYTES / 2) refuse('intent exceeds storage bound');
  return normalized;
}
export function intentDigest(intent: BcfWriteIntent): string {
  const { nodeType: _nodeType, ...effect } = intent;
  return hash(canonical(effect));
}
export function decodeAttempt(value: unknown, filename: string): StoredBcfAttempt {
  if (!record(value) || value.version !== 1 || !text(value.id) || !text(value.digest) || !Number.isSafeInteger(value.generation)
    || Number(value.generation) < 1 || !date(value.queuedAt) || !record(value.owner) || !Number.isSafeInteger(value.owner.pid)
    || Number(value.owner.pid) < 1 || !text(value.owner.host) || !/^[a-f0-9]{64}$/.test(value.owner.host)
    || Object.keys(value.owner).some(k => !['pid', 'host', 'boot', 'domain', 'instance'].includes(k))) refuse('malformed attempt');
  const owner = value.owner;
  if (['boot', 'domain', 'instance'].some(k => owner[k] !== undefined)
    && !['boot', 'domain', 'instance'].every(k => typeof owner[k] === 'string' && /^[a-f0-9]{64}$/.test(owner[k]))) refuse('incomplete owner identity');
  const intent = normalizeIntent(value.intent);
  if (canonical(value.intent) !== canonical(intent) || value.digest !== intentDigest(intent)
    || value.id !== `${value.digest}-${value.generation}` || filename !== `${value.id}.intent.json`) refuse('attempt identity mismatch');
  if (Object.keys(value).some(k => !['version', 'id', 'digest', 'generation', 'intent', 'queuedAt', 'owner'].includes(k))) refuse('unknown attempt fields');
  return value as unknown as StoredBcfAttempt;
}
export function decodeOutcome(value: unknown, attempt: StoredBcfAttempt, checked = false): StoredBcfOutcome {
  if (!record(value) || value.version !== 1 || value.id !== attempt.id || value.digest !== attempt.digest
    || !['done', 'failed', 'uncertain'].includes(String(value.state))) refuse('malformed outcome');
  if (Object.keys(value).some(k => !['version', 'id', 'digest', 'state', 'receipt', 'failure'].includes(k))) refuse('unknown outcome fields');
  if (value.state === 'done') {
    const r = value.receipt;
    if (value.failure !== undefined || !record(r) || !text(r.remoteGuid) || !date(r.at)
      || !['response', 'reconciled'].includes(String(r.evidence)) || (!checked && r.evidence !== 'response')
      || Object.keys(r).some(k => !['remoteGuid', 'at', 'evidence'].includes(k))) refuse('invalid receipt');
  } else {
    const f = value.failure;
    if (value.receipt !== undefined || !record(f) || !(FAILURES.includes(String(f.code)) || (checked && f.code === 'confirmed-absent')) || !text(f.message) || !date(f.at)
      || (f.status !== undefined && (!Number.isInteger(f.status) || Number(f.status) < 0 || Number(f.status) > 599))
      || Object.keys(f).some(k => !['code', 'message', 'at', 'status'].includes(k))) refuse('invalid failure');
  }
  if (value.state === 'failed' && record(value.failure) && !['auth', 'permission', 'rejected', ...(checked ? ['confirmed-absent'] : [])].includes(String(value.failure.code))) refuse('uncertain failure marked definite');
  if (value.state === 'uncertain' && record(value.failure) && !['no-response', 'server-error', 'conflict-exists', 'interrupted'].includes(String(value.failure.code))) refuse('definite failure marked uncertain');
  if (record(value.failure)) {
    const { code, status } = value.failure;
    if ((code === 'auth' && status !== 401) || (code === 'permission' && status !== undefined && status !== 403)
      || (code === 'server-error' && (typeof status !== 'number' || status < 500))
      || (code === 'conflict-exists' && status !== 409)
      || (code === 'rejected' && (typeof status !== 'number' || status < 400 || status >= 500 || [401, 403, 409].includes(status)))
      || (['no-response', 'interrupted', 'confirmed-absent'].includes(String(code)) && status !== undefined && status !== 0)) refuse('failure status contradicts classification');
  }
  credentialFree(value, []);
  return value as unknown as StoredBcfOutcome;
}
export function decodeCheck(value: unknown, attempt: StoredBcfAttempt, filename: string): StoredBcfCheck {
  if (!record(value) || value.version !== 1 || value.id !== attempt.id || value.digest !== attempt.digest || !text(value.checkId)
    || !/^[1-9][0-9]{0,15}$/.test(value.checkId) || !Number.isSafeInteger(Number(value.checkId)) || (filename !== `${attempt.id}.check-${value.checkId}.json` && filename !== `${attempt.id}.checked-${value.checkId}.json`) || !record(value.check)) refuse('malformed check');
  const c = value.check;
  if (!date(c.at) || !['absent', 'ambiguous', 'unavailable'].includes(String(c.result)) || !Array.isArray(c.candidates)
    || c.candidates.length > 50 || !c.candidates.every(v => record(v) && text(v.guid) && Object.keys(v).length === 1)
    || (c.result !== 'ambiguous' && c.candidates.length > 0)
    || (c.fullReadAccessConfirmed !== undefined && (c.fullReadAccessConfirmed !== true || c.result !== 'absent'))
    || Object.keys(c).some(k => !['at', 'result', 'candidates', 'fullReadAccessConfirmed'].includes(k))
    || Object.keys(value).some(k => !['version', 'id', 'digest', 'checkId', 'check', 'settlement'].includes(k))) refuse('invalid checked candidates');
  if (value.settlement !== undefined) {
    const settled = value.settlement;
    if (!record(settled) || !text(settled.proofCheckId) || Object.keys(settled).some(k => !['outcome', 'proofCheckId'].includes(k))) refuse('malformed settlement');
    const outcome = decodeOutcome(settled.outcome, attempt, true);
    if (!(outcome.state === 'done' && outcome.receipt?.evidence === 'reconciled')
      && !(outcome.state === 'failed' && outcome.failure?.code === 'confirmed-absent')) refuse('invalid settlement receipt');
    if (filename.includes('.checked-')) refuse('check response cannot settle an intent');
  } else if (filename.includes('.check-') && (c.result !== 'unavailable' || c.candidates.length)) refuse('check reservation must be unavailable');
  credentialFree(value, []);
  return value as unknown as StoredBcfCheck;
}
