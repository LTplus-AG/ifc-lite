/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Buffer } from 'node:buffer';
import { readPublicationRecord } from './bcf-publication-record.js';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { credentialFree, MAX_GENERATIONS, MAX_RECORD_BYTES, MAX_RECORDS, NATIVE_METADATA, record, refuse } from './bcf-publication-codec.js';
import { epochOf, loadCheckEpoch, verifyCheckEpoch, type BcfCheckEpoch } from './bcf-publication-epochs.js';
import { loadBcfHistory } from './bcf-publication-history.js';
import { capacityDigest, DIGEST_SLOTS, reserveDigest } from './bcf-publication-capacity.js';
import type { NativeBcfOwnerStatus, NativeBcfPublicationEntry, NativeBcfPublicationPageOptions, StoredBcfAttempt, StoredBcfCheck, StoredBcfOutcome } from './bcf-publication-types.js';

export interface LoadedAttempt {
  attempt: StoredBcfAttempt;
  outcome?: StoredBcfOutcome;
  checks: StoredBcfCheck[];
  reconciled?: StoredBcfOutcome;
  ownerStatus: NativeBcfOwnerStatus;
  ownerConfirmed?: boolean;
  checkPending?: boolean;
}
// Only per-invocation directory identities; record contents are always reread.
type DirectoryIdentity = { dev: bigint; ino: bigint };
type EpochReadBatch = { leaves: Map<string, DirectoryIdentity>; parents: Map<string, DirectoryIdentity> };
const sameDirectory = (a: DirectoryIdentity, b: DirectoryIdentity) => a.dev === b.dev && a.ino === b.ino;
const errorCode = (error: unknown) => record(error) ? error.code : undefined;
export function entryOf(item: LoadedAttempt, sendFinished = false): NativeBcfPublicationEntry {
  const outcome = item.reconciled ?? item.outcome;
  const check = item.checks.at(-1)?.check;
  return { id: item.attempt.id, intent: item.attempt.intent, queuedAt: item.attempt.queuedAt,
    state: outcome?.state ?? (item.ownerStatus === 'alive' && !sendFinished ? NATIVE_METADATA.state.sending : NATIVE_METADATA.state.uncertain),
    ...(outcome?.receipt ? { receipt: outcome.receipt } : {}), ...(outcome?.failure ? { failure: outcome.failure } : {}),
    ...(check ? { check } : {}), ...(!outcome ? { ownerStatus: item.ownerStatus } : {}) };
}

