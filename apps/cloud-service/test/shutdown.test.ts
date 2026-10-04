/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { CloudSessions } from '../src/sessions.js';
import { DownloadStore, spoolDownload } from '../src/download-file.js';
import { downloadResponse } from '../src/download-response.js';
it('startup removes owned crash leftovers without deleting unrelated files (#6840)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ifclite-cloud-restart-test-'));
  try {
    await mkdir(join(root, 'download-crashed')); await writeFile(join(root, 'download-crashed', 'download'), 'private IFC');
    await writeFile(join(root, 'unrelated'), 'retain');
    const store = new DownloadStore(root); await store.ready;
    expect(await readdir(root)).toEqual(['unrelated']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('shutdown waits for owned cleanup and aborts an unread download (#6840)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ifclite-cloud-drain-test-'));
  const sessions = new CloudSessions({ origin: 'https://viewer.example', apps: {}, downloadDirectory: root });
  try {
    const session = sessions.create('dropbox'); const op = sessions.operation(session);
    const file = await spoolDownload(new Response('ISO-10303-21;'), op.signal, sessions.downloads);
    downloadResponse(file, op.signal, op.done);
    await sessions.close();
    expect(op.signal.aborted).toBe(true); expect(await readdir(root)).toEqual([]);
    expect(() => sessions.create('dropbox')).toThrow('capacity');
  } finally { await sessions.close(); await rm(root, { recursive: true, force: true }); }
});
it('shutdown retains its wait until a cancelled operation actually settles (#6840)', async () => {
  const sessions = new CloudSessions({ origin: 'https://viewer.example', apps: {} });
  const session = sessions.create('dropbox'); const op = sessions.operation(session); let closed = false;
  const closing = sessions.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(op.signal.aborted).toBe(true);
  op.done(); await closing; expect(closed).toBe(true);
});
it('aborting a transfer removes partial spool files before releasing ownership (#6840)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ifclite-cloud-abort-test-')); const store = new DownloadStore(root); await store.ready;
  const controller = new AbortController(); let received: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { received = resolve; });
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(stream) { stream.enqueue(new TextEncoder().encode('partial')); if (++pulls >= 3) received?.(); } });
  try {
    const writing = spoolDownload(new Response(body), controller.signal, store); await pending; controller.abort();
    await expect(writing).rejects.toThrow(); expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
