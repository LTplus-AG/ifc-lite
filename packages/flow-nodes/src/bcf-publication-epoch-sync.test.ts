/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7637: real retained HTTP effects and real per-invocation epoch durability.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CallbackProbe } from './__tests__/bcf-record-callback-hooks.js';
import { observeStat } from './__tests__/bcf-record-callback-hooks.js';
const callbackProbe = vi.hoisted(() => ({ reads: 0, closes: 0 } as CallbackProbe));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { forwardingFs } = await import('./__tests__/bcf-record-callback-hooks.js');
  return forwardingFs(actual, callbackProbe);
});
import { mkdtemp, open, readdir, readFile, readlink, rm, rename, mkdir, copyFile, writeFile, unlink, lstat, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { BcfApiClient } from '@ifc-lite/bcf-api';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createNativeBcfWriteGateway } from './bcf-publication-node.js';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../apps/viewer/src/test/bcf-http-server.js';

const recordClosed = new Map<number, () => void>();
beforeEach(() => {
  callbackProbe.afterClose = (fd, deliver) => {
    const closed = recordClosed.get(fd); recordClosed.delete(fd); closed?.(); deliver();
  };
});
afterEach(() => { callbackProbe.afterStat = undefined; callbackProbe.afterClose = undefined; recordClosed.clear(); });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bcf-epoch-sync-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const peer = await startLocalBcfServer(); cleanup.push(peer.close);
  const transport = (url: URL, init?: RequestInit) => fetch(new URL(url.pathname + url.search, peer.baseUrl), init);
  const client = new BcfApiClient({ baseUrl: 'https://bcf.example.test/bcf', getAccessToken: () => LOCAL_BCF_TOKEN,
    fetchFn: (url, init) => transport(new URL(String(url)), { ...init, redirect: 'manual' }) });
  const gateway = createNativeBcfWriteGateway({ directory, secrets: [LOCAL_BCF_TOKEN] });
  const intent = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const, baseUrl: 'https://bcf.example.test/bcf',
    version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Retained epoch barrier' } };
  const create = () => gateway.write(intent, () => client.createTopic(LOCAL_BCF_PROJECT, intent.payload));
  peer.state.loseNextWriteResponse = true;
  await expect(create()).rejects.toThrow('outcome unknown');
  const [entry] = await gateway.list();
  const grants = parseCapabilities(['network.fetch:bcf.example.test']);
  if (!grants.ok) throw new Error('Real server grant invalid');
  await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants.value, networkTransport: transport });
  const root = join(directory, (await readdir(directory))[0], 'v2', entry.id.slice(0, 2), entry.id.slice(0, 64));
  const parent = join(root, `${entry.id}.epochs`), leaf = join(parent, '1');
  const records = ['marker.json', `${entry.id}.check-1.json`, `${entry.id}.checked-1.json`];
  const journal = await Promise.all(records.map(name => readFile(join(leaf, name), 'utf8')));
  const fresh = () => createNativeBcfWriteGateway({ directory, secrets: [LOCAL_BCF_TOKEN] });
  expect(peer.state.receivedWrites).toBe(1);
  return { directory, peer, gateway, create, entry, parent, leaf, records, journal, fresh };
}

it.skipIf(process.platform !== 'linux')('validates all actual epoch records before one leaf and one parent fsync (#7637)', async () => {
  const f = await fixture(); const probe = await open(f.directory, 'r');
  const prototype: FileHandle = Object.getPrototypeOf(probe), sync = prototype.sync;
  const closed = new Set<string>(); let leaves = 0, parents = 0;
  const order: string[] = [];
  const closedRecords = observeStat(callbackProbe, async (fd, _actual) => {
    const path = await readlink(`/proc/self/fd/${fd}`);
    if (path.startsWith(`${f.leaf}/`) && f.records.includes(basename(path))) {
      recordClosed.set(fd, () => closed.add(basename(path)));
    }
  });
  const synced = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    const path = await readlink(`/proc/self/fd/${this.fd}`);
    if (path === f.leaf || path === f.parent) {
      expect([...closed].sort()).toEqual([...f.records].sort());
      const kind = path === f.leaf ? 'leaf' : 'parent';
      if (kind === 'leaf') leaves += 1; else parents += 1;
      order.push(`${kind}.start`);
      await sync.call(this);
      order.push(`${kind}.done`);
      return;
    }
    return sync.call(this);
  });
  try {
    const [loaded] = await f.fresh().list();
    expect(loaded.check?.candidates.map(candidate => candidate.guid)).toEqual([...f.peer.state.topics.keys()]);
    expect(leaves).toBe(1); expect(parents).toBe(1);
    expect(order).toEqual(['leaf.start', 'leaf.done', 'parent.start', 'parent.done']);
    expect(f.peer.state.receivedWrites).toBe(1);
  } finally { synced.mockRestore(); closedRecords.mockRestore(); await probe.close(); }
});

