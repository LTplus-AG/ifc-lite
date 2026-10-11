/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Page, ConsoleMessage } from '@playwright/test';
import { READINESS_SPANS, probePageLoadTrace, waitForMetadataRenderReadiness, type LoadTraceProbe } from './metadata-render-readiness.js';
import {
  compareSpanAndRegexMetrics,
  countersFromLoadTrace,
  metricsFromLoadTrace,
  settleKey,
  type LoadCounters,
  SPAN_METRIC_KEYS,
  type LoadTraceSnapshotJson,
  type SpanRegexDisagreement,
} from './load-trace-metrics.js';

/** Where the viewer publishes its span tree under `?perfTrace=1` (apps/viewer/src/lib/perf/loadTrace.ts). */
const LOAD_TRACE_GLOBAL = '__IFC_LITE_LOAD_TRACE__';

/** Geometry workers the benchmark pins by default (#6957); `VIEWER_BENCHMARK_GEOM_WORKERS` overrides. */
export const DEFAULT_GEOM_WORKERS = 4;

/** Which source each span-capable metric came from on this run (#6956). */
export type MetricSource = 'span' | 'regex' | 'none';

export interface ViewerBenchmarkMetrics {
  // Wall-clock total time (what users actually experience)
  totalWallClockMs: number | null;
  /** Manual polling boundary for metadata/geometry/renderer logs and canvas allocation. */
  metadataRenderReadyMs?: number | null;
  // File read time
  fileReadMs: number | null;
  // Individual phase timings
  modelOpenMs: number | null;
  firstBatchWaitMs: number | null;
  firstAppendGeometryBatchMs: number | null;
  firstVisibleGeometryMs: number | null;
  streamCompleteMs: number | null;
  metadataStartMs: number | null;
  spatialReadyMs: number | null;
  metadataCompleteMs: number | null;
  metadataFailedMs: number | null;
  firstBatchNumber: number | null;
  firstBatchMeshes: number | null;
  totalBatches: number | null;
  totalMeshes: number | null;
  geometryStreamingMs: number | null;
  wasmWaitMs: number | null;
  jsProcessMs: number | null;
  entityScanMs: number | null;
  entityCount: number | null;
  dataModelParseMs: number | null;
  dataModelEntityCount: number | null;
  fileSizeMB: number | null;
  // New: Actual render time
  renderCompleteMs: number | null;
  canvasHasContent: boolean;
  // Steady-state render stats (issue #1682): parsed from the app's
  // "[ifc-lite] render stats: …" line, emitted after the scene settles.
  drawCalls: number | null;
  residentGpuMB: number | null;
  batchesContributionCulled: number | null;
  instancedDrawn: number | null;
  instancedFrustumCulled: number | null;
  instancedContributionCulled: number | null;
}

export class ViewerBenchmarkPage {
  private page: Page;
  private consoleLogs: string[] = [];
  private metrics: Partial<ViewerBenchmarkMetrics> = {};
  private loadStartTime: number = 0;
  private loadEndTime: number = 0;
  private cacheMode: string;
  private loadTrace: LoadTraceSnapshotJson | null = null;
  private metricSources: Partial<Record<string, MetricSource>> = {};
  private spanRegexDisagreements: SpanRegexDisagreement[] = [];
  private geomWorkers: number | null = null;

  /**
   * Defaults to the same port `playwright.config.ts` serves on. It used to be a
   * hardcoded `:3000`, which silently ignored `PLAYWRIGHT_PORT` — the very knob
   * the config documents for "a host with several checkouts". A run in one
   * checkout would then drive whatever dev/preview server another checkout
   * happened to be holding on :3000, and report its results as its own.
   */
  constructor(page: Page, private readonly origin = `http://localhost:${process.env.PLAYWRIGHT_PORT ?? '3000'}`) {
    this.page = page;
    this.cacheMode = process.env.VIEWER_BENCHMARK_CACHE_MODE ?? 'default';
  }

