/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-load memory accounting for the viewer.
 *
 * Records JS heap, WASM heap, source-buffer, geometry, and transport bytes
 * across the parse + geometry pipeline so we can verify the parser-worker
 * refactor doesn't double-buffer or leak. Surfaces results via console
 * lines (in dev or with `?perfMem=1`) and exposes a programmatic snapshot
 * API for the timing telemetry sink.
 *
 * The module is intentionally a singleton (one active load at a time
 * matches the upload-driven viewer flow). `reset()` should be called at
 * the start of each load.
 */

export interface MemoryPhaseRecord {
  phase: string;
  /** Wall-clock ms since the load started. */
  tMs: number;
  /** `performance.memory.usedJSHeapSize` on the main thread (Chromium). */
  jsHeapBytes?: number;
  /** WASM heap (sum across all geometry workers + parser worker if reported). */
  wasmHeapBytes?: number;
  /** Total bytes of geometry buffers received so far. */
  geometryBytes?: number;
  /** SAB byte length (the file source). */
  sourceBytes?: number;
  /** Bytes that crossed the worker→main transport (typed arrays + maps). */
  transportBytes?: number;
}

export interface MemorySummary {
  peakJsHeapBytes: number;
  peakWasmHeapBytes: number;
  totalGeometryBytes: number;
  sourceBytes: number;
  transportBytes: number;
  /**
   * Fraction of total wall-clock during which both parser and geometry
   * workers ran concurrently. Computed from phase timestamps so it
   * surfaces the actual overlap delivered by the refactor.
   */
  parseGeometryOverlapMs: number;
  totalDurationMs: number;
}

interface PhaseRange {
  start: number;
  end: number;
}

interface JsHeapPerf {
  memory?: { usedJSHeapSize: number };
}

function readMainJsHeapBytes(): number | undefined {
  if (typeof performance === 'undefined') return undefined;
  const perf = performance as unknown as JsHeapPerf;
  return perf.memory?.usedJSHeapSize;
}

function bytesToMB(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '?';
  return (n / (1024 * 1024)).toFixed(1);
}

function isLogEnabled(): boolean {
  if (typeof globalThis === 'undefined') return false;
  // import.meta.env.DEV is replaced at build time by Vite. The check is
  // wrapped so non-Vite consumers (tests, SSR) don't blow up.
  const importMeta = (globalThis as unknown as { __VITE_DEV__?: boolean }).__VITE_DEV__;
  if (importMeta === true) return true;
  const win = (globalThis as unknown as { location?: { search: string } }).location;
  if (win?.search && win.search.includes('perfMem=1')) return true;
  return false;
}

export class MemoryAccounting {
  private records: MemoryPhaseRecord[] = [];
  private startedAt: number | null = null;
  /** Tracks per-worker latest WASM heap reading so the aggregator can sum. */
  private workerWasmHeap = new Map<string, number>();
  /** Cumulative geometry bytes across all batches in this load. */
  private cumulativeGeometryBytes = 0;
  /** SAB size for this load. */
  private currentSourceBytes = 0;
  /** Captured during phase markers. */
  private phaseRanges = new Map<string, PhaseRange>();

  /** Reset state for a new load. Call at upload start. */
  reset(): void {
    this.records = [];
    this.startedAt = performance.now();
    this.workerWasmHeap.clear();
    this.cumulativeGeometryBytes = 0;
    this.currentSourceBytes = 0;
    this.phaseRanges.clear();
  }

  /** Note the file size as soon as the SAB is allocated. */
  setSourceBytes(bytes: number): void {
    this.currentSourceBytes = bytes;
  }

  /** Record the start time of a named phase (used for overlap calculations). */
  beginPhase(phase: string): void {
    if (this.startedAt === null) this.startedAt = performance.now();
    const range = this.phaseRanges.get(phase) ?? { start: -1, end: -1 };
    range.start = performance.now() - this.startedAt;
    this.phaseRanges.set(phase, range);
  }

  /** Record the end time of a named phase. */
  endPhase(phase: string): void {
    const range = this.phaseRanges.get(phase);
    if (!range || this.startedAt === null) return;
    range.end = performance.now() - this.startedAt;
  }

  /** Update the cumulative WASM heap reading for a specific worker. */
  recordWorkerMemory(workerKey: string, wasmHeapBytes: number): void {
    if (wasmHeapBytes > 0) this.workerWasmHeap.set(workerKey, wasmHeapBytes);
  }

  /** Add bytes received in a geometry batch (positions + normals + indices). */
  addGeometryBytes(bytes: number): void {
    this.cumulativeGeometryBytes += bytes;
  }