it.skipIf(process.platform !== 'linux').each(['leaf', 'parent'] as const)(
  'post-read epoch %s fsync EIO prevents acknowledgment and HTTP until real recovery (#7637)', async kind => {
    const f = await fixture(); const probe = await open(f.directory, 'r');
    const prototype: FileHandle = Object.getPrototypeOf(probe), sync = prototype.sync;
    const closed = new Set<string>(); let failures = 0;
    const closedRecords = observeStat(callbackProbe, async (fd, _actual) => {
      const path = await readlink(`/proc/self/fd/${fd}`);
      if (path.startsWith(`${f.leaf}/`) && f.records.includes(basename(path))) {
        recordClosed.set(fd, () => closed.add(basename(path)));
      }
    });
    const target = kind === 'leaf' ? f.leaf : f.parent;
    const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
      const path = await readlink(`/proc/self/fd/${this.fd}`);
      if (path === target) {
        expect([...closed].sort()).toEqual([...f.records].sort());
        failures += 1;
        throw Object.assign(new Error('Injected final epoch barrier EIO'), { code: 'EIO' });
      }
      return sync.call(this);
    });
    try {
      await expect(f.fresh().list()).rejects.toThrow('final epoch barrier EIO');
      closed.clear();
      await expect(f.create()).rejects.toThrow('final epoch barrier EIO');
      expect(failures).toBe(2);
      expect(f.peer.state.receivedWrites).toBe(1);
      expect(await Promise.all(f.records.map(name => readFile(join(f.leaf, name), 'utf8')))).toEqual(f.journal);
    } finally { fault.mockRestore(); closedRecords.mockRestore(); await probe.close(); }
    const [loaded] = await f.fresh().list();
    const guid = [...f.peer.state.topics.keys()][0];
    expect(loaded.check?.candidates.map(candidate => candidate.guid)).toEqual([guid]);
    await f.gateway.reconcile(f.entry.id, guid);
    await f.create();
    expect(f.peer.state.receivedWrites).toBe(2); expect(f.peer.state.acceptedWrites).toBe(2);
  });

