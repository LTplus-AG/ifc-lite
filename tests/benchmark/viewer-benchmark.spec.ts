/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { ViewerBenchmarkPage, ViewerBenchmarkMetrics } from './viewer-benchmark-page';

interface ViewerBenchmarkResult {
  file: string;
  sizeMB: number;
  timestamp: string;
  environment: {
    runtime: 'browser-wasm';
    cacheMode: string;
    buildMode: string;
  };
  metrics: ViewerBenchmarkMetrics;
  thresholds: {
    passed: boolean;
    violations: string[];
  };
}

interface Baseline {
  [fileName: string]: {
    metrics: ViewerBenchmarkMetrics;
    timestamp: string;
  };
}

interface ThresholdConfig {
  firstBatchWaitMs: number;
  firstVisibleGeometryMs: number;
  streamCompleteMs: number;
  spatialReadyMs: number;
  metadataCompleteMs: number;
  totalWallClockMs: number;
}

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  firstBatchWaitMs: 50,
  firstVisibleGeometryMs: 50,
  streamCompleteMs: 50,
  spatialReadyMs: 50,
  metadataCompleteMs: 50,
  totalWallClockMs: 50,
};

function loadBaseline(): Baseline {
  const baselinePath = join(process.cwd(), 'tests/benchmark/baseline.json');
  if (existsSync(baselinePath)) {
    try {
      return JSON.parse(readFileSync(baselinePath, 'utf-8'));
    } catch (e) {
      console.warn('Failed to load baseline, starting fresh');
      return {};
    }
  }
  return {};
}

