/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: bounded bucket synchronization still certifies every observed link.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, open, readFile, readlink, readdir, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BcfApiClient } from '@ifc-lite/bcf-api';
import { createNativeBcfWriteGateway } from './bcf-publication-node.js';
import { intentDigest, normalizeIntent } from './bcf-publication-codec.js';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../apps/viewer/src/test/bcf-http-server.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bcf-bucket-sync-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const peer = await startLocalBcfServer();
  cleanup.push(peer.close);
  const client = new BcfApiClient({ baseUrl: 'https://bcf.example.test/bcf', getAccessToken: () => LOCAL_BCF_TOKEN,
    fetchFn: (url, init) => fetch(new URL(new URL(String(url)).pathname, peer.baseUrl), init) });
  const gateway = createNativeBcfWriteGateway({ directory, secrets: [LOCAL_BCF_TOKEN] });
  const intent = (title: string) => ({ nodeType: 'bcf.createTopic', operation: 'createTopic' as const,
    baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title } });
  const titles: string[] = [];
  // Digest computation only chooses real fixtures sharing a bucket; every row is
  // subsequently sent through the public gateway to the independently retaining peer.
  for (let index = 0; index < 20_000 && titles.length < 18; index += 1) {
    const title = `Slot sync example ${index}`;
    if (intentDigest(normalizeIntent(intent(title))).startsWith('00')) titles.push(title);
  }
  if (titles.length !== 18) throw new Error('Bounded deterministic same-bucket fixtures unavailable');
  const create = (title: string) => gateway.write(intent(title), () => client.createTopic(LOCAL_BCF_PROJECT, { title }));
  return { directory, peer, gateway, titles, create };
}

it.skipIf(process.platform !== 'linux')('bucket sync calls stay bounded across seventeen actual distinct same-bucket creates and one page (#7374)', async () => {
  const { directory, peer, gateway, titles, create } = await fixture();
  for (const title of titles.slice(0, 4)) await create(title);
  expect(peer.state.acceptedWrites).toBe(4);
  const bucket = join(directory, (await readdir(directory))[0], 'v2', '00');
  const probe = await open(directory, 'r');
  const prototype: FileHandle = Object.getPrototypeOf(probe), original = prototype.sync;
  let syncs = 0;
  const observer = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    if (await readlink(`/proc/self/fd/${this.fd}`) === bucket) syncs += 1;
    return original.call(this);
  });
  try {
    await create(titles[4]);
    expect(peer.state.acceptedWrites).toBe(5);
    const shortScan = syncs;
    expect(shortScan).toBeGreaterThan(0);
    for (const title of titles.slice(5, 16)) await create(title);
    syncs = 0;
    await create(titles[16]);
    expect(peer.state.receivedWriteAttempts).toBe(17);
    expect(peer.state.acceptedWrites).toBe(17);
    expect([...peer.state.topics.values()].map(entry => entry.topic.title)).toEqual(titles.slice(0, 17));
    // Same durability boundaries, independently of preceding capacity-slot count.
    expect(syncs).toBeLessThanOrEqual(shortScan);
    syncs = 0;
    const page = await gateway.listPage({ limit: 1_000 });
    expect(page.entries.map(entry => entry.receipt?.remoteGuid)).toEqual([...peer.state.topics.keys()]);
    expect(page.nextCursor).toBeUndefined();
    expect(syncs).toBe(1);
  } finally { observer.mockRestore(); await probe.close(); }
}, 60_000);

it.skipIf(process.platform !== 'linux')('a visible capacity link with persistent bucket fsync EIO refuses pages and another POST until actual sync recovery (#7374)', async () => {
  const { directory, peer, titles, create } = await fixture();
  const originalGuids: string[] = [];
  for (const title of titles.slice(0, 3)) originalGuids.push((await create(title)).guid);
  expect(peer.state.acceptedWrites).toBe(3);
  const bucket = join(directory, (await readdir(directory))[0], 'v2', '00');
  const probe = await open(directory, 'r');
  const prototype: FileHandle = Object.getPrototypeOf(probe), original = prototype.sync;
  const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    if (await readlink(`/proc/self/fd/${this.fd}`) === bucket) {
      throw Object.assign(new Error('Injected actual bucket sync EIO'), { code: 'EIO' });
    }
    return original.call(this);
  });
  let visible: string;
  const claim = join(bucket, 'slot-3.json');
  try {
    await expect(create(titles[3])).rejects.toThrow('bucket sync EIO');
    expect(peer.state.receivedWriteAttempts).toBe(3);
    expect(peer.state.acceptedWrites).toBe(3);
    visible = await readFile(claim, 'utf8');
    const fresh = createNativeBcfWriteGateway({ directory });
    await expect(fresh.listPage()).rejects.toThrow('bucket sync EIO');
    await expect(create(titles[3])).rejects.toThrow('bucket sync EIO');
    expect(peer.state.receivedWriteAttempts).toBe(3);
    expect(await readFile(claim, 'utf8')).toBe(visible);
  } finally { fault.mockRestore(); await probe.close(); }
  const restored = await createNativeBcfWriteGateway({ directory }).listPage();
  expect(restored.entries.map(entry => entry.receipt?.remoteGuid)).toEqual(originalGuids);
  expect(await readFile(claim, 'utf8')).toBe(visible);
  const fourth = await create(titles[3]);
  expect(peer.state.receivedWriteAttempts).toBe(4);
  expect(peer.state.acceptedWrites).toBe(4);
  expect([...peer.state.topics.keys()]).toEqual([...originalGuids, fourth.guid]);
  expect(await readFile(claim, 'utf8')).toBe(visible);
}, 60_000);
