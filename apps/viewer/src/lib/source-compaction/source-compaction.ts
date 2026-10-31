/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Switch a loaded model's IFC source to block-compressed storage (#2183).
 *
 * The source is the whole file, resident for the model's lifetime because
 * property, attribute and export reads slice it. Until this module existed the
 * block-compressed representation (`compressSourceInPlace`, 342.7 MB -> 67 MB
 * on the reference model, 0.18 ms p50 per block inflate) had no production
 * caller, so every model kept its full source on the main thread.
 *
 * The loader calls {@link compactSource} once a load has completed: geometry
 * workers are done with the shared buffer, finalize and the cache write have
 * run. Compression happens in a short-lived worker over the SAME shared bytes
 * (no copy on the paths that stream into a SharedArrayBuffer), and the swap is
 * IN PLACE on the store's single accessor, so every holder -- the captured
 * entity extractor, the property path, the partial and final stores -- sees it
 * through object identity. See `MutableSourceBytes` for why a replacement
 * would silently save nothing.
 *
 * Reads keep working unchanged through the accessor API; whole-file consumers
 * (IFC export, remesh, clash, overlay parses) inflate on demand through
 * `withMaterialized` / the blocked transfer arm.
 */

import {
  compressSourceInPlace,
  shouldCompressSource,
  sourceBlockStats,
  type CompressedSource,
  type IfcSourceBytes,
} from '@ifc-lite/parser';
import { accountWorkerMessages } from '@ifc-lite/load-trace';
import type { SourceCompressionRequest, SourceCompressionResponse } from './source-compression-protocol.js';

/** Produces the compressed blocks for `bytes`. Injected in tests. */
export type SourceCompressor = (bytes: Uint8Array) => Promise<CompressedSource>;

export type CompactionOutcome = 'compacted' | 'skipped' | 'failed';

export interface CompactSourceOptions {
  compress?: SourceCompressor;
  /** Size gate; defaults to the parser's `shouldCompressSource`. */
  shouldCompress?: (byteLength: number) => boolean;
}

/**
 * Compress in a fresh module worker, terminated as soon as it answers.
 *
 * Fresh per job rather than pooled: compaction runs once per model, long after
 * the load, and an idle pooled worker would keep its heap for the session for
 * nothing.
 */
export const compressInWorker: SourceCompressor = (bytes) => new Promise((resolve, reject) => {
  const worker = accountWorkerMessages(
    new Worker(new URL('./source-compression.worker.ts', import.meta.url), { type: 'module' }),
    'sourceCompression',
  );
  const finish = (settle: () => void) => {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    settle();
  };
  worker.onmessage = (event: MessageEvent<SourceCompressionResponse>) => {
    const response = event.data;
    finish(() => response.ok
      ? resolve(response.payload)
      : reject(new Error(`source compression failed: ${response.message}`)));
  };
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    finish(() => reject(new Error(`source compression worker failed: ${event.message}`)));
  };
  worker.onmessageerror = () => finish(() => reject(new Error('source compression response could not be decoded')));
  const request: SourceCompressionRequest = { id: 1, bytes };
  // No transfer list: `bytes` is the store's own source and must stay valid.
  worker.postMessage(request);
});

/** Sources with a compaction queued or running, so a repeat call is a no-op. */
const pending = new WeakSet<IfcSourceBytes>();

/**
 * Jobs run one at a time. A federation finishes several loads close together;
 * running their compressions concurrently would contend with the next model's
 * geometry workers for CPU and stack every job's transient output at once.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Compact `source` if it is large enough and still resident. Resolves to what
 * happened; never rejects (a failure leaves the source resident and readable,
 * which is exactly the state before the call).
 */
export function compactSource(source: IfcSourceBytes, options: CompactSourceOptions = {}): Promise<CompactionOutcome> {
  const { compress = compressInWorker, shouldCompress = shouldCompressSource } = options;
  if (!source.isResident || !shouldCompress(source.byteLength) || pending.has(source)) {
    return Promise.resolve('skipped');
  }
  pending.add(source);
  const job = queue
    .then(() => runCompaction(source, compress))
    .finally(() => pending.delete(source));
  queue = job;
  return job;
}

async function runCompaction(source: IfcSourceBytes, compress: SourceCompressor): Promise<CompactionOutcome> {
  if (!source.isResident) return 'skipped';
  const startedAt = performance.now();
  let payload: CompressedSource;
  try {
    // The contiguous arm is the resident view itself (no copy, no hash). It is
    // held only by this frame, which ends right after the swap below; nothing
    // here creates a closure over it (the shared-context trap documented in
    // the parser's columnar-parser.ts, #2183).
    const transfer = source.toTransferable();
    if (transfer.kind !== 'contiguous') return 'skipped';
    payload = await compress(transfer.bytes);
  } catch (error) {
    console.warn('[source-compaction] compression failed; the source stays resident:', error);
    return 'failed';
  }
  try {
    if (!compressSourceInPlace(source, payload)) return 'skipped';
  } catch (error) {
    console.warn('[source-compaction] compressed blocks did not match the source; it stays resident:', error);
    return 'failed';
  }
  const stats = sourceBlockStats(source);
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  console.log(
    `[source-compaction] ${mb(source.byteLength)} MB source -> ${mb(stats?.stored ?? 0)} MB blocks `
    + `in ${(performance.now() - startedAt).toFixed(0)} ms`,
  );
  return 'compacted';
}
