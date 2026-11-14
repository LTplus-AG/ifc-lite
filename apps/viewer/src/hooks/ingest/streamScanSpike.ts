/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SPIKE (untimed measurement, flag `?streamScan=a|ab`; never on by default).
 *
 * a:  at the pick, start the source fingerprint (from Blob slices, the same
 *     windows as the buffer fingerprint) and spawn the geometry pool; the load
 *     adopts the pool. The file is read and scanned as today.
 * ab: a, plus: a worker streams the File into a SharedArrayBuffer and the pool
 *     scans fixed 8 MiB ranges as they land; the load adopts the stitched-ready
 *     shards and skips its own shard scan.
 *
 * Plain .ifc primary loads of at least MIN_BYTES only, so #9900's small-file
 * fast path (< 10 MiB) is untouched. The parser spare is claimed by
 * WorkerParser as on every load.
 */
import {
  compileSharedWasmModule, offerPoolAdoption, planLoadWorkerCount, spawnGeometryWorker, withdrawPoolAdoption,
  type PoolAdoption, type ShardColumns,
} from '@ifc-lite/geometry';
import { computeSourceFingerprintFromBlob, type SourceFingerprint } from '@ifc-lite/cache';
import type { AcquiredBuffer } from '@/utils/acquireFileBuffer';

export type StreamScanMode = 'off' | 'a' | 'ab';

export const STREAM_SCAN_MIN_BYTES = 16 * 1024 * 1024;
const RANGE_BYTES = 8 * 1024 * 1024;
const SLACK_BYTES = 2 * 1024 * 1024;

export function streamScanMode(): StreamScanMode {
  if (typeof location === 'undefined') return 'off';
  const params = new URLSearchParams(location.search);
  if (params.get('streamScanDigest') === '1') (globalThis as { __streamScanDigest?: boolean }).__streamScanDigest = true;
  const v = params.get('streamScan');
  return v === 'a' || v === 'ab' ? v : 'off';
}

export interface StreamScanSession {
  file: File;
  mode: 'a' | 'ab';
  fingerprint: Promise<SourceFingerprint>;
  /** mode ab: resolves when every byte is in the SAB. */
  read: Promise<AcquiredBuffer> | null;
  adoption: PoolAdoption;
  marks: { pick: number; readDone?: number; firstSlice?: number; scansDone?: number; rescans: number; slices: number };
  dispose(): void;
}

let current: StreamScanSession | null = null;

