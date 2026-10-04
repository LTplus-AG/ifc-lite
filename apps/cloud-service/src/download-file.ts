/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { CloudError } from './config.js';
export interface DownloadFile { size: number; stream: ReadableStream<Uint8Array>; dispose: () => Promise<void> }
export class DownloadStore {
  readonly ready: Promise<void>;
  constructor(readonly root: string) { this.ready = this.prepare(); }
  private async prepare(): Promise<void> {
    await mkdir(this.root, { mode: 0o700, recursive: true });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Cloud download directory must be an owned private directory.');
    await chmod(this.root, 0o700);
    // Dedicated single-process runtime directory: remove only our download subdirectories.
    for (const name of await readdir(this.root)) if (name.startsWith('download-')) await rm(join(this.root, name), { recursive: true, force: true });
  }
  async create(): Promise<string> { await this.ready; return mkdtemp(join(this.root, 'download-')); }
}
const stores = new Map<string, DownloadStore>();
export function downloadStore(root = join(tmpdir(), 'ifclite-cloud-service')): DownloadStore {
  let store = stores.get(root); if (!store) { store = new DownloadStore(root); stores.set(root, store); } return store;
}
/** Spool privately before returning bytes, so revision checks cannot report success after a partial transfer. */
export async function spoolDownload(response: Response, signal: AbortSignal, store = downloadStore()): Promise<DownloadFile> {
  const limit = 512 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new CloudError(413, 'too-large', 'Cloud file exceeds the size limit.'); }
  const directory = await store.create(); const path = join(directory, 'download');
  let disposed = false; const dispose = async () => { if (!disposed) { disposed = true; await rm(directory, { recursive: true, force: true }); } };
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { await response.body?.cancel(); await dispose(); throw error; }
  const reader = response.body?.getReader(); let size = 0;
  const abort = () => { void reader?.cancel().catch(() => console.warn('Cloud download stream cancellation failed')); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      while (reader) {
        signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
        size += next.value.byteLength; if (size > limit) throw new CloudError(413, 'too-large', 'Cloud file exceeds the size limit.');
        let offset = 0; while (offset < next.value.byteLength) { const written = await file.write(next.value, offset); offset += written.bytesWritten; }
      }
    } finally {
      signal.removeEventListener('abort', abort);
      try { if (reader) { await reader.cancel(); reader.releaseLock(); } } finally { await file.close(); }
    }
  } catch (error) { await dispose(); throw error; }
  const stream = Readable.toWeb(createReadStream(path, { signal })) as ReadableStream<Uint8Array>;
  return { size, stream, dispose };
}
