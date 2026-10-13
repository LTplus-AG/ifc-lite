/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import process from 'node:process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyWriteError } from './bcf-publication.js';
import { assertNativeRepresentable, credentialFree, hash, intentDigest, MAX_CHECKS, MAX_GENERATIONS, NATIVE_METADATA, normalizeIntent, refuse, text } from './bcf-publication-codec.js';
import { lookupNativeBcfAttempt } from './bcf-publication-check.js';
import { BcfPublicationStore, entryOf, type LoadedAttempt } from './bcf-publication-store.js';
import { currentOwner } from './bcf-publication-owner.js';
import type { BcfWriteIntent } from './bcf-write-gateway.js';
import type {
  NativeBcfPublicationOptions, NativeBcfWriteGateway, StoredBcfAttempt, StoredBcfCheck, StoredBcfOutcome,
} from './bcf-publication-types.js';

const active = new Set<string>();
// send has finished locally, even if persisting its outcome failed. Other processes remain conservative.
const finished = new Set<string>();
let reservations = 0;
async function reserved<T>(send: () => Promise<T>): Promise<T> {
  if (reservations + finished.size >= 64) refuse('local unsettled-send limit reached; recover completed sends before creating more');
  reservations += 1;
  try { return await send(); } finally { reservations -= 1; }
}