  /**
   * Record a snapshot for the named phase. Pulls main-thread JS heap and
   * the running WASM heap sum. Optional fields override the running totals.
   */
  recordPhase(input: { phase: string } & Partial<Omit<MemoryPhaseRecord, 'phase' | 'tMs'>>): void {
    if (this.startedAt === null) this.startedAt = performance.now();
    const tMs = performance.now() - this.startedAt;

    let wasmHeapBytes = 0;
    for (const v of this.workerWasmHeap.values()) wasmHeapBytes += v;

    const record: MemoryPhaseRecord = {
      phase: input.phase,
      tMs,
      jsHeapBytes: input.jsHeapBytes ?? readMainJsHeapBytes(),
      wasmHeapBytes: input.wasmHeapBytes ?? (wasmHeapBytes > 0 ? wasmHeapBytes : undefined),
      geometryBytes: input.geometryBytes ?? (this.cumulativeGeometryBytes > 0 ? this.cumulativeGeometryBytes : undefined),
      sourceBytes: input.sourceBytes ?? (this.currentSourceBytes > 0 ? this.currentSourceBytes : undefined),
      transportBytes: input.transportBytes,
    };
    this.records.push(record);

    if (isLogEnabled()) {
      console.log(
        `[mem] phase=${record.phase} t=${Math.round(tMs)}ms ` +
        `jsHeap=${bytesToMB(record.jsHeapBytes)}MB ` +
        `wasmHeap=${bytesToMB(record.wasmHeapBytes)}MB ` +
        `geom=${bytesToMB(record.geometryBytes)}MB ` +
        `source=${bytesToMB(record.sourceBytes)}MB ` +
        (record.transportBytes !== undefined ? `transport=${bytesToMB(record.transportBytes)}MB ` : ''),
      );
    }
  }

  /** Per-phase records in insertion order. */
  snapshot(): MemoryPhaseRecord[] {
    return this.records.slice();
  }

  /** Roll-up across the entire load. */
  summary(): MemorySummary {
    let peakJsHeapBytes = 0;
    let peakWasmHeapBytes = 0;
    let totalGeometryBytes = 0;
    let transportBytes = 0;
    let sourceBytes = this.currentSourceBytes;

    for (const r of this.records) {
      if (r.jsHeapBytes && r.jsHeapBytes > peakJsHeapBytes) peakJsHeapBytes = r.jsHeapBytes;
      if (r.wasmHeapBytes && r.wasmHeapBytes > peakWasmHeapBytes) peakWasmHeapBytes = r.wasmHeapBytes;
      if (r.geometryBytes && r.geometryBytes > totalGeometryBytes) totalGeometryBytes = r.geometryBytes;
      if (r.transportBytes) transportBytes += r.transportBytes;
      if (r.sourceBytes && r.sourceBytes > sourceBytes) sourceBytes = r.sourceBytes;
    }

    const parser = this.phaseRanges.get('parser-worker');
    const geometry = this.phaseRanges.get('geometry');
    const overlap = computeOverlapMs(parser, geometry);
    const totalDurationMs = this.records.length > 0
      ? this.records[this.records.length - 1].tMs
      : 0;

    return {
      peakJsHeapBytes,
      peakWasmHeapBytes,
      totalGeometryBytes,
      sourceBytes,
      transportBytes,
      parseGeometryOverlapMs: overlap,
      totalDurationMs,
    };
  }

  /**
   * Format a one-line summary suitable for the console / telemetry sink.
   * Designed to be greppable next to the existing `[useIfc]` lines.
   */
  formatSummary(): string {
    const s = this.summary();
    return (
      `[mem-summary] peakJs=${bytesToMB(s.peakJsHeapBytes)}MB ` +
      `peakWasm=${bytesToMB(s.peakWasmHeapBytes)}MB ` +
      `geom=${bytesToMB(s.totalGeometryBytes)}MB ` +
      `source=${bytesToMB(s.sourceBytes)}MB ` +
      `transport=${bytesToMB(s.transportBytes)}MB ` +
      `overlap=${Math.round(s.parseGeometryOverlapMs)}ms ` +
      `total=${Math.round(s.totalDurationMs)}ms`
    );
  }
}

function computeOverlapMs(a?: PhaseRange, b?: PhaseRange): number {
  if (!a || !b) return 0;
  if (a.start < 0 || b.start < 0) return 0;
  const aEnd = a.end >= 0 ? a.end : Infinity;
  const bEnd = b.end >= 0 ? b.end : Infinity;
  const overlapStart = Math.max(a.start, b.start);
  const overlapEnd = Math.min(aEnd, bEnd);
  return Math.max(0, overlapEnd - overlapStart);
}

/** Process-wide singleton used by the upload pipeline. */
export const memoryAccounting = new MemoryAccounting();
