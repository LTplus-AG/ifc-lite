/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { safeUtf8Decode } from '@ifc-lite/data';
import { buildEntityRefsFromIndex } from './entity-refs-from-index.js';
import { MAX_EXPRESS_ID } from './express-id.js';
import { scanEntitiesInWorker } from './scan-worker-inline.js';
import { StepTokenizer } from './tokenizer.js';
import type { EntityRef } from './types.js';

export type EntityScanPath = 'worker' | 'wasm' | 'tokenizer' | 'pre-scanned';

export interface PreScannedEntityIndex {
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
  /**
   * How many records the pre-pass that produced these columns refused because
   * their express id is outside the u32 storage contract (#3395).
   *
   * It has to travel with the columns: a refused record is absent from `ids`
   * by construction, so this side cannot recount it. Optional because a host
   * on an older wasm build sends the three columns and nothing else — treat
   * `undefined` as "this producer does not report", which is not the same
   * claim as `0`, and is why the wasm pre-pass now always sets it.
   */
  oversizedIdCount?: number;
}

export interface WasmScanApi {
  scanEntitiesFastBytes?: (data: Uint8Array) => unknown;
  scanEntitiesFast?: (content: string) => unknown;
}

export interface EntityScanOptions {
  onProgress?: (progress: { phase: string; percent: number }) => void;
  onDiagnostic?: (message: string) => void;
  wasmApi?: WasmScanApi;
  disableWorkerScan?: boolean;
  preScannedEntityIndex?: PreScannedEntityIndex;
}

export interface EntityScanResult {
  entityRefs: EntityRef[];
  processed: number;
  elapsedMs: number;
  scanPath: EntityScanPath;
  /**
   * How many records the scan refused because their express id is outside the
   * u32 storage contract (#3395).
   *
   * Counted on every path but one. `worker` and `tokenizer` count here;
   * `pre-scanned` carries the count from the geometry pre-pass through the
   * `set-entity-index` handoff (`PreScannedEntityIndex.oversizedIdCount`),
   * which is the path the viewer takes for every SAB-backed worker load of a
   * file at or above 2 MB (`useIfcLoader.ts`'s `geometryWillEmitEntityIndex`).
   *
   * The one exception is `wasm`: `scanEntitiesFast` returns entity refs and
   * nothing else, so the count does not cross that boundary. Rust reports the
   * refusal itself there, to the browser console
   * (`rust/wasm-bindings/src/api/parsing.rs`), so it is visible even though
   * the number is not — a zero on THAT path still is not proof of none.
   */
  oversizedIdCount: number;
}

type WasmScanFunction = () => unknown;

const HUGE_STRING_SCAN_BYTES = 256 * 1024 * 1024;

