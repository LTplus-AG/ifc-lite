/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BcfPublicationStore } from './bcf-publication-store.js';

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bcf-store-path-'));
  cleanup.push(root);
  const target = join(root, 'target'), alias = join(root, 'alias');
  await mkdir(target);
  await symlink(target, alias, 'dir');
  return { root, target, alias };
}

// #7461's parent durability walk must support macOS /var -> /private/var.
it.each([false, true])('publishes below a symlinked ancestor with an existing namespace: %s (#7461)', async existing => {
  const { root, target, alias } = await fixture();
  const tail = ['missing', 'outbox', 'namespace'];
  if (existing) await mkdir(join(target, ...tail), { recursive: true });
  const store = new BcfPublicationStore(join(alias, ...tail));
  await store.prepare();
  const canonical = join(await realpath(target), ...tail);
  // `directory` keeps the configured path; `identity` (and all I/O) is the resolved one.
  expect(store.directory).toBe(join(alias, ...tail));
  expect((await lstat(join(canonical, 'v2'))).isDirectory()).toBe(true);
  const other = join(root, 'other');
  await mkdir(other);
  await rm(alias); await symlink(other, alias, 'dir');
  const digest = 'a'.repeat(64), filename = `${digest}-1.intent.json`;
  const value = { fixture: 'immutable publication through a canonical parent' };
  await store.publish(filename, value);
  expect(JSON.parse(await readFile(join(canonical, 'v2', 'aa', digest, filename), 'utf8'))).toEqual(value);
  await store.prepare(); // Reuse keeps the canonical path and validates the namespace again.
  expect(await readdir(other)).toEqual([]);
});

it('still refuses a symlinked namespace itself without writing into its target (#7461)', async () => {
  const { root, target, alias } = await fixture();
  const namespace = join(root, 'namespace');
  await symlink(target, namespace, 'dir');
  await expect(new BcfPublicationStore(namespace).prepare()).rejects.toThrow('invalid namespace directory');
  await expect(new BcfPublicationStore(alias).prepare()).rejects.toThrow('invalid namespace directory');
  expect(await readdir(target)).toEqual([]);
});

it('still refuses a symlinked v2 directory below a canonical parent (#7461)', async () => {
  const { target, alias } = await fixture();
  const namespace = join(target, 'namespace'), content = join(target, 'content');
  await mkdir(namespace); await mkdir(content);
  await symlink(content, join(namespace, 'v2'), 'dir');
  await expect(new BcfPublicationStore(join(alias, 'namespace')).prepare()).rejects.toThrow('old flat publication layout');
  expect(await readdir(content)).toEqual([]);
});

it('gives every configured alias of one outbox the same identity (#7461)', async () => {
  const { target, alias } = await fixture();
  const viaAlias = new BcfPublicationStore(join(alias, 'namespace'));
  const viaTarget = new BcfPublicationStore(join(target, 'namespace'));
  expect(() => viaAlias.identity).toThrow(/before its outbox was resolved/);
  await Promise.all([viaAlias.prepare(), viaAlias.prepare(), viaTarget.prepare()]);
  expect(viaAlias.identity).toBe(viaTarget.identity);
  expect(viaAlias.identity).toBe(join(await realpath(target), 'namespace'));
  expect(viaAlias.directory).toBe(join(alias, 'namespace'));
});

it('refuses a dangling symlinked ancestor instead of surfacing a raw ENOENT (#7461)', async () => {
  const { root } = await fixture();
  const dangling = join(root, 'dangling');
  await symlink(join(root, 'deleted'), dangling, 'dir');
  await expect(new BcfPublicationStore(join(dangling, 'namespace')).prepare()).rejects.toThrow('invalid publication ancestor');
});

/** Run `body` with `process.getuid` replaced, so the store sees the test's own links as owned by
 * another account (or, with `undefined`, by a platform without POSIX uids). */
async function withUid(uid: (() => number) | undefined, body: () => Promise<void>) {
  const getuid = process.getuid;
  try { process.getuid = uid; await body(); } finally { process.getuid = getuid; }
}
const realUid = process.getuid?.();