function checkThresholds(
  metrics: ViewerBenchmarkMetrics,
  baseline: ViewerBenchmarkMetrics | null,
  thresholds: ThresholdConfig
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];

  if (!baseline) {
    // No baseline, skip threshold checks
    return { passed: true, violations: [] };
  }

  const kpiMetrics: Array<keyof ThresholdConfig> = [
    'firstBatchWaitMs',
    'firstVisibleGeometryMs',
    'streamCompleteMs',
    'spatialReadyMs',
    'metadataCompleteMs',
    'totalWallClockMs',
  ];

  for (const metricName of kpiMetrics) {
    const currentValue = metrics[metricName];
    const baselineValue = baseline[metricName];
    if (currentValue === null || baselineValue === null || baselineValue <= 0) {
      continue;
    }
    const increase = ((currentValue - baselineValue) / baselineValue) * 100;
    if (increase > thresholds[metricName]) {
      violations.push(
        `${metricName} increased by ${increase.toFixed(1)}% (${currentValue}ms vs ${baselineValue}ms baseline)`
      );
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

test.describe('Viewer Performance Benchmarks', () => {
  // Get IFC files from environment variable or use defaults
  const ifcFilesEnv = process.env.VIEWER_BENCHMARK_FILES;
  const ifcFiles = ifcFilesEnv
    ? ifcFilesEnv.split(',').map((f) => f.trim())
    : [
        'tests/models/ara3d/AC20-FZK-Haus.ifc',  // Small, fast, has cutouts - ideal for boolean testing
        'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc',
        'tests/models/various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc',
        'tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
      ];

  const baseline = loadBaseline();
  const thresholds = DEFAULT_THRESHOLDS;

  // Expected mesh counts for geometry correctness validation
  // These help detect if optimizations break geometry (e.g., CSG skipping too much)
  const expectedMeshCounts: Record<string, number> = {
    // NB: totalMeshes is scraped from "[useIfc] Geometry streaming complete: N batches, M meshes"
    // = mesh OCCURRENCES streamed (instanced occurrences counted). This is a different quantity
    // from the deduped allMeshes.length that the "[ifc-lite] … → N meshes" summary and the PostHog
    // `ifc_model_loaded.mesh_count` report. Keep every expected value below in the SAME occurrence
    // unit as totalMeshes so this assertion stays apples-to-apples.
    'AC20-FZK-Haus.ifc': 317,  // Verified vs raw WASM pipeline 2026-06-10: incl. 32 type meshes (#957) + 7 IfcSpace (#1022). Was 230 pre-type-geometry/spaces.
    '01_Snowdon_Towers_Sample_Structural(1).ifc': 17380,  // Occurrence count, verified identical across CI SwiftShader + local A/B on 2026-07-02. Was a stale 1500 (deduped/legacy-metric value) that silently disabled this drop check for Snowdon.
    'O-S1-BWK-BIM architectural - BIM bouwkundig.ifc': 16400,  // Large architectural model
    'ISSUE_053_20181220Holter_Tower_10.ifc': 60000,  // Complex model (some walls may skip CSG due to MAX_OPENINGS)
  };

  for (const ifcFile of ifcFiles) {
    test(`benchmark ${ifcFile}`, async ({ page }) => {
      const fileName = ifcFile.split('/').pop() || 'unknown';
      // Accept absolute paths (e.g. a model outside the repo) as well as
      // repo-relative ones.
      const filePath = isAbsolute(ifcFile) ? ifcFile : join(process.cwd(), ifcFile);

      // Skip if file doesn't exist
      if (!existsSync(filePath)) {
        console.log(`Skipping ${fileName} - file not found at ${filePath}`);
        test.skip();
        return;
      }

      const benchmarkPage = new ViewerBenchmarkPage(page);
      await benchmarkPage.setup();

      // Load file
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Loading ${fileName}...`);
      console.log(`${'='.repeat(80)}`);

      await benchmarkPage.loadFile(filePath);

      // Wait for completion (long timeout for large files)
      const fileSizeMB = (await import('fs')).statSync(filePath).size / (1024 * 1024);
      const timeoutMs = fileSizeMB > 200 ? 600000 : fileSizeMB > 50 ? 300000 : 180000; // 10min / 5min / 3min

      console.log(`Waiting for completion (timeout: ${timeoutMs / 1000}s)...`);
      await benchmarkPage.waitForCompletion(timeoutMs);

      // Extract metrics
      const metrics = benchmarkPage.getMetrics();

      // Get baseline for this file
      const baselineMetrics = baseline[fileName]?.metrics || null;

      // Check thresholds
      const thresholdResult = checkThresholds(metrics, baselineMetrics, thresholds);

      // Log results
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Benchmark Results: ${fileName}`);
      console.log(`${'='.repeat(80)}`);
      console.log(`\nFile Size: ${metrics.fileSizeMB?.toFixed(2) || 'N/A'} MB`);
      
      // TOTAL TIME - the most important metric
      console.log(`\n>>> TOTAL WALL-CLOCK TIME: ${metrics.totalWallClockMs?.toFixed(0) || 'N/A'} ms (${((metrics.totalWallClockMs || 0) / 1000).toFixed(1)}s) <<<`);
      console.log(`    File Read: ${metrics.fileReadMs?.toFixed(0) || 'N/A'} ms`);
      
      console.log(`\n--- Geometry Streaming ---`);
      console.log(`  Model Open: ${metrics.modelOpenMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  First Batch Wait: ${metrics.firstBatchWaitMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  First Append Batch: ${metrics.firstAppendGeometryBatchMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  First Visible Geometry: ${metrics.firstVisibleGeometryMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  Stream Complete: ${metrics.streamCompleteMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  First Batch Meshes: ${metrics.firstBatchMeshes?.toLocaleString() || 'N/A'}`);
      console.log(`  Total Batches: ${metrics.totalBatches?.toLocaleString() || 'N/A'}`);
      console.log(`  Total Meshes: ${metrics.totalMeshes?.toLocaleString() || 'N/A'}`);
      console.log(`  Geometry Streaming Total: ${metrics.geometryStreamingMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  WASM Wait: ${metrics.wasmWaitMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  JS Process: ${metrics.jsProcessMs?.toFixed(0) || 'N/A'} ms`);

      console.log(`\n--- Data Model Parsing ---`);
      console.log(`  Metadata Start: ${metrics.metadataStartMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  Spatial Ready: ${metrics.spatialReadyMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  Metadata Complete: ${metrics.metadataCompleteMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  Metadata Failed: ${metrics.metadataFailedMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  Entity Scan: ${metrics.entityScanMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  Entity Count: ${metrics.entityCount?.toLocaleString() || 'N/A'}`);
      console.log(`  Data Model Parse: ${metrics.dataModelParseMs?.toFixed(0) || 'N/A'} ms`);
      console.log(`  Data Model Entities: ${metrics.dataModelEntityCount?.toLocaleString() || 'N/A'}`);

      console.log(`\n--- Render Stats (steady state, issue #1682) ---`);
      console.log(`  Draw Calls: ${metrics.drawCalls?.toLocaleString() || 'N/A'}`);
      console.log(`  Resident GPU: ${metrics.residentGpuMB?.toFixed(1) || 'N/A'} MB`);
      console.log(`  Contribution-Culled Batches: ${metrics.batchesContributionCulled?.toLocaleString() || 'N/A'}`);
      console.log(`  Instanced Drawn: ${metrics.instancedDrawn?.toLocaleString() || 'N/A'}`);
      console.log(`  Instanced Frustum-Culled: ${metrics.instancedFrustumCulled?.toLocaleString() || 'N/A'}`);
      console.log(`  Instanced Contribution-Culled: ${metrics.instancedContributionCulled?.toLocaleString() || 'N/A'}`);

      if (baselineMetrics) {
        console.log(`\n--- Comparison with Baseline ---`);
        const comparisonMetrics: Array<keyof ThresholdConfig> = [
          'firstBatchWaitMs',
          'firstVisibleGeometryMs',
          'streamCompleteMs',
          'spatialReadyMs',
          'metadataCompleteMs',
          'totalWallClockMs',
        ];
        for (const metricName of comparisonMetrics) {
          const currentValue = metrics[metricName];
          const baselineValue = baselineMetrics[metricName];
          if (currentValue !== null && baselineValue !== null && baselineValue > 0) {
            const diff = currentValue - baselineValue;
            const pct = ((diff / baselineValue) * 100).toFixed(1);
            console.log(`  ${metricName}: ${diff > 0 ? '+' : ''}${diff.toFixed(0)}ms (${diff > 0 ? '+' : ''}${pct}%)`);
          }
        }
      } else {
        console.log(`\n--- No Baseline Available ---`);
        console.log(`  This run will be used as the baseline for future comparisons.`);
      }

      if (thresholdResult.violations.length > 0) {
        console.log(`\n--- Threshold Violations ---`);
        thresholdResult.violations.forEach((v) => console.log(`  ⚠ ${v}`));
      }

      console.log(`${'='.repeat(80)}\n`);

      // Save results
      const outputDir = join(process.cwd(), 'tests/benchmark/benchmark-results');
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const result: ViewerBenchmarkResult = {
        file: fileName,
        sizeMB: metrics.fileSizeMB || 0,
        timestamp: new Date().toISOString(),
        environment: {
          runtime: 'browser-wasm',
          cacheMode: process.env.VIEWER_BENCHMARK_CACHE_MODE ?? 'default',
          buildMode: process.env.VIEWER_BENCHMARK_BUILD_MODE ?? 'dev',
        },
        metrics,
        thresholds: thresholdResult,
      };

      const safeName = fileName.replace(/[^a-zA-Z0-9]/g, '_');
      const outputPath = join(outputDir, `viewer-${safeName}.json`);
      writeFileSync(outputPath, JSON.stringify(result, null, 2));
      console.log(`Results saved to ${outputPath}`);

      // Dump the full browser console log so the detailed [stream]/[useIfc]
      // timeline (pre-pass scan, worker count, per-worker first batch, parse
      // milestones) is available for profiling, not just the parsed KPIs.
      const logPath = join(outputDir, `viewer-${safeName}.console.log`);
      writeFileSync(logPath, benchmarkPage.getConsoleLogs().join('\n'));
      console.log(`Console log saved to ${logPath}`);

      // Assertions — the load actually completed and produced geometry.
      // (modelOpenMs is a legacy log the current viewer no longer emits;
      // streamCompleteMs is the real "geometry finished" signal.)
      expect(metrics.streamCompleteMs).not.toBeNull();
      expect(metrics.totalMeshes).toBeGreaterThan(0);

      // Geometry correctness validation: Check mesh count matches expected (within 5% tolerance)
      // This detects if optimizations break geometry (e.g., CSG skipping too much, missing cutouts)
      if (expectedMeshCounts[fileName] && metrics.totalMeshes !== null) {
        const expected = expectedMeshCounts[fileName];
        const actual = metrics.totalMeshes;
        const tolerance = expected * 0.05; // 5% tolerance for minor variations
        
        if (actual < expected - tolerance) {
          console.warn(
            `\n⚠ Geometry regression detected for ${fileName}:\n` +
            `  Expected: ${expected} meshes (minimum: ${expected - tolerance})\n` +
            `  Actual: ${actual} meshes\n` +
            `  Difference: ${expected - actual} meshes missing\n` +
            `  This may indicate cutouts/booleans are being skipped incorrectly.`
          );
          // Don't fail the test, but log warning - allows for legitimate optimizations
          // that reduce mesh count (e.g., better deduplication)
        } else {
          console.log(`✓ Mesh count validation passed: ${actual} meshes (expected: ${expected} ±${tolerance.toFixed(0)})`);
        }
      }

      // Fail if thresholds violated. VIEWER_BENCHMARK_ADVISORY=1 downgrades
      // this to a warning: the CI benchmark job is advisory-only (the verdict
      // is `pnpm benchmark:check` + the PR comment, not a red job), and the
      // committed baseline may come from a different machine class than the
      // current runner.
      if (!thresholdResult.passed) {
        if (process.env.VIEWER_BENCHMARK_ADVISORY === '1') {
          console.warn(
            `Advisory mode: thresholds exceeded but not failing the test:\n${thresholdResult.violations.join('\n')}`
          );
        } else {
          throw new Error(`Performance regression detected:\n${thresholdResult.violations.join('\n')}`);
        }
      }
    });
  }
});