/** Immutable fsynced v2 records. No receipt, capacity slot or predecessor is ever deleted. */
export class BcfPublicationStore {
  constructor(readonly directory: string) {}
  private bucket(prefix: string) { return join(this.directory, 'v2', prefix); }
  private path(digest: string) { return join(this.bucket(digest.slice(0, 2)), digest); }
  async prepare(): Promise<void> {
    const ancestors: string[] = [];
    for (let path = this.directory;; path = dirname(path)) {
      if (ancestors.length >= 128) refuse('configured outbox exceeds directory depth bound');
      ancestors.push(path);
      if (dirname(path) === path) break;
    }
    const firstCreated = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) refuse('invalid namespace directory');
    const entries = await opendir(this.directory);
    for await (const item of entries) {
      if (item.name !== 'v2' || !item.isDirectory()) {
        refuse('old flat publication layout: preserve this outbox; recover with its original build before selecting a new empty outbox');
      }
    }
    await mkdir(join(this.directory, 'v2'), { recursive: true, mode: 0o700 });
    await this.syncDirectory(join(this.directory, 'v2'));
    // Existing ancestors may have just been created by a different first-use writer.
    // Persist every parent entry before effects, not only the mkdir winner's subtree.
    if (firstCreated !== undefined && !ancestors.includes(firstCreated)) refuse('created namespace ancestor identity mismatch');
    for (const path of ancestors) {
      if (!(await lstat(path)).isDirectory()) refuse('invalid publication ancestor');
      await this.syncDirectory(path);
    }
  }
  private async syncDirectory(directory: string, expected?: DirectoryIdentity): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | (expected ? constants.O_NOFOLLOW : 0));
    try {
      if (expected) {
        const actual = await handle.stat({ bigint: true });
        if (!actual.isDirectory() || !sameDirectory(actual, expected)) refuse('recovery epoch directory changed during validation');
      }
      await handle.sync();
      if (expected) {
        const current = await lstat(directory, { bigint: true });
        if (!current.isDirectory() || !sameDirectory(current, expected)) refuse('recovery epoch directory changed during validation');
      }
    } finally { await handle.close(); }
  }
  private async publishAt(directory: string, filename: string, value: unknown, prefix: string, onLinked?: () => void): Promise<void> {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) refuse('record exceeds storage bound');
    credentialFree(value, []);
    // Temporary debris stays outside the bounded per-digest recovery history.
    // Same-filesystem hardlink publication remains exclusive; no active temporary is deleted by recovery.
    if (!/^[a-f0-9]{2}$/.test(prefix)) refuse('invalid temporary bucket prefix');
    const temporary = join(this.bucket(prefix), `.tmp-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      await link(temporary, join(directory, filename));
      onLinked?.();
      await this.syncDirectory(directory);
    } finally {
      try { await unlink(temporary); } catch (error) {
        if (errorCode(error) !== 'ENOENT') console.warn('[BCF publication] Could not remove temporary intent file', error);
      }
    }
  }
  async publish(filename: string, value: unknown, secrets: readonly string[] = [], onLinked?: () => void): Promise<void> {
    credentialFree(value, secrets);
    if (!/^[a-f0-9]{64}-[1-9][0-9]*\.(?:intent|outcome|owner-stopped|(?:check|checked)-[1-9][0-9]{0,15})\.json$/.test(filename)) refuse('invalid publication filename');
    const digest = filename.slice(0, 64);
    const bucket = this.bucket(digest.slice(0, 2));
    await mkdir(bucket, { recursive: true, mode: 0o700 });
    if (!(await lstat(bucket)).isDirectory()) refuse('invalid digest bucket');
    await this.syncDirectory(join(this.directory, 'v2'));
    await reserveDigest(bucket, digest, (directory, file, value) => {
      credentialFree(value, secrets); return this.publishAt(directory, file, value, digest.slice(0, 2));
    },
      (directory, file) => this.readAt(directory, file, false), this.syncDirectory.bind(this));
    const path = this.path(digest);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory()) refuse('invalid publication directory');
    await this.syncDirectory(bucket);
    const check = /\.(?:check|checked)-([1-9][0-9]*)\.json$/.exec(filename);
    await this.publishAt(check ? this.epochPath(filename.slice(0, filename.indexOf('.')), epochOf(check[1])) : path, filename, value,
      digest.slice(0, 2), filename.endsWith('.intent.json') ? onLinked : undefined);
  }
  private readAt(directory: string, filename: string, syncEntry = true): Promise<unknown> {
    return readPublicationRecord(join(directory, filename), syncEntry ? () => this.syncDirectory(directory) : undefined);
  }
  private epochPath(id: string, epoch: number) { return join(this.path(id.slice(0, 64)), `${id}.epochs`, String(epoch)); }
  private async epochRead(id: string, epoch: number, filename: string, batch?: EpochReadBatch): Promise<unknown> {
    const directory = this.epochPath(id, epoch), parent = join(directory, '..');
    const identities: DirectoryIdentity[] = [];
    for (const path of [parent, directory]) {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isDirectory()) refuse('invalid recovery epoch directory');
      identities.push({ dev: stat.dev, ino: stat.ino });
    }
    const value = await this.readAt(directory, filename, batch === undefined);
    if (batch) {
      for (const [map, path, identity] of [
        [batch.parents, parent, identities[0]], [batch.leaves, directory, identities[1]],
      ] as const) {
        const previous = map.get(path);
        if (previous && !sameDirectory(previous, identity)) refuse('recovery epoch directory changed during validation');
        map.set(path, identity);
      }
    } else await this.syncDirectory(parent);
    return value;
  }
  private async checks(attempt: StoredBcfAttempt, secrets: readonly string[]) {
    const batch: EpochReadBatch = { leaves: new Map(), parents: new Map() };
    const result = await loadCheckEpoch(attempt, async (epoch, filename) => {
      const value = await this.epochRead(attempt.id, epoch, filename, batch);
      credentialFree(value, secrets); return value;
    });
    // #7637: persist EVERY observed epoch link after all immutable reads, then
    // its parent entry, before any checked proof escapes. Standalone epochRead
    // calls retain their immediate barriers. No record or negative probe is cached.
    for (const [directory, identity] of batch.leaves) await this.syncDirectory(directory, identity);
    for (const [directory, identity] of batch.parents) await this.syncDirectory(directory, identity);
    return result;
  }
  async ensureEpoch(attempt: StoredBcfAttempt, previous?: StoredBcfCheck, secrets: readonly string[] = []): Promise<void> {
    const nextId = String(Number(previous?.checkId ?? 0) + 1), epoch = epochOf(nextId);
    const expected: BcfCheckEpoch = { version: 1, id: attempt.id, digest: attempt.digest, epoch,
      ...(epoch > 1 ? { previous } : {}) };
    credentialFree(expected, secrets);
    const directory = this.epochPath(attempt.id, epoch);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of [join(directory, '..'), directory]) {
      if (!(await lstat(path)).isDirectory()) refuse('invalid recovery epoch directory');
    }
    await this.syncDirectory(join(directory, '..')); await this.syncDirectory(this.path(attempt.digest));
    try { await this.publishAt(directory, 'marker.json', expected, attempt.digest.slice(0, 2)); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    verifyCheckEpoch(await this.epochRead(attempt.id, epoch, 'marker.json'), expected, attempt);
    await this.syncDirectory(directory);
  }
  private async names(digest: string, syncBucket = true): Promise<string[]> {
    if (!/^[a-f0-9]{64}$/.test(digest)) refuse('invalid publication digest');
    const path = this.path(digest);
    try {
      if (!(await lstat(this.bucket(digest.slice(0, 2)))).isDirectory()) refuse('invalid digest bucket');
      if (!(await lstat(path)).isDirectory()) refuse('invalid publication directory');
    }
    catch (error) { if (errorCode(error) === 'ENOENT') return []; throw error; }
    if (syncBucket) await this.syncDirectory(this.bucket(digest.slice(0, 2)));
    await this.syncDirectory(path);
    const names: string[] = [];
    const directory = await opendir(path);
    for await (const item of directory) {
      if (names.length >= MAX_RECORDS) refuse('publication record limit reached');
      if ((!item.isFile() && !(item.isDirectory() && item.name.endsWith('.epochs'))) || !/^(?:\.tmp-[a-f0-9-]{36}|[a-f0-9]{64}-[1-9][0-9]*\.(?:(?:intent|outcome|owner-stopped)\.json|epochs))$/.test(item.name)
        || (!item.name.startsWith('.tmp-') && !item.name.startsWith(`${digest}-`))) refuse('unrecognized publication state');
      names.push(item.name);
    }
    return names;
  }
  async load(digest: string, targetId?: string, secrets: readonly string[] = []): Promise<LoadedAttempt[]> {
    await this.prepare();
    const selected = await this.history(await this.names(digest), digest, targetId, secrets);
    return selected ? [selected] : [];
  }

  /** Acknowledgment follows one fsync AFTER all verified root reads; no receipt escapes before it. */
  private async history(names: string[], digest: string, targetId: string | undefined, secrets: readonly string[],
    visit?: (item: LoadedAttempt) => void) {
    const selected = await loadBcfHistory(names, name => this.readAt(this.path(digest), name, false),
      attempt => this.checks(attempt, secrets), targetId, secrets, visit);
    if (names.length) await this.syncDirectory(this.path(digest));
    return selected;
  }

  /** Weakly consistent pages: a cursor progresses at the work/byte bound, even without rows. */
  async page(options: NativeBcfPublicationPageOptions = {}, secrets: readonly string[] = []) {
    await this.prepare();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) refuse('page limit must be between 1 and 1000');
    const match = options.cursor === undefined ? ['00:0:0', '00', '0', '0'] : /^([a-f0-9]{2}):([0-9]{1,4}):([0-9]{1,3})$/.exec(options.cursor);
    if (!match || Number(match[2]) >= DIGEST_SLOTS || Number(match[3]) > MAX_GENERATIONS) refuse('invalid page cursor');
    let prefix = Number.parseInt(match[1], 16), slot = Number(match[2]), generation = Number(match[3]);
    let work = 0, bytes = 0;
    const entries: NativeBcfPublicationEntry[] = [];
    const cursor = () => `${prefix.toString(16).padStart(2, '0')}:${slot}:${generation}`;
    while (prefix < 256) {
      const bucket = this.bucket(prefix.toString(16).padStart(2, '0'));
      try { if (!(await lstat(bucket)).isDirectory()) refuse('invalid digest bucket'); }
      catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        prefix += 1; slot = 0; generation = 0; continue;
      }
      try {
        while (slot < DIGEST_SLOTS) {
          if (work >= 50_000 || entries.length >= limit) return { entries, nextCursor: cursor() };
          work += 1;
          let digest: string;
          try { digest = capacityDigest(await this.readAt(bucket, `slot-${slot}.json`, false)); }
          catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
            break; // Claims fill the first free slot and are never deleted: no holes.
          }
          if (!digest.startsWith(prefix.toString(16).padStart(2, '0'))) refuse('capacity bucket identity mismatch');
          const names = await this.names(digest, false);
          // Each attempt: <=106 marker probes, 32 event probes and bounded root reads.
          const attempts = names.filter(name => name.endsWith('.intent.json')).length;
          if (attempts > MAX_GENERATIONS) refuse('excessive attempt generations');
          const cost = 2 * names.length + 142 * attempts;
          if (work + cost > 50_000) return { entries, nextCursor: cursor() };
          work += cost;
          let stopped = false;
          // Validate one history once, retaining only bounded public rows and current history state.
          await this.history(names, digest, undefined, secrets, item => {
            if (stopped || item.attempt.generation <= generation) return;
            const entry = entryOf(item);
            const size = Buffer.byteLength(JSON.stringify(entry));
            if (entries.length >= limit || bytes + size > 5 * 1024 * 1024) { stopped = true; return; }
            entries.push(entry); bytes += size; generation = item.attempt.generation;
          });
          if (stopped) return { entries, nextCursor: cursor() };
          slot += 1; generation = 0;
        }
      } finally {
        // Persist all observed slot and digest links AFTER these reads, including
        // concurrent links observed after entering the bucket, before any return.
        await this.syncDirectory(bucket);
      }
      prefix += 1; slot = 0; generation = 0;
    }
    return { entries };
  }
}