export function startStreamScanAtPick(file: File, eligible: boolean, workerCountOverride: number | undefined): void {
  current?.dispose();
  current = null;
  const mode = streamScanMode();
  if (mode === 'off' || !eligible || !/\.ifc$/i.test(file.name) || file.size < STREAM_SCAN_MIN_BYTES) return;
  if (typeof SharedArrayBuffer === 'undefined' || typeof Worker === 'undefined' || !globalThis.crossOriginIsolated) return;
  const marks: StreamScanSession['marks'] = { pick: performance.now(), rescans: 0, slices: 0 };
  const fingerprint = computeSourceFingerprintFromBlob(file);
  const { count } = planLoadWorkerCount(file.size / (1024 * 1024), workerCountOverride);
  const workers = Array.from({ length: count }, () => spawnGeometryWorker());

  if (mode === 'a') {
    const adoption: PoolAdoption = { sab: null, byteLength: file.size, workers, shards: null };
    offerPoolAdoption(adoption);
    current = { file, mode, fingerprint, read: null, adoption, marks, dispose: () => withdrawPoolAdoption(adoption) };
    console.log(`[spike] streamScan=a: ${count} workers spawned at pick for ${file.name}`);
    return;
  }

  const len = file.size;
  const sab = new SharedArrayBuffer(len);
  const watermark = new SharedArrayBuffer(4);
  const reader = new Worker(new URL('../../workers/stream-reader.worker.ts', import.meta.url), { type: 'module' });
  const rangeCount = Math.ceil(len / RANGE_BYTES);
  const results: (ShardColumns | null)[] = new Array(rangeCount).fill(null);
  const sliceEnds: number[] = new Array(rangeCount).fill(0);
  let remaining = rangeCount;
  let next = 0;
  let landed = 0;
  let readComplete = false;
  let disposed = false;

  let resolveShards!: (v: ShardColumns[] | null) => void;
  const shards = new Promise<ShardColumns[] | null>((r) => { resolveShards = r; });
  let resolveRead!: (v: AcquiredBuffer) => void;
  let rejectRead!: (e: Error) => void;
  const read = new Promise<AcquiredBuffer>((res, rej) => { resolveRead = res; rejectRead = rej; });

  const rangeOf = (i: number) => ({ rangeStart: i * RANGE_BYTES, rangeEnd: Math.min(len, (i + 1) * RANGE_BYTES) });
  const post = (i: number, sliceEnd: number) => {
    const { rangeStart, rangeEnd } = rangeOf(i);
    sliceEnds[i] = sliceEnd;
    marks.firstSlice ??= performance.now();
    workers[i % workers.length].postMessage({ type: 'scan-slice', sharedBuffer: sab, sliceIndex: i, rangeStart, rangeEnd, sliceEnd });
  };
  // Ranges go out in file order once the bytes past their end (plus slack) have landed.
  let inited = false;
  const dispatch = () => {
    if (!inited || disposed) return;
    while (next < rangeCount) {
      const need = Math.min(len, rangeOf(next).rangeEnd + SLACK_BYTES);
      if (landed < need) break;
      post(next++, need);
    }
  };
  const onSlice = (e: MessageEvent) => {
    const msg = e.data as { type?: string; sliceIndex?: number } & Partial<ShardColumns>;
    if (msg?.type !== 'slice-result' || disposed) return;
    const i = msg.sliceIndex as number;
    // A slice that ran out before the next record began reports handoff -1 short of EOF:
    // scan it again once the whole file is in.
    if ((msg.handoff as number) < 0 && sliceEnds[i] < len) {
      marks.rescans++;
      const retry = () => post(i, len);
      if (readComplete) retry(); else void read.then(retry, () => {});
      return;
    }
    results[i] = {
      ids: msg.ids as Uint32Array, starts: msg.starts as Uint32Array, lengths: msg.lengths as Uint32Array,
      classes: msg.classes as Uint8Array, handoff: msg.handoff as number,
      oversizedIdStarts: (msg.oversizedIdStarts as Uint32Array | undefined) ?? new Uint32Array(0),
      malformedStart: msg.malformedStart as number | undefined,
    };
    marks.slices++;
    if (--remaining === 0) {
      marks.scansDone = performance.now();
      for (const w of workers) w.removeEventListener('message', onSlice);
      resolveShards(results as ShardColumns[]);
    }
  };
  for (const w of workers) w.addEventListener('message', onSlice);

  void compileSharedWasmModule().then((module) => {
    if (disposed) return;
    for (const w of workers) w.postMessage({ type: 'init', wasmModule: module ?? undefined });
    inited = true;
    dispatch();
  });

  reader.onmessage = (e: MessageEvent<{ type: string; bytes?: number; message?: string }>) => {
    const msg = e.data;
    if (msg.type === 'progress') { landed = msg.bytes ?? landed; dispatch(); return; }
    if (msg.type === 'done') {
      landed = len;
      readComplete = true;
      marks.readDone = performance.now();
      reader.terminate();
      dispatch();
      resolveRead({ buffer: sab, view: new Uint8Array(sab), isShared: true });
      return;
    }
    reader.terminate();
    resolveShards(null);
    rejectRead(new Error(`streamScan read failed: ${msg.message ?? 'unknown'}`));
  };
  reader.onerror = (ev) => { resolveShards(null); rejectRead(new Error(`streamScan reader failed: ${ev.message}`)); };
  reader.postMessage({ type: 'start', file, sab, watermark });

  const adoption: PoolAdoption = { sab, byteLength: len, workers, shards };
  offerPoolAdoption(adoption);
  current = {
    file, mode, fingerprint, read, adoption, marks,
    dispose: () => { disposed = true; reader.terminate(); resolveShards(null); withdrawPoolAdoption(adoption); },
  };
  console.log(`[spike] streamScan=ab: ${count} workers, ${rangeCount} ranges of ${RANGE_BYTES >> 20} MiB for ${file.name}`);
}

/** The pick-time session for this file, if one was started. */
export function streamScanSessionFor(file: File): StreamScanSession | null {
  return current && current.file === file ? current : null;
}
