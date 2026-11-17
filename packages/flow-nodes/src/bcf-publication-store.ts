/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { readPublicationRecord } from './bcf-publication-record.js';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, readlink, unlink } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
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

const MAX_OUTBOX_DEPTH = 128;

/** A symlinked ancestor is followed only when root or this user owns it (macOS /var and /tmp
 * are root-owned): another user's link must not redirect immutable records into their tree.
 * Without POSIX uids (Windows) ownership cannot be checked, so links stay refused there, as
 * every symlinked ancestor was before. */
const trustedLinkOwner = (uid: number, self = process.getuid?.()) => self !== undefined && (uid === 0 || uid === self);

/** The configured namespace with its existing ancestors resolved. The leaf is not resolved:
 * that would conceal a symlinked namespace, which prepare() must refuse. */
async function canonicalNamespaceDirectory(absolute: string): Promise<string> {
  const components = (path: string) => path.slice(parse(path).root.length).split(sep === '\\' ? /[\\/]+/ : /\/+/).filter(Boolean);
  const leaf = basename(absolute);
  let resolved = parse(absolute).root;
  const pending = components(dirname(absolute)).map(part => ({ part, fromLink: false }));
  let hops = 0;
  // Same bound as prepare()'s ancestor walk: a path of MAX_OUTBOX_DEPTH components is refused.
  const finish = (path: string) => {
    if (components(path).length >= MAX_OUTBOX_DEPTH) refuse('configured outbox exceeds directory depth bound');
    return path;
  };
  finish(absolute); // refuse an over-deep configured path before any I/O
  while (pending.length) {
    const { part, fromLink } = pending.shift()!;
    if (part === '.') continue;
    if (part === '..') { resolved = dirname(resolved); continue; }
    const next = join(resolved, part);
    let stat: Stats;
    try { stat = await lstat(next); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      if (fromLink) refuse('invalid publication ancestor');
      return finish(join(next, ...pending.map(item => item.part), leaf));
    }
    if (stat.isSymbolicLink()) {
      if (!trustedLinkOwner(stat.uid)) refuse('publication ancestor is a symlink owned by another user');
      if (++hops > 40) refuse('publication ancestor has too many symlinks');
      const target = await readlink(next);
      const root = parse(target).root;
      if (root) resolved = root;
      pending.unshift(...components(target).map(part => ({ part, fromLink: true })));
    } else if (stat.isDirectory()) resolved = next;
    else refuse('invalid publication ancestor');
  }
  return finish(join(resolved, leaf));
}
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
  /** The configured outbox, made absolute against the cwd at construction. */
  readonly directory: string;
  private root?: string;
  private resolving?: Promise<void>;
  constructor(directory: string) { this.directory = resolve(directory); }
  /** The outbox with its existing ancestors resolved once (e.g. macOS /var -> /private/var):
   * one identity for every configured alias of a physical outbox, and the base of all I/O.
   * Every public operation resolves it first; reading it earlier is a programming error. */
  get identity(): string {
    if (this.root === undefined) throw new Error('BcfPublicationStore used before its outbox was resolved');
    return this.root;
  }
  /** Resolve once; concurrent callers share the walk, and a failed walk is retried next time. */
  private async resolveRoot(): Promise<void> {
    this.resolving ??= canonicalNamespaceDirectory(this.directory).then(
      root => { this.root = root; },
      error => { this.resolving = undefined; throw error; });
    return this.resolving;
  }
  private bucket(prefix: string) { return join(this.identity, 'v2', prefix); }
  private path(digest: string) { return join(this.bucket(digest.slice(0, 2)), digest); }
  async prepare(): Promise<void> {
    await this.resolveRoot();
    const ancestors: string[] = [];
    for (let path = this.identity;; path = dirname(path)) {
      ancestors.push(path);
      if (dirname(path) === path) break;
    }
    const firstCreated = await mkdir(this.identity, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.identity)).isDirectory()) refuse('invalid namespace directory');
    const entries = await opendir(this.identity);
    for await (const item of entries) {
      if (item.name !== 'v2' || !item.isDirectory()) {
        refuse('old flat publication layout: preserve this outbox; recover with its original build before selecting a new empty outbox');
      }
    }
    await mkdir(join(this.identity, 'v2'), { recursive: true, mode: 0o700 });
    await this.syncDirectory(join(this.identity, 'v2'));
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
    await this.resolveRoot();
    credentialFree(value, secrets);
    if (!/^[a-f0-9]{64}-[1-9][0-9]*\.(?:intent|outcome|owner-stopped|(?:check|checked)-[1-9][0-9]{0,15})\.json$/.test(filename)) refuse('invalid publication filename');
    const digest = filename.slice(0, 64);
    const bucket = this.bucket(digest.slice(0, 2));
    await mkdir(bucket, { recursive: true, mode: 0o700 });
    if (!(await lstat(bucket)).isDirectory()) refuse('invalid digest bucket');
    await this.syncDirectory(join(this.identity, 'v2'));
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
    await this.resolveRoot();
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
