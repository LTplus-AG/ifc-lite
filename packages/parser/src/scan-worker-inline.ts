/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inline Web Worker for IFC entity scanning.
 *
 * Moves the 7-8s entity scanning off the main thread so geometry streaming
 * and UI remain responsive. The scanning logic is embedded as a string to
 * avoid bundler/import issues with Web Workers.
 */

export interface EntityRefWorkerResult {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
}

/**
 * Self-contained entity scanner code (runs inside Web Worker).
 * This is the same algorithm as StepTokenizer.scanEntitiesFast() but
 * written as a standalone function for worker embedding.
 */
const WORKER_CODE = `
'use strict';
self.onmessage = function(e) {
  var buf = new Uint8Array(e.data);
  var len = buf.length;
  var pos = 0;
  var line = 1;

  // Pre-allocate result array (estimate ~13,500 entities per MB)
  var estimatedCount = Math.max((len / 1024 / 1024) * 13500, 1000) | 0;
  // Pack results into typed arrays for fast transfer
  var ids = new Uint32Array(estimatedCount);
  var offsets = new Uint32Array(estimatedCount);
  var lengths = new Uint32Array(estimatedCount);
  var lines = new Uint32Array(estimatedCount);
  // Type names stored separately (strings)
  var types = new Array(estimatedCount);
  var count = 0;

  // Type name cache (IFC files have ~776 unique types across millions of entities)
  var typeCache = new Map();

  function growArrays() {
    var newSize = (count * 2) | 0;
    var newIds = new Uint32Array(newSize);
    newIds.set(ids);
    ids = newIds;
    var newOffsets = new Uint32Array(newSize);
    newOffsets.set(offsets);
    offsets = newOffsets;
    var newLengths = new Uint32Array(newSize);
    newLengths.set(lengths);
    lengths = newLengths;
    var newLines = new Uint32Array(newSize);
    newLines.set(lines);
    lines = newLines;
    types.length = newSize;
  }

  while (pos < len) {
    var ch = buf[pos];

    if (ch === 0x23) { // '#'
      var startOffset = pos;
      var startLine = line;
      pos++;

      // Read express ID
      var expressId = 0;
      var hasDigits = false;
      while (pos < len) {
        var c = buf[pos];
        if (c >= 0x30 && c <= 0x39) {
          expressId = expressId * 10 + (c - 0x30);
          hasDigits = true;
          pos++;
        } else {
          break;
        }
      }
      if (!hasDigits) continue;

      // Skip whitespace
      while (pos < len) {
        var c2 = buf[pos];
        if (c2 === 0x20 || c2 === 0x09 || c2 === 0x0D) { pos++; }
        else if (c2 === 0x0A) { line++; pos++; }
        else break;
      }

      // Check for '='
      if (pos >= len || buf[pos] !== 0x3D) continue;
      pos++;

      // Skip whitespace
      while (pos < len) {
        var c3 = buf[pos];
        if (c3 === 0x20 || c3 === 0x09 || c3 === 0x0D) { pos++; }
        else if (c3 === 0x0A) { line++; pos++; }
        else break;
      }

      // Read type name
      var typeStart = pos;
      if (pos >= len || buf[pos] < 0x41 || buf[pos] > 0x5A) continue;

      while (pos < len) {
        var c4 = buf[pos];
        if ((c4 >= 0x41 && c4 <= 0x5A) || (c4 >= 0x61 && c4 <= 0x7A) ||
            (c4 >= 0x30 && c4 <= 0x39) || c4 === 0x5F) {
          pos++;
        } else {
          break;
        }
      }
      if (pos === typeStart) continue;

      // Cache type name — use length + hash compound key and verify on hit
      // to avoid silent collisions from 32-bit hash alone.
      var typeLen = pos - typeStart;
      var typeHash = typeLen;
      for (var i = typeStart; i < pos; i++) {
        typeHash = (typeHash * 31 + buf[i]) | 0;
      }
      var cacheKey = typeLen + ':' + typeHash;
      var typeName = typeCache.get(cacheKey);
      if (typeName === undefined || typeName.length !== typeLen) {
        typeName = String.fromCharCode.apply(null, buf.subarray(typeStart, pos));
        typeCache.set(cacheKey, typeName);
      }

      // Skip whitespace
      while (pos < len) {
        var c5 = buf[pos];
        if (c5 === 0x20 || c5 === 0x09 || c5 === 0x0D) { pos++; }
        else if (c5 === 0x0A) { line++; pos++; }
        else break;
      }

      // Check for '('
      if (pos >= len || buf[pos] !== 0x28) continue;

      // Skip to semicolon (handling strings)
      var inString = false;
      while (pos < len) {
        var c6 = buf[pos];
        if (c6 === 0x27) { // quote
          if (inString && pos + 1 < len && buf[pos + 1] === 0x27) {
            pos += 2;
            continue;
          }
          inString = !inString;
        } else if (c6 === 0x3B && !inString) { // semicolon
          var entityLength = pos - startOffset + 1;

          // Grow if needed
          if (count >= ids.length) growArrays();

          ids[count] = expressId;
          offsets[count] = startOffset;
          lengths[count] = entityLength;
          lines[count] = startLine;
          types[count] = typeName;
          count++;

          pos++;
          break;
        } else if (c6 === 0x0A) {
          line++;
        }
        pos++;
      }
    } else if (ch === 0x0A) {
      line++;
      pos++;
    } else {
      pos++;
    }
  }

  // Trim arrays once, reuse for both message and transfer list
  var needsTrim = ids.buffer.byteLength > count * 4;
  var trimmedIds = needsTrim ? ids.slice(0, count) : ids;
  var trimmedOffsets = needsTrim ? offsets.slice(0, count) : offsets;
  var trimmedLengths = needsTrim ? lengths.slice(0, count) : lengths;
  var trimmedLines = needsTrim ? lines.slice(0, count) : lines;
  self.postMessage({
    ids: trimmedIds.buffer,
    offsets: trimmedOffsets.buffer,
    lengths: trimmedLengths.buffer,
    lines: trimmedLines.buffer,
    types: types.slice(0, count),
    count: count,
  }, [
    trimmedIds.buffer,
    trimmedOffsets.buffer,
    trimmedLengths.buffer,
    trimmedLines.buffer,
  ]);
};
`;