  private async clearBrowserCaches() {
    await this.page.evaluate(async () => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // Ignore storage issues.
      }

      try {
        if ('caches' in globalThis) {
          const cacheKeys = await caches.keys();
          await Promise.all(cacheKeys.map((key) => caches.delete(key)));
        }
      } catch {
        // Ignore Cache API issues.
      }

      try {
        if ('indexedDB' in globalThis && typeof indexedDB.databases === 'function') {
          const databases = await indexedDB.databases();
          await Promise.all(
            databases
              .map((entry) => entry.name)
              .filter((name): name is string => Boolean(name))
              .map((name) => new Promise<void>((resolve) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = () => resolve();
                request.onerror = () => resolve();
                request.onblocked = () => resolve();
              }))
          );
        }
      } catch {
        // Ignore IndexedDB issues.
      }
    });
  }

  async setup() {
    // Capture all console logs
    this.page.on('console', (msg: ConsoleMessage) => {
      const text = msg.text();
      this.consoleLogs.push(text);
    });

    // Optional adaptive-batch-sizing override for sweeping the watchdog↔
    // throughput knob (#1097). Set VIEWER_BENCHMARK_BATCH_SIZING to a JSON
    // object like {"targetMs":8000,"minJobs":64,"maxJobs":512}; it lands on
    // globalThis before the app boots and the geometry host forwards it to the
    // worker pool. Unset ⇒ DEFAULT_BATCH_SIZING.
    const batchSizingEnv = process.env.VIEWER_BENCHMARK_BATCH_SIZING;
    if (batchSizingEnv) {
      try {
        const cfg = JSON.parse(batchSizingEnv);
        await this.page.addInitScript((c) => {
          (globalThis as unknown as { __IFC_LITE_BATCH_SIZING?: unknown }).__IFC_LITE_BATCH_SIZING = c;
        }, cfg);
        console.log(`[Benchmark] batch sizing override: ${batchSizingEnv}`);
      } catch {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_BATCH_SIZING: ${batchSizingEnv}`);
      }
    }

    // Optional load-time visibility filter for sweeping #1097 (skip disabled
    // types at job generation). Set VIEWER_BENCHMARK_VISIBILITY_FILTER to JSON
    // like {"disabledTypes":["IFCSPACE","IFCANNOTATION"],"skipTypeGeometry":true}.
    const visFilterEnv = process.env.VIEWER_BENCHMARK_VISIBILITY_FILTER;
    if (visFilterEnv) {
      try {
        const f = JSON.parse(visFilterEnv);
        await this.page.addInitScript((c) => {
          (globalThis as unknown as { __IFC_LITE_VISIBILITY_FILTER?: unknown }).__IFC_LITE_VISIBILITY_FILTER = c;
        }, f);
        console.log(`[Benchmark] visibility filter: ${visFilterEnv}`);
      } catch {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_VISIBILITY_FILTER: ${visFilterEnv}`);
      }
    }

    // Sharded pre-pass A/B knob. The app DEFAULT is ON, so a serial baseline
    // must inject the kill switch: VIEWER_BENCHMARK_SHARD_SCAN=0 (or "off")
    // => 0; =1 or unset => app default (on).
    const shardScanEnv = process.env.VIEWER_BENCHMARK_SHARD_SCAN;
    if (shardScanEnv === '0' || shardScanEnv === 'off') {
      await this.page.addInitScript(() => {
        (globalThis as unknown as { __IFC_LITE_SHARD_SCAN?: number }).__IFC_LITE_SHARD_SCAN = 0;
      });
      console.log('[Benchmark] sharded pre-pass: OFF (kill switch)');
    } else if (shardScanEnv === '1') {
      await this.page.addInitScript(() => {
        (globalThis as unknown as { __IFC_LITE_SHARD_SCAN?: number }).__IFC_LITE_SHARD_SCAN = 1;
      });
      console.log('[Benchmark] sharded pre-pass: ON (explicit)');
    }

    // Optional contribution-culling override for A/B runs (issue #1682).
    // Set VIEWER_BENCHMARK_CONTRIB_CULL to "0" (disable), a number (rest px),
    // or JSON like {"pixelRadius":1,"interactingPixelRadius":3}. Unset ⇒ the
    // app default (see apps/viewer/src/utils/renderCullConfig.ts).
    const contribCullEnv = process.env.VIEWER_BENCHMARK_CONTRIB_CULL;
    if (contribCullEnv) {
      try {
        const cfg = JSON.parse(contribCullEnv);
        await this.page.addInitScript((c) => {
          (globalThis as unknown as { __IFC_LITE_CONTRIB_CULL?: unknown }).__IFC_LITE_CONTRIB_CULL = c;
        }, cfg);
        console.log(`[Benchmark] contribution cull override: ${contribCullEnv}`);
      } catch {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_CONTRIB_CULL: ${contribCullEnv}`);
      }
    }

    // Optional spatial-chunk-bucketing override for A/B runs (issue #1682
    // phase 2). Set VIEWER_BENCHMARK_CHUNKS to "1" (on, default cell), a
    // number (cell size in metres), or JSON {"cellSize":16}. Unset ⇒ off.
    const chunksEnv = process.env.VIEWER_BENCHMARK_CHUNKS;
    if (chunksEnv) {
      try {
        const cfg = JSON.parse(chunksEnv);
        await this.page.addInitScript((c) => {
          (globalThis as unknown as { __IFC_LITE_CHUNKS?: unknown }).__IFC_LITE_CHUNKS = c;
        }, cfg);
        console.log(`[Benchmark] spatial chunking override: ${chunksEnv}`);
      } catch {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_CHUNKS: ${chunksEnv}`);
      }
    }

    // Optional GPU residency budget for A/B runs (issue #1682 phase 3a).
    // Set VIEWER_BENCHMARK_GPU_BUDGET to a number of megabytes. Unset ⇒ off.
    const gpuBudgetEnv = process.env.VIEWER_BENCHMARK_GPU_BUDGET;
    if (gpuBudgetEnv) {
      const mb = Number(gpuBudgetEnv);
      // 0 is a valid override: it injects the kill switch (the app DEFAULT is
      // on since the #1682 flip, so an off-baseline must pass 0 through).
      if (Number.isFinite(mb) && mb >= 0) {
        await this.page.addInitScript((v) => {
          (globalThis as unknown as { __IFC_LITE_GPU_BUDGET_MB?: number }).__IFC_LITE_GPU_BUDGET_MB = v;
        }, mb);
        console.log(`[Benchmark] GPU residency budget override: ${mb}MB`);
      } else {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_GPU_BUDGET: ${gpuBudgetEnv}`);
      }
    }

    // Optional HOST residency budget for A/B runs (issue #1682 phase 3b).
    // Megabytes; only effective on v13-cached models with the GPU budget on.
    const hostBudgetEnv = process.env.VIEWER_BENCHMARK_HOST_BUDGET;
    if (hostBudgetEnv) {
      const mb = Number(hostBudgetEnv);
      // 0 = kill switch (see the GPU budget note above).
      if (Number.isFinite(mb) && mb >= 0) {
        await this.page.addInitScript((v) => {
          (globalThis as unknown as { __IFC_LITE_HOST_BUDGET_MB?: number }).__IFC_LITE_HOST_BUDGET_MB = v;
        }, mb);
        console.log(`[Benchmark] host residency budget override: ${mb}MB`);
      } else {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_HOST_BUDGET: ${hostBudgetEnv}`);
      }
    }

    // Optional LOD1 override for A/B runs (issue #1682 phase 5). Projected
    // screen px below which batches draw their simplified index range.
    const lodEnv = process.env.VIEWER_BENCHMARK_LOD_PX;
    if (lodEnv) {
      const px = Number(lodEnv);
      // 0 = kill switch (the app default is 48px since the #1682 flip).
      if (Number.isFinite(px) && px >= 0) {
        await this.page.addInitScript((v) => {
          (globalThis as unknown as { __IFC_LITE_LOD_PX?: number }).__IFC_LITE_LOD_PX = v;
        }, px);
        console.log(`[Benchmark] LOD override: ${px}px`);
      } else {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_LOD_PX: ${lodEnv}`);
      }
    }

    // Optional quantized-vertex override (issue #1682 phase 6). "1" enables
    // the 12-byte lattice vertex path (off by default).
    const quantEnv = process.env.VIEWER_BENCHMARK_QUANTIZED;
    if (quantEnv === '1' || quantEnv === '0') {
      // '0' injects the kill switch — the app default is ON since the flip.
      const v = Number(quantEnv);
      await this.page.addInitScript((n) => {
        (globalThis as unknown as { __IFC_LITE_QUANTIZED?: number }).__IFC_LITE_QUANTIZED = n;
      }, v);
      console.log(`[Benchmark] quantized vertices override: ${v ? 'on' : 'off'}`);
    } else if (quantEnv) {
      console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_QUANTIZED (expected "1" or "0"): ${quantEnv}`);
    }

    // #6956: turn on the viewer's load tracer so metrics and load completion
    // come from its span tree (window.__IFC_LITE_LOAD_TRACE__); the console
    // regexes stay as the fallback for one release (#7005).
    await this.page.addInitScript(() => {
      (globalThis as unknown as { __IFC_LITE_PERF_TRACE?: number }).__IFC_LITE_PERF_TRACE = 1;
    });

    // #6957: pin the geometry worker count so structural counters (messages,
    // copies, uploads) compare across runs and machines. `auto` keeps the
    // engine heuristic; `?geomWorkers=` is the viewer's own override.
    const workersEnv = process.env.VIEWER_BENCHMARK_GEOM_WORKERS ?? String(DEFAULT_GEOM_WORKERS);
    this.geomWorkers = /^([1-9]|1[0-6])$/.test(workersEnv) ? Number(workersEnv) : null;
    if (this.geomWorkers === null && workersEnv !== 'auto') {
      console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_GEOM_WORKERS (expected 1-16 or "auto"): ${workersEnv}`);
    }

    // Navigate to viewer app
    await this.page.goto(this.geomWorkers === null ? this.origin : `${this.origin}/?geomWorkers=${this.geomWorkers}`);
    
    // Wait for app to be ready (file input exists but is hidden, so check for existence)
    await this.page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30000 });
    
    // Also wait for the app to be interactive
    await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
      // Ignore if networkidle times out, app might still be loading
    });

    if (this.cacheMode === 'cold') {
      await this.clearBrowserCaches();
      await this.page.reload();
      await this.page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30000 });
    }
  }

  async loadFile(filePath: string, waitForStart = true) {
    // Find the file input (there are two, use the one in ViewportContainer)
    const fileInput = this.page.locator('input[type="file"]').first();

    // Record wall-clock start time
    this.loadStartTime = Date.now();

    // Upload file
    await fileInput.setInputFiles(filePath);

    // Wait for file loading to start (check for file name in logs)
    if (waitForStart) await this.page.waitForTimeout(1000);
  }

  /**
   * Canvas allocation only. This used to sample pixels through
   * `getContext('2d')`, but the viewport canvas exists before the renderer
   * claims it, and a canvas holding a 2D context returns null for
   * `getContext('webgpu')` from then on: the renderer failed with "Failed to
   * get WebGPU context", and that run measured no GPU work at all (draw
   * calls, uploads, the #6957 GPU counters).
   * Pixels of a WebGPU canvas cannot be read back from here anyway.
   */
  private async checkCanvasHasContent(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return !!canvas && canvas.width > 0 && canvas.height > 0;
      });
    } catch {
      return false;
    }
  }

  /**
   * One cold sample as `scripts/perf/browser-cold-ab.mts` drives it: upload at
   * once, then wait for metadata + geometry + renderer finalize + canvas. The
   * cold A/B calls only this, so its tracing setup (`setup()`) and readiness
   * logic (`waitForMetadataRenderReadiness`, with the console fallback for a
   * base build that predates the spans) are this page's own, never a copy (#7032).
   */
  async loadUntilReady(filePath: string, timeoutMs: number) {
    await this.loadFile(filePath, false);
    await this.waitForCompletion(timeoutMs, true);
  }

  async waitForCompletion(timeoutMs: number = 600000, requireMetadataRender = false) {
    if (requireMetadataRender) {
      this.loadEndTime = await waitForMetadataRenderReadiness({
        trace: () => this.probeLoadTrace(), logs: () => this.consoleLogs, canvasReady: () => this.checkCanvasHasContent(),
        now: () => Date.now(), pause: () => this.page.waitForTimeout(100), timeoutMs,
      });
      this.metrics.metadataRenderReadyMs = this.loadEndTime - this.loadStartTime;
      this.metrics.renderCompleteMs = this.metrics.metadataRenderReadyMs;
      this.metrics.canvasHasContent = true;
      await this.readLoadTrace();
      this.parseMetrics();
      return;
    }
    const startTime = Date.now();
    let renderCompleteTime: number | null = null;

    // Wait for the load's root span to end (#6979) AND actual rendering
    while (Date.now() - startTime < timeoutMs) {
      const probe = await this.probeLoadTrace();
      // TODO(remove-by: first release after 2026-10-06 (one after #6977), #7005):
      // console completion lines, read only when the page exposes no load trace.
      const hasStreamingComplete = this.consoleLogs.some(log =>
        log.includes('[useIfc] Geometry streaming complete')
      );
      const hasDataModelComplete = this.consoleLogs.some(log =>
        log.includes('[useIfc] Data model parsing complete') ||
        log.includes('[ColumnarParser] Parsed')
      );
      const hasTotalLoadTime = this.consoleLogs.some(log =>
        log.includes('[useIfc] TOTAL LOAD TIME')
      );
      const hasUnifiedSummary = this.consoleLogs.some(log =>
        log.includes('[useIfc]') && log.includes('meshes') && log.includes('first:') && log.includes('total:')
      );
      // Primary-path definitive end-of-load marker (current viewer format):
      //   [ifc-lite] <file> (327.0MB) → 39146 meshes, 12345k verts in 11.9s
      const hasFinalSummary = this.consoleLogs.some(log =>
        /\[ifc-lite\].*→\s*\d[\d,]*\s*meshes.*in\s*[\d.]+s/.test(log)
      );

      // Check canvas has actual content
      const canvasReady = await this.checkCanvasHasContent();

      const loadComplete = probe
        ? probe.ended
        : (hasStreamingComplete && hasDataModelComplete && hasTotalLoadTime)
          || hasUnifiedSummary
          || hasFinalSummary
          || (hasStreamingComplete && hasDataModelComplete);
      if (loadComplete) {
        // Record when we see completion in logs
        if (!renderCompleteTime) {
          renderCompleteTime = Date.now();
        }
        
        // Wait for canvas to actually have content (GPU flush)
        if (canvasReady) {
          this.loadEndTime = Date.now();
          this.metrics.canvasHasContent = true;
          // Additional wait for any pending GPU operations
          await this.page.waitForTimeout(200);
          break;
        }
      }

      // Wait a bit before checking again
      await this.page.waitForTimeout(100);
    }

    // Time from load start until the canvas actually showed content (the
    // Playwright-observed render completion, distinct from the app's own
    // totalWallClockMs log).
    if (renderCompleteTime && this.loadEndTime) {
      this.metrics.renderCompleteMs = this.loadEndTime - this.loadStartTime;
    }

    // Best-effort wait for the steady-state render-stats line — it fires
    // after the scene settles (queue drain + fragment finalize), which is
    // shortly after the final load summary on the CI models. Non-fatal: the
    // stats metrics stay null when it doesn't arrive in time. Bounded by the
    // caller's overall timeout budget as well as its own 30s cap.
    const statsDeadline = Math.min(Date.now() + 30000, startTime + timeoutMs);
    while (
      Date.now() < statsDeadline &&
      !this.consoleLogs.some((log) => log.includes('[ifc-lite] render stats:'))
    ) {
      await this.page.waitForTimeout(250);
    }

    // Span tree first, console logs as the fallback.
    await this.readLoadTrace();
    this.parseMetrics();
  }

  /**
   * #6957: wait until the load's structural counters stop moving, then keep
   * that snapshot for `getLoadCounters`. The load's root span ends before the
   * renderer has drained its upload queue (and, under SwiftShader, before the
   * renderer even starts), so counters read at completion would cut work off
   * at a timing-dependent point. Timing metrics are untouched: they were taken
   * from the completion snapshot. Stable = unchanged over `quietPolls` polls.
   */
  async settleLoadCounters({ pollMs = 250, quietPolls = 6, maxMs = 30_000 } = {}): Promise<void> {
    const deadline = Date.now() + maxMs;
    let last = '';
    let quiet = 0;
    for (;;) {
      await this.readLoadTrace();
      const key = settleKey(this.loadTrace);
      quiet = key === last ? quiet + 1 : 0;
      last = key;
      if (quiet >= quietPolls) return;
      if (Date.now() >= deadline) {
        console.warn(`[Benchmark] structural counters still moving after ${maxMs} ms; recording the latest snapshot`);
        return;
      }
      await this.page.waitForTimeout(pollMs);
    }
  }

  /**
   * The latest load's completion state, reduced inside the page so a poll
   * copies a few span names rather than the tree (#6979). Null when the page
   * exposes no trace yet (or at all: a viewer built before #6977).
   */
  private async probeLoadTrace(): Promise<LoadTraceProbe | null> {
    try {
      return await this.page.evaluate(
        probePageLoadTrace,
        { key: LOAD_TRACE_GLOBAL, names: READINESS_SPANS },
      );
    } catch (err) {
      console.warn('[Benchmark] could not probe the load trace', err);
      return null;
    }
  }

  /** Pull the latest load's span tree out of the page (null when tracing is unavailable). */
  private async readLoadTrace(): Promise<void> {
    try {
      this.loadTrace = await this.page.evaluate(
        (key: string) => {
          const api = (globalThis as unknown as Record<string, { latest?: () => unknown } | undefined>)[key];
          return (api?.latest?.() ?? null) as LoadTraceSnapshotJson | null;
        },
        LOAD_TRACE_GLOBAL,
      );
    } catch (err) {
      console.warn('[Benchmark] could not read the load-trace span tree; using console regexes only', err);
      this.loadTrace = null;
    }
  }

  /**
   * Override regex-derived values with span-derived ones where the span tree
   * has them, recording each metric's source and every span/regex pair that
   * disagrees beyond rounding (asserted on FZK by the spec).
   */
  private applySpanMetrics(appReportedTotalMs: number | null) {
    // The span root is the app's own total; compare it only with the app's own
    // total line, never with the Playwright-observed wall clock fallback.
    const regex = { ...this.metrics, totalWallClockMs: appReportedTotalMs };
    const span = metricsFromLoadTrace(this.loadTrace);
    this.spanRegexDisagreements = compareSpanAndRegexMetrics(span, regex);
    for (const key of SPAN_METRIC_KEYS) {
      const value = span[key];
      if (value !== undefined) {
        this.metrics[key] = value;
        this.metricSources[key] = 'span';
      } else {
        this.metricSources[key] = this.metrics[key] === null || this.metrics[key] === undefined ? 'none' : 'regex';
      }
    }
  }

  /**
   * TODO(remove-by: first release after 2026-10-06, i.e. one after #6977;
   * #7005): the console regexes for metrics the span tree carries are the
   * fallback for viewer builds without a load trace. `applySpanMetrics`
   * overrides them whenever the tree has the value.
   */
  private parseMetrics() {
    const logs = this.consoleLogs.join('\n');
    let appReportedTotalMs: number | null = null;
    
    // Calculate wall-clock total time
    if (this.loadStartTime > 0 && this.loadEndTime > 0) {
      this.metrics.totalWallClockMs = this.loadEndTime - this.loadStartTime;
    }
    
    // Log color update status
    const colorLogs = this.consoleLogs.filter(log => 
      log.includes('color') || log.includes('Color')
    );
    if (colorLogs.length > 0) {
      console.log('[Benchmark] Color updates:', colorLogs);
    }

    // Model open time
    const modelOpenMatch = logs.match(/\[useIfc\] Model opened at (\d+)ms/);
    if (modelOpenMatch) {
      this.metrics.modelOpenMs = parseInt(modelOpenMatch[1], 10);
    }

    // First batch timing
    const firstBatchMatch = logs.match(/\[useIfc\] (?:Native )?Batch #1: (\d+) meshes, wait: (\d+)ms/);
    if (firstBatchMatch) {
      this.metrics.firstBatchMeshes = parseInt(firstBatchMatch[1], 10);
      this.metrics.firstBatchWaitMs = parseInt(firstBatchMatch[2], 10);
      this.metrics.firstBatchNumber = 1;
    }

    // Current stream logs report first batches per worker instead:
    //   [stream] worker[0] first batch @ 90ms (106 meshes)
    // The earliest of them is the first geometry to arrive — the same
    // stream-latency quantity the legacy "Batch #1 … wait: Xms" line measured
    // (epoch is the stream start rather than the file load; the baseline is
    // CI-recorded against the same parse, so comparisons stay like-for-like).
    if (this.metrics.firstBatchWaitMs === null || this.metrics.firstBatchWaitMs === undefined) {
      const workerFirstBatches = [
        ...logs.matchAll(/\[stream\] worker\[\d+\] first batch @ (\d+)ms \((\d+) meshes\)/g),
      ];
      if (workerFirstBatches.length > 0) {
        const earliest = workerFirstBatches.reduce((a, b) =>
          parseInt(a[1], 10) <= parseInt(b[1], 10) ? a : b
        );
        this.metrics.firstBatchWaitMs = parseInt(earliest[1], 10);
        this.metrics.firstBatchMeshes = parseInt(earliest[2], 10);
        this.metrics.firstBatchNumber = 1;
      }
    }

    const firstAppendMatch = logs.match(/\[useIfc\] (?:Native )?first appendGeometryBatch for .*?: (\d+)ms/i);
    if (firstAppendMatch) {
      this.metrics.firstAppendGeometryBatchMs = parseInt(firstAppendMatch[1], 10);
    }

    const firstVisibleMatch = logs.match(/\[useIfc\] (?:Native )?first visible geometry for .*?: (\d+)ms/i);
    if (firstVisibleMatch) {
      this.metrics.firstVisibleGeometryMs = parseInt(firstVisibleMatch[1], 10);
    }

    // Geometry streaming complete
    const streamingCompleteMatch = logs.match(
      /\[useIfc\] Geometry streaming complete: (\d+) batches, (\d+) meshes/
    );
    if (streamingCompleteMatch) {
      this.metrics.totalBatches = parseInt(streamingCompleteMatch[1], 10);
      this.metrics.totalMeshes = parseInt(streamingCompleteMatch[2], 10);
    }

    const streamCompleteMatch = logs.match(/\[useIfc\] (?:Native )?Stream complete for .*?: (\d+)ms/i);
    if (streamCompleteMatch) {
      this.metrics.streamCompleteMs = parseInt(streamCompleteMatch[1], 10);
    }

    // WASM wait time
    const wasmWaitMatch = logs.match(/Total wait \(WASM\): (\d+)ms/);
    if (wasmWaitMatch) {
      this.metrics.wasmWaitMs = parseInt(wasmWaitMatch[1], 10);
    }

    // JS process time
    const jsProcessMatch = logs.match(/Total process \(JS\): (\d+)ms/);
    if (jsProcessMatch) {
      this.metrics.jsProcessMs = parseInt(jsProcessMatch[1], 10);
    }

    // Calculate geometry streaming total time (from first batch to complete)
    if (this.metrics.streamCompleteMs !== null && this.metrics.streamCompleteMs !== undefined) {
      this.metrics.geometryStreamingMs = this.metrics.streamCompleteMs;
    } else if (this.metrics.wasmWaitMs !== null && this.metrics.wasmWaitMs !== undefined) {
      this.metrics.geometryStreamingMs = this.metrics.wasmWaitMs;
    }

    // Entity scan time
    const fastScanMatch = logs.match(/\[IfcParser\] Fast scan: (\d+) entities in (\d+)ms/);
    if (fastScanMatch) {
      this.metrics.entityCount = parseInt(fastScanMatch[1], 10);
      this.metrics.entityScanMs = parseInt(fastScanMatch[2], 10);
    }

    // Data model parse time
    const dataModelMatch = logs.match(/\[ColumnarParser\] Parsed (\d+) entities in (\d+)ms/);
    if (dataModelMatch) {
      this.metrics.dataModelEntityCount = parseInt(dataModelMatch[1], 10);
      this.metrics.dataModelParseMs = parseInt(dataModelMatch[2], 10);
    }

    const metadataStartMatch = logs.match(/\[useIfc\] (?:Native )?(?:metadata|Data model) (?:parse|parsing) start for .*?: (\d+)ms/i);
    if (metadataStartMatch) {
      this.metrics.metadataStartMs = parseInt(metadataStartMatch[1], 10);
    }

    const spatialReadyMatch = logs.match(/\[useIfc\] (?:Native )?(?:spatial tree|Spatial tree) ready for .*? at (\d+)ms/i);
    if (spatialReadyMatch) {
      this.metrics.spatialReadyMs = parseInt(spatialReadyMatch[1], 10);
    }

    const metadataCompleteMatch = logs.match(/\[useIfc\] (?:Native )?(?:metadata|Data model) (?:parse|parsing) complete for .*?: (\d+)ms/i);
    if (metadataCompleteMatch) {
      this.metrics.metadataCompleteMs = parseInt(metadataCompleteMatch[1], 10);
    }

    const metadataFailedMatch = logs.match(/\[useIfc\] (?:Native )?(?:metadata|Data model) (?:parse|parsing) failed for .*?: (\d+)ms/i);
    if (metadataFailedMatch) {
      this.metrics.metadataFailedMs = parseInt(metadataFailedMatch[1], 10);
    }

    // File size and read time
    const fileSizeMatch = logs.match(/\[useIfc\] File: .+?, size: ([\d.]+)MB, read in (\d+)ms/);
    if (fileSizeMatch) {
      this.metrics.fileSizeMB = parseFloat(fileSizeMatch[1]);
      this.metrics.fileReadMs = parseInt(fileSizeMatch[2], 10);
    } else {
      // Fallback for old format
      const oldFileSizeMatch = logs.match(/\[useIfc\] File: .+?, size: ([\d.]+)MB/);
      if (oldFileSizeMatch) {
        this.metrics.fileSizeMB = parseFloat(oldFileSizeMatch[1]);
      }
    }
    
    // Fallback for newer compact log format:
    // [useIfc] ✓ file.ifc (2.4MB) → 244 meshes, 643k vertices | first: 107ms, total: 275ms
    const compactSummaryMatch = logs.match(
      /\[useIfc\].*?\(([\d.]+)MB\)\s+→\s+(\d+)\s+meshes.*?\|\s+first:\s+(\d+)ms,\s+total:\s+(\d+)ms/
    );
    if (compactSummaryMatch) {
      this.metrics.fileSizeMB = this.metrics.fileSizeMB ?? parseFloat(compactSummaryMatch[1]);
      this.metrics.totalMeshes = this.metrics.totalMeshes ?? parseInt(compactSummaryMatch[2], 10);
      this.metrics.firstBatchWaitMs = this.metrics.firstBatchWaitMs ?? parseInt(compactSummaryMatch[3], 10);
      this.metrics.totalWallClockMs = this.metrics.totalWallClockMs ?? parseInt(compactSummaryMatch[4], 10);
      // Newer log format omits a dedicated model-open event; keep assertion-compatible fallback.
      this.metrics.modelOpenMs = this.metrics.modelOpenMs ?? this.metrics.firstBatchWaitMs ?? null;
    }

    // Total load time from app (most accurate measure of user experience)
    const totalLoadMatch = logs.match(/\[useIfc\] TOTAL LOAD TIME.*?: (\d+)ms/);
    if (totalLoadMatch) {
      this.metrics.totalWallClockMs = parseInt(totalLoadMatch[1], 10);
      appReportedTotalMs = this.metrics.totalWallClockMs;
    }

    // Current primary-path final summary carries the app's own measured total:
    //   [ifc-lite] <file> (327.0MB) → 39146 meshes, 12345k verts in 11.9s
    // Prefer it over the test's wall-clock (excludes Playwright polling jitter).
    const finalSummaryMatch = logs.match(
      /\[ifc-lite\].*?\(([\d.]+)MB\)\s*→\s*([\d,]+)\s*meshes.*?in\s*([\d.]+)s/
    );
    if (finalSummaryMatch) {
      this.metrics.fileSizeMB = this.metrics.fileSizeMB ?? parseFloat(finalSummaryMatch[1]);
      this.metrics.totalMeshes = this.metrics.totalMeshes ?? parseInt(finalSummaryMatch[2].replace(/,/g, ''), 10);
      this.metrics.totalWallClockMs = Math.round(parseFloat(finalSummaryMatch[3]) * 1000);
      appReportedTotalMs = this.metrics.totalWallClockMs;
    }

    // Steady-state render stats (issue #1682), emitted post-settle by
    // apps/viewer/src/utils/renderStatsReport.ts — keep formats in sync:
    //   [ifc-lite] render stats: 143 draw calls, 512.3 MB GPU resident
    //   (140 batches drawn, 2 frustum-culled, 1 contribution-culled;
    //   90 instanced drawn, 3 frustum-culled, 8 contribution-culled)
    const renderStatsMatch = logs.match(
      /\[ifc-lite\] render stats: (\d+) draw calls, ([\d.]+) MB GPU resident \((\d+) batches drawn, (\d+) frustum-culled, (\d+) contribution-culled(?:; (\d+) instanced drawn, (\d+) frustum-culled, (\d+) contribution-culled)?\)/
    );
    if (renderStatsMatch) {
      this.metrics.drawCalls = parseInt(renderStatsMatch[1], 10);
      this.metrics.residentGpuMB = parseFloat(renderStatsMatch[2]);
      this.metrics.batchesContributionCulled = parseInt(renderStatsMatch[5], 10);
      // Instanced groups are optional (absent in pre-cull logs).
      if (renderStatsMatch[6] !== undefined) {
        this.metrics.instancedDrawn = parseInt(renderStatsMatch[6], 10);
        this.metrics.instancedFrustumCulled = parseInt(renderStatsMatch[7], 10);
        this.metrics.instancedContributionCulled = parseInt(renderStatsMatch[8], 10);
      }
    }

    this.applySpanMetrics(appReportedTotalMs);
  }

  getMetrics(): ViewerBenchmarkMetrics {
    return {
      totalWallClockMs: this.metrics.totalWallClockMs ?? null,
      metadataRenderReadyMs: this.metrics.metadataRenderReadyMs ?? null,
      fileReadMs: this.metrics.fileReadMs ?? null,
      modelOpenMs: this.metrics.modelOpenMs ?? null,
      firstBatchWaitMs: this.metrics.firstBatchWaitMs ?? null,
      firstAppendGeometryBatchMs: this.metrics.firstAppendGeometryBatchMs ?? null,
      firstVisibleGeometryMs: this.metrics.firstVisibleGeometryMs ?? null,
      streamCompleteMs: this.metrics.streamCompleteMs ?? null,
      metadataStartMs: this.metrics.metadataStartMs ?? null,
      spatialReadyMs: this.metrics.spatialReadyMs ?? null,
      metadataCompleteMs: this.metrics.metadataCompleteMs ?? null,
      metadataFailedMs: this.metrics.metadataFailedMs ?? null,
      firstBatchNumber: this.metrics.firstBatchNumber ?? null,
      firstBatchMeshes: this.metrics.firstBatchMeshes ?? null,
      totalBatches: this.metrics.totalBatches ?? null,
      totalMeshes: this.metrics.totalMeshes ?? null,
      geometryStreamingMs: this.metrics.geometryStreamingMs ?? null,
      wasmWaitMs: this.metrics.wasmWaitMs ?? null,
      jsProcessMs: this.metrics.jsProcessMs ?? null,
      entityScanMs: this.metrics.entityScanMs ?? null,
      entityCount: this.metrics.entityCount ?? null,
      dataModelParseMs: this.metrics.dataModelParseMs ?? null,
      dataModelEntityCount: this.metrics.dataModelEntityCount ?? null,
      fileSizeMB: this.metrics.fileSizeMB ?? null,
      renderCompleteMs: this.metrics.renderCompleteMs ?? null,
      canvasHasContent: this.metrics.canvasHasContent ?? false,
      drawCalls: this.metrics.drawCalls ?? null,
      residentGpuMB: this.metrics.residentGpuMB ?? null,
      batchesContributionCulled: this.metrics.batchesContributionCulled ?? null,
      instancedDrawn: this.metrics.instancedDrawn ?? null,
      instancedFrustumCulled: this.metrics.instancedFrustumCulled ?? null,
      instancedContributionCulled: this.metrics.instancedContributionCulled ?? null,
    };
  }

  /** The raw span tree of the measured load, or null when the page exposed none. */
  getLoadTrace(): LoadTraceSnapshotJson | null {
    return this.loadTrace;
  }

  /**
   * #6957: the measured load's structural counters, its long-frame summary
   * and the pinned worker count (null = engine heuristic), or null counters
   * when the viewer recorded none.
   */
  getLoadCounters(): { geomWorkers: number | null; counters: LoadCounters | null } {
    return { geomWorkers: this.geomWorkers, counters: countersFromLoadTrace(this.loadTrace) };
  }

  getMetricSources(): Partial<Record<string, MetricSource>> {
    return { ...this.metricSources };
  }

  /** Span/regex pairs for the same metric that differ beyond rounding; empty when they agree. */
  getSpanRegexDisagreements(): SpanRegexDisagreement[] {
    return [...this.spanRegexDisagreements];
  }

  getConsoleLogs(): string[] {
    return [...this.consoleLogs];
  }
}
