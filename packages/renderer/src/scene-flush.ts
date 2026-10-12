/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { LoadTrace } from '@ifc-lite/load-trace';

interface FlushOptions {
  budgetMs: number;
  maxIndicesPerAppend: number;
  trace?: LoadTrace;
  deterministicUploads: boolean;
}

/** Drain bounded streaming work. Count cohorts use one mesh per append so
 * fragment creation is independent of arrival timing and frame boundaries.
 * Both modes preserve the index-volume cap and advance before GPU allocation. */
export function flushQueuedMeshes(
  queue: MeshData[], readIndex: number,
  append: (meshes: MeshData[], nextReadIndex: number) => void,
  options: FlushOptions,
): { queue: MeshData[]; readIndex: number; processed: number } {
  if (readIndex >= queue.length) return { queue, readIndex, processed: 0 };
  const countMode = options.deterministicUploads;
  const maxMeshes = countMode ? 512 : 4096;
  const meshesPerAppend = countMode ? 1 : 512;
  const start = performance.now();
  let processed = 0;
  let processedIndices = 0;
  while (readIndex < queue.length && processed < maxMeshes) {
    if (processed > 0) {
      if (countMode) {
        if (!(processedIndices + queue[readIndex].indices.length <= options.maxIndicesPerAppend)) break;
      } else if (performance.now() - start >= options.budgetMs) break;
    }
    const hardEnd = Math.min(queue.length, readIndex + meshesPerAppend, readIndex + maxMeshes - processed);
    const chunkEnd = computeFlushChunkEnd((i) => queue[i].indices.length, readIndex, hardEnd, options.maxIndicesPerAppend);
    // Preserve progress even for an oversize first mesh; a broken cursor must
    // stop instead of spinning forever without allocating or serving workers.
    if (chunkEnd === readIndex) break;
    const chunk = queue.slice(readIndex, chunkEnd);
    readIndex = chunkEnd;
    append(chunk, readIndex);
    processed += chunk.length;
    if (countMode) processedIndices += chunk[0].indices.length;
  }
  if (readIndex >= queue.length) {
    queue.length = 0;
    readIndex = 0;
  } else if (readIndex >= 8192 && readIndex * 2 >= queue.length) {
    queue = queue.slice(readIndex);
    readIndex = 0;
  }
  if (processed > 0 && options.trace?.enabled) {
    options.trace.record('scene.flushPending', start, performance.now(), {
      meshes: processed, queued: queue.length - readIndex,
      ...(countMode ? { uploadMode: 'count' } : {}),
    });
  }
  return { queue, readIndex, processed };
}

/**
 * Pure helper: compute the exclusive end index of the next flushPending()
 * append chunk, starting at `readIndex` and bounded by BOTH mesh count
 * (`hardEnd`, computed by the caller) and index volume (`maxIndicesPerAppend`).
 * Always takes at least one mesh past `readIndex` -- a single oversize mesh is
 * split upstream by splitMeshForStreaming, so the volume cap never blocks the
 * first mesh of a chunk.
 *
 * Non-finite-safe by construction: every non-finite `next` (a malformed mesh
 * reporting NaN, +Infinity, or -Infinity for `indices.length`) closes the
 * chunk explicitly instead of being folded into the running `chunkIndices`
 * total. Only NaN would have made a naive cap check `chunkIndices + next >
 * maxIndicesPerAppend` silently `false` forever (`NaN > cap` is always
 * `false`); +Infinity actually made that same check fire immediately
 * (`chunkIndices + Infinity > cap` is `true`), closing the chunk after a
 * single oversize mesh instead of growing it unbounded. The current
 * `!(chunkIndices + next <= maxIndicesPerAppend)` form below rejects both
 * NaN and +Infinity explicitly rather than relying on that asymmetry.
 * -Infinity needed a separate, explicit check: `-Infinity <= cap` is always
 * `true`, so `!(... <= cap)` lets it straight through, and folding it into
 * `chunkIndices` would poison the running total to -Infinity permanently,
 * keeping the cap vacuous for every mesh after it, not just the malformed
 * one.
 */
export function computeFlushChunkEnd(
  getIndicesLength: (meshIndex: number) => number,
  readIndex: number,
  hardEnd: number,
  maxIndicesPerAppend: number,
): number {
  let chunkEnd = readIndex;
  let chunkIndices = 0;
  while (chunkEnd < hardEnd) {
    const next = getIndicesLength(chunkEnd);
    if (!Number.isFinite(next)) {
      // A malformed mesh reporting a non-finite indices.length (NaN, +/-Infinity)
      // must close the chunk here rather than being folded into chunkIndices:
      // `chunkIndices += -Infinity` would poison the running total to -Infinity
      // permanently, making `!(chunkIndices + next <= maxIndicesPerAppend)`
      // false forever and letting the volume cap never fire again for the
      // rest of this chunk. Always take at least the first mesh past
      // readIndex (same progress guarantee as the NaN case below).
      if (chunkEnd === readIndex) chunkEnd++;
      break;
    }
    if (chunkEnd > readIndex && !(chunkIndices + next <= maxIndicesPerAppend)) {
      break;
    }
    chunkIndices += next;
    chunkEnd++;
  }
  return chunkEnd;
}