let workerBlobUrl: string | null = null;

function getWorkerBlobUrl(): string {
  if (!workerBlobUrl) {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

/**
 * Scan IFC entities in a Web Worker (non-blocking).
 * Sends a structured clone of the buffer to the worker (browser handles copy).
 * Caller keeps the original buffer intact for columnar parsing.
 */
export function scanEntitiesInWorker(
  buffer: ArrayBuffer | SharedArrayBuffer,
): Promise<EntityRefWorkerResult[]> {
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(getWorkerBlobUrl());

      worker.onmessage = (e: MessageEvent) => {
        const { ids, offsets, lengths, lines, types, count } = e.data;
        const idArr = new Uint32Array(ids);
        const offsetArr = new Uint32Array(offsets);
        const lengthArr = new Uint32Array(lengths);
        const lineArr = new Uint32Array(lines);

        const refs: EntityRefWorkerResult[] = new Array(count);
        for (let i = 0; i < count; i++) {
          refs[i] = {
            expressId: idArr[i],
            type: types[i],
            byteOffset: offsetArr[i],
            byteLength: lengthArr[i],
            lineNumber: lineArr[i],
          };
        }

        worker.terminate();
        resolve(refs);
      };

      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(`Scan worker error: ${e.message}`));
      };

      // Send buffer copy to worker (structured clone — browser copies efficiently).
      // Do NOT transfer: caller needs the original buffer for columnar parsing.
      worker.postMessage(buffer);
    } catch (err) {
      reject(err);
    }
  });
}