export async function scanIfcEntities(
  buffer: ArrayBuffer | SharedArrayBuffer,
  options: EntityScanOptions = {},
): Promise<EntityScanResult> {
  const uint8Buffer = new Uint8Array(buffer);
  const fileSizeMB = buffer.byteLength / (1024 * 1024);

  options.onProgress?.({ phase: 'scanning', percent: 0 });
  const scanStartTime = performance.now();

  let entityRefs: EntityRef[] = [];
  let processed = 0;
  let scanPath: EntityScanPath = 'tokenizer';
  let oversizedIdCount = 0;
  let preScanCountUnreported = false;

  if (options.preScannedEntityIndex) {
    const { ids, starts, lengths } = options.preScannedEntityIndex;
    entityRefs = buildEntityRefsFromIndex(uint8Buffer, ids, starts, lengths);
    processed = entityRefs.length;
    scanPath = 'pre-scanned';
    // `undefined` means this producer does not report, which the field's own
    // doc says is NOT the claim `0` makes. Coercing it here would turn "not
    // counted" into "none refused" — the exact conflation #3395 exists to
    // remove, reintroduced at the handoff. The number still reads 0 because the
    // contract is `number`, so the honesty has to live in the REPORT: an
    // unreported count is announced rather than passed off as a clean scan.
    oversizedIdCount = options.preScannedEntityIndex.oversizedIdCount ?? 0;
    preScanCountUnreported = options.preScannedEntityIndex.oversizedIdCount === undefined;
  }

  if (entityRefs.length === 0 && !options.disableWorkerScan && typeof Worker !== 'undefined') {
    try {
      const scan = await scanEntitiesInWorker(buffer);
      entityRefs = scan.refs;
      oversizedIdCount = scan.oversizedIdCount;
      processed = entityRefs.length;
      scanPath = 'worker';
    } catch (error) {
      console.warn('[IfcParser] Worker scan failed, falling back to main thread:', error);
      entityRefs = [];
      processed = 0;
      oversizedIdCount = 0;
    }
  }

  const wasmScanFn = selectWasmScanFunction(options.wasmApi, uint8Buffer);
  if (entityRefs.length === 0 && wasmScanFn) {
    try {
      entityRefs = normalizeWasmEntityRefs(wasmScanFn());
      processed = entityRefs.length;
      scanPath = 'wasm';
      // Cleared, not carried: `scanEntitiesFast` hands back refs and nothing
      // else, so this path has no count of its own (Rust reports the refusal
      // straight to the console instead). Leaving an earlier path's number
      // here would attribute it to a scan that never produced it. The two
      // sibling branches already set their own; this one says zero out loud
      // rather than by omission (#3395).
      oversizedIdCount = 0;
    } catch (error) {
      console.warn('[IfcParser] WASM scan failed, falling back to TypeScript:', error);
      entityRefs = [];
      processed = 0;
    }
  }

  if (entityRefs.length === 0) {
    const tokenizer = new StepTokenizer(uint8Buffer);
    const yieldInterval = 5000;
    const estimatedTotalEntities = Math.max(fileSizeMB * 13500, 10000);

    for (const ref of tokenizer.scanEntitiesFast()) {
      entityRefs.push({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });

      processed++;
      if (processed % yieldInterval === 0) {
        const scanPercent = Math.min(95, (processed / estimatedTotalEntities) * 95);
        options.onProgress?.({ phase: 'scanning', percent: scanPercent });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    oversizedIdCount = tokenizer.oversizedIdCount;
  }

  // A refused record is a record the caller will not find. Say so on both
  // channels the loader already watches, rather than letting the model come
  // back quietly short (#3395).
  if (oversizedIdCount > 0) {
    const message =
      `scan: skipped ${oversizedIdCount} record(s) with an express id above ${MAX_EXPRESS_ID} (#3395)`;
    console.warn(`[IfcParser] ${message}`);
    options.onDiagnostic?.(message);
  } else if (preScanCountUnreported && scanPath === 'pre-scanned') {
    // Absence has to look different from success. This producer sent the
    // columns without a refusal count, so a zero here is not evidence of none
    // — say that, rather than returning a result that reads like a clean scan.
    const message =
      'scan: the pre-pass that produced this entity index does not report refused ' +
      `express ids (#3395), so a count of 0 is not proof that none were skipped`;
    console.warn(`[IfcParser] ${message}`);
    options.onDiagnostic?.(message);
  }

  const elapsedMs = performance.now() - scanStartTime;
  options.onDiagnostic?.(`scan complete: entities=${processed} elapsed=${elapsedMs.toFixed(0)}ms`);
  options.onProgress?.({ phase: 'scanning', percent: 100 });

  return { entityRefs, processed, elapsedMs, scanPath, oversizedIdCount };
}

/**
 * Whether the byte-level WASM scan may run for a source of this size.
 *
 * `scanEntitiesFastBytes` copies the whole buffer into wasm32 linear memory
 * and builds the entity index alongside it, inside a 4GB address space. Above
 * this ceiling the allocator aborts with a bare `unreachable executed` trap —
 * the scan can never succeed, so attempting it only burns seconds and logs a
 * frightening wasm panic before the JS tokeniser fallback runs anyway.
 * Mirrors the geometry prepass's 2.5GB huge-file heuristic (#1630): the file
 * copy plus the index for a 2.5GB source stays under the ceiling; beyond it
 * the copy alone leaves no headroom.
 */
export function wasmBytesScanAllowed(byteLength: number): boolean {
  return byteLength < 2_500_000_000;
}

function selectWasmScanFunction(api: WasmScanApi | undefined, uint8Buffer: Uint8Array): WasmScanFunction | null {
  if (!api) return null;

  if (typeof api.scanEntitiesFastBytes === 'function') {
    if (!wasmBytesScanAllowed(uint8Buffer.byteLength)) {
      console.warn(
        '[parser] scanEntitiesFastBytes skipped: source is %d MB, exceeds the wasm32 memory ceiling - falling back to JS tokeniser.',
        Math.round(uint8Buffer.byteLength / (1024 * 1024)),
      );
      return null;
    }
    return () => api.scanEntitiesFastBytes?.(uint8Buffer);
  }

  // Only the FULL Rust scan is acceptable here — a filtered scan would build
  // an incomplete entity index. Fall through to scanEntitiesFast otherwise.
  if (typeof api.scanEntitiesFast !== 'function') {
    return null;
  }

  if (uint8Buffer.byteLength > HUGE_STRING_SCAN_BYTES) {
    console.warn(
      '[parser] scanEntitiesFast (string API) skipped: source is %d MB, exceeds %d MB safeUtf8Decode budget - falling back to JS tokeniser.',
      Math.round(uint8Buffer.byteLength / (1024 * 1024)),
      HUGE_STRING_SCAN_BYTES / (1024 * 1024),
    );
    return null;
  }

  return () => api.scanEntitiesFast?.(safeUtf8Decode(uint8Buffer));
}

function normalizeWasmEntityRefs(value: unknown): EntityRef[] {
  if (!Array.isArray(value)) return [];

  const refs: EntityRef[] = [];
  for (const rawRef of value) {
    const ref = normalizeWasmEntityRef(rawRef);
    if (ref) refs.push(ref);
  }
  return refs;
}

function normalizeWasmEntityRef(value: unknown): EntityRef | null {
  if (!isRecord(value)) return null;

  const expressId = readNumber(value, 'expressId') ?? readNumber(value, 'express_id');
  const type = readString(value, 'type') ?? readString(value, 'entity_type');
  const byteOffset = readNumber(value, 'byteOffset') ?? readNumber(value, 'byte_offset');
  const byteLength = readNumber(value, 'byteLength') ?? readNumber(value, 'byte_length');
  const lineNumber = readNumber(value, 'lineNumber') ?? readNumber(value, 'line_number');

  if (expressId === undefined || type === undefined || byteOffset === undefined || byteLength === undefined) {
    return null;
  }

  return {
    expressId,
    type,
    byteOffset,
    byteLength,
    lineNumber: lineNumber ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