// The fixture's links are owned by the test user; root-owned links are always trusted, so this
// cannot be modelled when the suite itself runs as root.
it.skipIf(realUid === undefined || realUid === 0)('refuses a symlinked ancestor owned by another user (#7461)', async () => {
  const { target, alias } = await fixture();
  await withUid(() => realUid! + 1, async () => {
    await expect(new BcfPublicationStore(join(alias, 'namespace')).prepare())
      .rejects.toThrow('publication ancestor is a symlink owned by another user');
  });
  expect(await readdir(target)).toEqual([]);
});

it('refuses symlinked ancestors where ownership cannot be checked (Windows, #7461)', async () => {
  const { target, alias } = await fixture();
  await withUid(undefined, async () => {
    await expect(new BcfPublicationStore(join(alias, 'namespace')).prepare())
      .rejects.toThrow('publication ancestor is a symlink owned by another user');
  });
  expect(await readdir(target)).toEqual([]);
});

it('resolves chained owned links to the final directory (#7461)', async () => {
  const { root, target, alias } = await fixture();
  const chain = join(root, 'chain');
  await symlink(alias, chain, 'dir');
  const store = new BcfPublicationStore(join(chain, 'namespace'));
  await store.prepare();
  expect(store.identity).toBe(join(await realpath(target), 'namespace'));
});

it('resolves a relative link target from the link directory (#7461)', async () => {
  const { root, target } = await fixture();
  const relative = join(root, 'relative');
  await symlink('target', relative, 'dir');
  const store = new BcfPublicationStore(join(relative, 'namespace'));
  await store.prepare();
  expect(store.identity).toBe(join(await realpath(target), 'namespace'));
});

it('refuses a dangling link reached through another link (#7461)', async () => {
  const { root, alias } = await fixture();
  const dangling = join(root, 'dangling');
  await symlink(join(root, 'deleted'), dangling, 'dir');
  await rm(alias);
  await symlink(dangling, alias, 'dir');
  await expect(new BcfPublicationStore(join(alias, 'namespace')).prepare()).rejects.toThrow('invalid publication ancestor');
});

it('resolves .. in a link target after resolving its preceding link (#7461)', async () => {
  const { root, target, alias } = await fixture();
  await mkdir(join(target, 'child'));
  const nested = join(root, 'nested'), relative = join(root, 'relative');
  await symlink(join(alias, 'child'), nested, 'dir');
  // Keep .. literal: lexical normalization would incorrectly choose root/namespace.
  await symlink('nested/..', relative, 'dir');
  const store = new BcfPublicationStore(join(relative, 'namespace'));
  await store.prepare();
  expect(store.identity).toBe(join(await realpath(target), 'namespace'));
});

it('bounds cyclic ancestor links (#7461)', async () => {
  const { root } = await fixture();
  const cycle = join(root, 'cycle');
  await symlink('cycle', cycle, 'dir');
  await expect(new BcfPublicationStore(join(cycle, 'namespace')).prepare()).rejects.toThrow('publication ancestor has too many symlinks');
});

it('bounds the resolved path, not just the configured one (#7461)', async () => {
  // A short configured path that only exceeds the bound once its link is followed, so the
  // up-front check passes and the post-resolution bound is what refuses it.
  const { root } = await fixture();
  const deep = join(root, ...Array<string>(128).fill('d'));
  await mkdir(deep, { recursive: true });
  const shortcut = join(root, 'shortcut');
  await symlink(deep, shortcut, 'dir');
  await expect(new BcfPublicationStore(join(shortcut, 'namespace')).prepare())
    .rejects.toThrow('configured outbox exceeds directory depth bound');
  expect(await readdir(deep)).toEqual([]);
});

it('refuses an outbox of exactly 128 path components before any I/O (#7461)', async () => {
  const deep = join('/', ...Array.from({ length: 127 }, (_, i) => `d${i}`), 'namespace');
  // Refused by the bound itself, before any filesystem access under '/'.
  await expect(new BcfPublicationStore(deep).prepare()).rejects.toThrow('configured outbox exceeds directory depth bound');
});