/** Durable native gateway. An interrupted immutable intent is never automatically retried. */
export function createNativeBcfWriteGateway(options: NativeBcfPublicationOptions = {}): NativeBcfWriteGateway {
  const configured = options.directory ?? (process.env.IFCLITE_BCF_OUTBOX_DIR || undefined);
  const root = resolve(configured ?? join(homedir(), '.ifc-lite', 'bcf-outbox'));
  const store = new BcfPublicationStore(join(root, hash(options.namespace ?? 'local')));
  const secrets = options.secrets ?? [];
  const key = (id: string) => `${store.directory}/${id}`;
  function publicEntry(item: LoadedAttempt) {
    if (item.outcome || item.reconciled) finished.delete(key(item.attempt.id));
    return entryOf(item, finished.has(key(item.attempt.id)));
  }
  async function all(digest: string, targetId?: string): Promise<LoadedAttempt[]> {
    const items = await store.load(digest, targetId, secrets);
    for (const item of items) { credentialFree(item, secrets); if (item.outcome || item.reconciled) finished.delete(key(item.attempt.id)); }
    return items;
  }
  async function loaded(id: string): Promise<LoadedAttempt> {
    if (!/^[a-f0-9]{64}-[1-9][0-9]*$/.test(id)) refuse('invalid entry id');
    const found = (await all(id.slice(0, 64), id)).find(item => item.attempt.id === id);
    if (!found) refuse('unknown publication entry');
    return found;
  }
  function recoverable(item: LoadedAttempt): void {
    if (item.reconciled || item.outcome?.state === 'done' || item.outcome?.state === 'failed') refuse('entry is already settled');
    if (active.has(key(item.attempt.id))) refuse('write owner is still active');
    if (!item.outcome && !finished.has(key(item.attempt.id))) {
      if (item.ownerStatus === 'alive') refuse('write owner is still active');
      if (item.ownerStatus === 'unknown' && !item.ownerConfirmed) refuse('write owner is unknown; confirm it stopped before checking');
    }
  }
  async function page(pageOptions?: Parameters<NativeBcfWriteGateway['listPage']>[0]) {
    const result = await store.page(pageOptions, secrets);
    return { ...result, entries: result.entries.map(entry => {
      if (entry.receipt || entry.failure) finished.delete(key(entry.id));
      return entry.state === 'sending' && finished.has(key(entry.id)) ? { ...entry, state: NATIVE_METADATA.state.uncertain } : entry;
    }) };
  }
  return {
    async write<T extends { guid: string }>(input: BcfWriteIntent, send: () => Promise<T>, ephemeralSecrets: readonly string[] = []): Promise<T> {
      const sensitive = [...secrets, ...ephemeralSecrets];
      const intent = normalizeIntent(input, sensitive);
      assertNativeRepresentable(sensitive);
      return reserved(async () => {
        const digest = intentDigest(intent);
        const existing = await all(digest);
        for (const item of existing) credentialFree(item, sensitive);
        const current = existing.filter(item => item.attempt.digest === digest).at(-1);
        if (current && !['done', 'failed'].includes(publicEntry(current).state)) {
          refuse(`identical earlier write ${current.attempt.id} has an unknown outcome; check and reconcile it before running again`);
        }
        const generation = (current?.attempt.generation ?? 0) + 1;
        if (generation > MAX_GENERATIONS) refuse('per-intent generation limit reached; existing receipts remain recoverable');
        const id = `${digest}-${generation}`;
        const attempt: StoredBcfAttempt = { version: 1, id, digest, generation, intent, queuedAt: new Date().toISOString(),
          owner: await currentOwner() };
        // Only our successful exclusive link can own this local activity key.
        // Following directory-fsync failure still leaves a recoverable visible intent.
        let linkedOwned = false;
        let outcomeSaved = false;
        try {
          await store.publish(`${id}.intent.json`, attempt, sensitive, () => {
            linkedOwned = true;
            active.add(key(id));
          });
          let result: T;
          try {
            result = await send();
            if (!result || typeof result !== 'object') refuse('server returned an invalid receipt');
            const representations = sensitive.filter(secret => secret.length > 0)
              .flatMap(secret => [...new Set([secret, JSON.stringify(secret).slice(1, -1)])]);
            for (const field of ['guid', 'topic_guid', 'viewpoint_guid', 'reply_to_comment_guid']) {
              const value: unknown = Reflect.get(result, field);
              if (field !== 'guid' && (value === undefined || value === null)) continue;
              if (!text(value)) refuse('server returned an invalid receipt');
              if (representations.some(secret => value.includes(secret))) refuse('server receipt contains credential text');
            }
            credentialFree({ remoteGuid: result.guid }, sensitive);
          } catch (error) {
            const classified = classifyWriteError(error, new Date().toISOString());
            const outcome: StoredBcfOutcome = { version: 1, id, digest, state: classified.state,
              failure: { ...classified.failure, message: classified.state === 'failed'
                ? NATIVE_METADATA.message.refused : NATIVE_METADATA.message.unknown } };
            await store.publish(`${id}.outcome.json`, outcome, sensitive);
            outcomeSaved = true;
            if (classified.state === 'failed') throw new Error(`BCF publication ${id}: request refused (${classified.failure.code}${classified.failure.status ? `, HTTP ${classified.failure.status}` : ''}).`);
            throw new Error(`BCF publication ${id}: outcome unknown; check and explicitly reconcile the recorded intent before sending again.`);
          }
          const outcome: StoredBcfOutcome = { version: 1, id, digest, state: NATIVE_METADATA.state.done,
            receipt: { remoteGuid: result.guid, at: new Date().toISOString(), evidence: NATIVE_METADATA.evidence.response } };
          // Receipt persistence is part of success. A failed save leaves the durable intent unresolved.
          await store.publish(`${id}.outcome.json`, outcome, sensitive);
          outcomeSaved = true;
          return result;
        } finally {
          // An EEXIST loser must never clear or complete the winner's live key.
          if (linkedOwned) {
            active.delete(key(id));
            if (outcomeSaved) finished.delete(key(id)); else finished.add(key(id));
          }
        }
      });
    },
    async list() {
      const result = await page({ limit: 1_000 });
      if (result.nextCursor) refuse('list exceeds one bounded page (row, byte or work limit); use listPage and its cursor');
      return result.entries;
    },
    async listPage(pageOptions) {
      return page(pageOptions);
    },
    async check(entryId, checkOptions) {
      const sensitive = [...secrets, ...(checkOptions.token ? [checkOptions.token] : [])];
      assertNativeRepresentable(sensitive);
      let item = await loaded(entryId);
      if (checkOptions.confirmOwnerStopped && !item.outcome && !finished.has(key(item.attempt.id))) {
        if (active.has(key(item.attempt.id)) || item.ownerStatus === 'alive') refuse('write owner is still active');
        if (item.ownerStatus === 'unknown' && !item.ownerConfirmed) {
          await store.publish(`${entryId}.owner-stopped.json`, { version: 1, id: entryId, digest: item.attempt.digest,
            at: new Date().toISOString(), assertion: NATIVE_METADATA.assertion }, sensitive);
          item = await loaded(entryId);
        }
      }
      recoverable(item);
      const previous = item.checks.at(-1);
      const checkId = item.checkPending ? previous!.checkId : String(Number(previous?.checkId ?? 0) + 1);
      // Manual recovery resumes an interrupted GET reservation, never a create.
      if (!item.checkPending) {
        if (!previous || Number(previous.checkId) % MAX_CHECKS === 0) await store.ensureEpoch(item.attempt, previous, sensitive);
        await store.publish(`${entryId}.check-${checkId}.json`, { version: 1, id: entryId, digest: item.attempt.digest, checkId,
          check: { at: new Date().toISOString(), result: NATIVE_METADATA.check.unavailable, candidates: [] } }, sensitive);
      }
      let check: StoredBcfCheck['check'];
      let failed = false;
      try { check = await lookupNativeBcfAttempt(item.attempt, checkOptions, secrets); }
      catch { failed = true; check = { at: new Date().toISOString(), result: NATIVE_METADATA.check.unavailable, candidates: [] }; }
      recoverable(await loaded(entryId));
      await store.publish(`${entryId}.checked-${checkId}.json`, { version: 1, id: entryId, digest: item.attempt.digest, checkId, check }, sensitive);
      if (failed) throw new Error('BCF publication check unavailable: network grant denied or server result unverified; no state was released.');
      return publicEntry(await loaded(entryId));
    },
    async confirmAbsent(entryId) {
      const item = await loaded(entryId);
      recoverable(item);
      const checked = item.checks.at(-1);
      if (checked?.check.result !== 'absent' || checked.check.candidates.length || checked.check.fullReadAccessConfirmed !== true) refuse('latest persisted check did not prove absence');
      const outcome: StoredBcfOutcome = { version: 1, id: entryId, digest: item.attempt.digest, state: NATIVE_METADATA.state.failed,
        failure: { code: NATIVE_METADATA.confirmedAbsent, message: NATIVE_METADATA.message.absent, at: new Date().toISOString() } };
      const nextId = String(Number(checked.checkId) + 1);
      if (Number(checked.checkId) % MAX_CHECKS === 0) await store.ensureEpoch(item.attempt, checked, secrets);
      // A resolution and the next check compete for this SAME exclusive transition.
      await store.publish(`${entryId}.check-${nextId}.json`, { version: 1, id: entryId, digest: item.attempt.digest,
        checkId: nextId, check: checked.check, settlement: { outcome, proofCheckId: checked.checkId } }, secrets);
      return publicEntry(await loaded(entryId));
    },
    async reconcile(entryId, candidateGuid) {
      const item = await loaded(entryId);
      recoverable(item);
      credentialFree({ candidateGuid }, secrets);
      const checked = item.checks.at(-1);
      if (!checked?.check.candidates.some(candidate => candidate.guid === candidateGuid)) refuse('GUID is not a candidate from the latest persisted server check');
      const outcome: StoredBcfOutcome = { version: 1, id: entryId, digest: item.attempt.digest, state: NATIVE_METADATA.state.done,
        receipt: { remoteGuid: candidateGuid, at: new Date().toISOString(), evidence: NATIVE_METADATA.evidence.reconciled } };
      const nextId = String(Number(checked.checkId) + 1);
      if (Number(checked.checkId) % MAX_CHECKS === 0) await store.ensureEpoch(item.attempt, checked, secrets);
      // A resolution and the next check compete for this SAME exclusive transition.
      await store.publish(`${entryId}.check-${nextId}.json`, { version: 1, id: entryId, digest: item.attempt.digest,
        checkId: nextId, check: checked.check, settlement: { outcome, proofCheckId: checked.checkId } }, secrets);
      return publicEntry(await loaded(entryId));
    },
  };
}
