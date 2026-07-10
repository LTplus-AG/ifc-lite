/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Page, ConsoleMessage } from '@playwright/test';

export interface ViewerBenchmarkMetrics {
  // Wall-clock total time (what users actually experience)
  totalWallClockMs: number | null;
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
}

export class ViewerBenchmarkPage {
  private page: Page;
  private consoleLogs: string[] = [];
  private metrics: Partial<ViewerBenchmarkMetrics> = {};
  private loadStartTime: number = 0;
  private loadEndTime: number = 0;
  private cacheMode: string;

  constructor(page: Page) {
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
      } catch (e) {
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
      } catch (e) {
        console.warn(`[Benchmark] invalid VIEWER_BENCHMARK_VISIBILITY_FILTER: ${visFilterEnv}`);
      }
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

    // Navigate to viewer app
    await this.page.goto('http://localhost:3000');
    
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

  async loadFile(filePath: string) {
    // Find the file input (there are two, use the one in ViewportContainer)
    const fileInput = this.page.locator('input[type="file"]').first();

    // Record wall-clock start time
    this.loadStartTime = Date.now();

    // Upload file
    await fileInput.setInputFiles(filePath);

    // Wait for file loading to start (check for file name in logs)
    await this.page.waitForTimeout(1000);
  }

  /**
   * Check if canvas has actual rendered content (not just blank/gray)
   */
  private async checkCanvasHasContent(): Promise<boolean> {
    try {
      const hasContent = await this.page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return false;
        
        // Check if canvas has non-zero dimensions
        if (canvas.width === 0 || canvas.height === 0) return false;
        
        // Try to sample a few pixels to see if there's actual content
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          const imageData = ctx.getImageData(
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            10, 10
          );
          // Check if any pixels have non-background colors
          for (let i = 0; i < imageData.data.length; i += 4) {
            const r = imageData.data[i];
            const g = imageData.data[i + 1];
            const b = imageData.data[i + 2];
            // Not pure background gray (128, 128, 128 or similar)
            if (Math.abs(r - g) > 5 || Math.abs(g - b) > 5 || r > 200 || r < 50) {
              return true;
            }
          }
        }
        
        // For WebGPU, we can't easily read pixels, so just check dimensions
        return canvas.width > 0 && canvas.height > 0;
      });
      return hasContent;
    } catch {
      return false;
    }
  }

  async waitForCompletion(timeoutMs: number = 600000) {
    const startTime = Date.now();
    let renderCompleteTime: number | null = null;

    // Wait for completion signals in console logs AND actual rendering
    while (Date.now() - startTime < timeoutMs) {
      // Check if we have all key completion signals
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

      if (
        (hasStreamingComplete && hasDataModelComplete && hasTotalLoadTime)
        || hasUnifiedSummary
        || hasFinalSummary
        || (hasStreamingComplete && hasDataModelComplete)
      ) {
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

    // Parse metrics from console logs
    this.parseMetrics();
  }

  private parseMetrics() {
    const logs = this.consoleLogs.join('\n');
    
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
    }

    // Steady-state render stats (issue #1682), emitted post-settle by
    // apps/viewer/src/utils/renderStatsReport.ts — keep formats in sync:
    //   [ifc-lite] render stats: 143 draw calls, 512.3 MB GPU resident
    //   (140 batches drawn, 2 frustum-culled, 1 contribution-culled)
    const renderStatsMatch = logs.match(
      /\[ifc-lite\] render stats: (\d+) draw calls, ([\d.]+) MB GPU resident \((\d+) batches drawn, (\d+) frustum-culled, (\d+) contribution-culled\)/
    );
    if (renderStatsMatch) {
      this.metrics.drawCalls = parseInt(renderStatsMatch[1], 10);
      this.metrics.residentGpuMB = parseFloat(renderStatsMatch[2]);
      this.metrics.batchesContributionCulled = parseInt(renderStatsMatch[5], 10);
    }
  }

  getMetrics(): ViewerBenchmarkMetrics {
    return {
      totalWallClockMs: this.metrics.totalWallClockMs ?? null,
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
    };
  }

  getConsoleLogs(): string[] {
    return [...this.consoleLogs];
  }
}
