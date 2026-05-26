/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { safeUtf8Decode } from '@ifc-lite/data';
import { buildEntityRefsFromIndex } from './entity-refs-from-index.js';
import { scanEntitiesInWorker } from './scan-worker-inline.js';
import { StepTokenizer } from './tokenizer.js';
import type { EntityRef } from './types.js';

export type EntityScanPath = 'worker' | 'wasm' | 'tokenizer' | 'pre-scanned';

export interface PreScannedEntityIndex {
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
}

export interface WasmScanApi {
  scanEntitiesFastBytes?: (data: Uint8Array) => unknown;
  scanRelevantEntitiesFastBytes?: (data: Uint8Array) => unknown;
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

  if (options.preScannedEntityIndex) {
    const { ids, starts, lengths } = options.preScannedEntityIndex;
    entityRefs = buildEntityRefsFromIndex(uint8Buffer, ids, starts, lengths);
    processed = entityRefs.length;
    scanPath = 'pre-scanned';
  }

  if (entityRefs.length === 0 && !options.disableWorkerScan && typeof Worker !== 'undefined') {
    try {
      entityRefs = await scanEntitiesInWorker(buffer);
      processed = entityRefs.length;
      scanPath = 'worker';
    } catch (error) {
      console.warn('[IfcParser] Worker scan failed, falling back to main thread:', error);
      entityRefs = [];
      processed = 0;
    }
  }

  const wasmScanFn = selectWasmScanFunction(options.wasmApi, uint8Buffer);
  if (entityRefs.length === 0 && wasmScanFn) {
    try {
      entityRefs = normalizeWasmEntityRefs(wasmScanFn());
      processed = entityRefs.length;
      scanPath = 'wasm';
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
  }

  const elapsedMs = performance.now() - scanStartTime;
  options.onDiagnostic?.(`scan complete: entities=${processed} elapsed=${elapsedMs.toFixed(0)}ms`);
  options.onProgress?.({ phase: 'scanning', percent: 100 });

  return { entityRefs, processed, elapsedMs, scanPath };
}

function selectWasmScanFunction(api: WasmScanApi | undefined, uint8Buffer: Uint8Array): WasmScanFunction | null {
  if (!api) return null;

  if (typeof api.scanEntitiesFastBytes === 'function') {
    return () => api.scanEntitiesFastBytes?.(uint8Buffer);
  }

  if (typeof api.scanRelevantEntitiesFastBytes === 'function') {
    return () => api.scanRelevantEntitiesFastBytes?.(uint8Buffer);
  }

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