it.skipIf(process.platform !== 'linux')('rejects a real replaced epoch inode before returning an earlier proof (#7637)', async () => {
  const f = await fixture(); const original = await lstat(f.leaf, { bigint: true });
  const saved = join(f.parent, 'saved-epoch'); const probe = await open(f.directory, 'r');
  let changed = false;
  const swap = observeStat(callbackProbe, async (fd, _actual) => {
    const path = await readlink(`/proc/self/fd/${fd}`);
    if (!changed && path === join(f.leaf, 'marker.json')) {
      changed = true; await rename(f.leaf, saved); await mkdir(f.leaf);
      for (const name of f.records) await copyFile(join(saved, name), join(f.leaf, name));
      const replacement = await lstat(f.leaf, { bigint: true });
      expect(replacement.dev !== original.dev || replacement.ino !== original.ino).toBe(true);
    }
  });
  try {
    await expect(f.fresh().list()).rejects.toThrow('directory changed during validation');
    expect(changed).toBe(true); expect(f.peer.state.receivedWrites).toBe(1);
  } finally {
    swap.mockRestore(); await probe.close();
    if (changed) { await rm(f.leaf, { recursive: true }); await rename(saved, f.leaf); }
  }
  expect((await f.fresh().list())[0].check?.candidates).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('observes a concurrently appended contradictory response instead of caching epoch contents (#7637)', async () => {
  const f = await fixture(); const probe = await open(f.directory, 'r');
  const filename = join(f.leaf, `${f.entry.id}.checked-2.json`); let appended = false;
  const append = observeStat(callbackProbe, async (fd, _actual) => {
    const path = await readlink(`/proc/self/fd/${fd}`);
    if (!appended && path === join(f.leaf, 'marker.json')) {
      appended = true;
      const prior: unknown = JSON.parse(f.journal[2]);
      if (!prior || typeof prior !== 'object') throw new Error('Actual checked record invalid');
      await writeFile(filename, JSON.stringify({ ...prior, checkId: '2' }), { flag: 'wx' });
    }
  });
  try {
    await expect(f.fresh().list()).rejects.toThrow('response lacks reserved transition');
    expect(appended).toBe(true); expect(f.peer.state.receivedWrites).toBe(1);
  } finally { append.mockRestore(); await probe.close(); if (appended) await unlink(filename); }
  expect((await f.fresh().list())[0].check?.candidates).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('rejects a path replacement after the original epoch handle actually fsyncs (#7637)', async () => {
  const f = await fixture(); const original = await lstat(f.leaf, { bigint: true });
  const saved = join(f.parent, 'saved-post-sync-epoch'); const probe = await open(f.directory, 'r');
  const prototype: FileHandle = Object.getPrototypeOf(probe), stat = prototype.stat, sync = prototype.sync;
  const closed = new Set<string>(); let changed = false, originalHandleSynced = false;
  const reads = observeStat(callbackProbe, async (fd, _actual) => {
    const path = await readlink(`/proc/self/fd/${fd}`);
    if (path.startsWith(`${f.leaf}/`) && f.records.includes(basename(path))) {
      recordClosed.set(fd, () => closed.add(basename(path)));
    }
  });
  const swap = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    const path = await readlink(`/proc/self/fd/${this.fd}`);
    await sync.call(this);
    if (!changed && path === f.leaf) {
      expect([...closed].sort()).toEqual([...f.records].sort());
      const actual = await stat.call(this, { bigint: true });
      expect([actual.dev, actual.ino]).toEqual([original.dev, original.ino]);
      originalHandleSynced = true;
      await rename(f.leaf, saved); changed = true; await mkdir(f.leaf);
      for (const name of f.records) await copyFile(join(saved, name), join(f.leaf, name));
      const replacement = await lstat(f.leaf, { bigint: true });
      expect(replacement.dev !== original.dev || replacement.ino !== original.ino).toBe(true);
      // The held, already-fsynced handle still points to the ORIGINAL directory.
      const held = await stat.call(this, { bigint: true });
      expect([held.dev, held.ino]).toEqual([original.dev, original.ino]);
    }
  });
  try {
    await expect(f.fresh().list()).rejects.toThrow('directory changed during validation');
    expect(originalHandleSynced).toBe(true); expect(changed).toBe(true);
    expect(f.peer.state.receivedWrites).toBe(1);
  } finally {
    swap.mockRestore(); reads.mockRestore(); await probe.close();
    if (changed) { await rm(f.leaf, { recursive: true }); await rename(saved, f.leaf); }
  }
  expect((await f.fresh().list())[0].check?.candidates).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('rejects the wrong opened epoch handle even when its path is restored before the final path check (#7637)', async () => {
  const f = await fixture(); const original = await lstat(f.leaf, { bigint: true });
  const saved = join(f.parent, 'saved-pre-handle-epoch'), replacementSaved = join(f.parent, 'saved-opened-replacement');
  const probe = await open(f.directory, 'r'); const prototype: FileHandle = Object.getPrototypeOf(probe), stat = prototype.stat;
  let phase = 0;
  const callbackSwap = observeStat(callbackProbe, async (fd, _actual) => {
    const path = await readlink(`/proc/self/fd/${fd}`);
    if (phase === 0 && path === join(f.leaf, `${f.entry.id}.checked-1.json`)) {
      // This last positive record is already opened on the ORIGINAL inode;
      // all its per-read directory observations are also original. Later
      // negative probes do not add replacement identities to the batch map.
      await rename(f.leaf, saved); phase = 1; await mkdir(f.leaf);
      for (const name of f.records) await copyFile(join(saved, name), join(f.leaf, name));

    }
  });
  const swap = vi.spyOn(prototype, 'stat').mockImplementation(async function(this: FileHandle, ...options: Parameters<FileHandle['stat']>) {
    const actual = await stat.apply(this, options);
    const path = await readlink(`/proc/self/fd/${this.fd}`);
    if (phase === 1 && path === f.leaf && actual.isDirectory()) {
      // The final fsync has opened a DIFFERENT real inode. Restore the path
      // only AFTER obtaining its real fstat result: a path-only guard would
      // now pass, but the actual opened-handle identity must still refuse.
      expect(actual.dev !== original.dev || actual.ino !== original.ino).toBe(true);
      await rename(f.leaf, replacementSaved); await rename(saved, f.leaf); phase = 2;
      const restored = await lstat(f.leaf, { bigint: true });
      expect([restored.dev, restored.ino]).toEqual([original.dev, original.ino]);
    }
    return actual;
  });
  try {
    await expect(f.fresh().list()).rejects.toThrow('directory changed during validation');
    expect(phase).toBe(2); expect(f.peer.state.receivedWrites).toBe(1);
  } finally {
    callbackSwap.mockRestore(); swap.mockRestore(); await probe.close();
    if (phase === 1) { await rm(f.leaf, { recursive: true }); await rename(saved, f.leaf); }
    if (phase === 2) await rm(replacementSaved, { recursive: true });
  }
  expect((await f.fresh().list())[0].check?.candidates).toHaveLength(1);
});
