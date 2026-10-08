/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the page's load trace says about the latest load (#6979). Read inside
 * the page (`ViewerBenchmarkPage.probeLoadTrace`) so a poll returns a few
 * names instead of the whole span tree.
 */
import type { Page } from '@playwright/test';

/** Shared trace probe for full-viewer load and frame rigs (#6975). */
export async function probeMetadataRenderTrace(page: Page): Promise<LoadTraceProbe | null> {
  try {
    return await page.evaluate(({ names }) => {
      type Span = { name: string; end: number | null; attrs?: Record<string, unknown> };
      const api = (globalThis as unknown as {
        __IFC_LITE_LOAD_TRACE__?: { latest?: () => { end: number | null; spans: Span[] } | null };
      }).__IFC_LITE_LOAD_TRACE__;
      const snapshot = api?.latest?.() ?? null;
      if (!snapshot) return null;
      const done: string[] = [], failed: string[] = [];
      for (const span of snapshot.spans) {
        if (span.end === null || !names.includes(span.name)) continue;
        done.push(span.name);
        if (span.attrs?.error === true) failed.push(span.name);
      }
      return { ended: snapshot.end !== null, done, failed };
    }, { names: [...READINESS_SPANS] as string[] });
  } catch (error) {
    console.warn('[Benchmark] could not probe the load trace', error);
    return null;
  }
}

export interface LoadTraceProbe {
  /** The load's root span ended (`trace.finish`, the app's own end of load). */
  ended: boolean;
  /** Finished spans among `READINESS_SPANS`. */
  done: string[];
  /** Finished spans among `READINESS_SPANS` that carry `error: true`. */
  failed: string[];
}

/**
 * The spans readiness waits on: metadata (`parser.complete`, or
 * `parser.failed`), geometry (`geometry.streamComplete`) and the renderer's
 * post-stream rebuild (`scene.finalize`, recorded by the scene itself).
 */
export const READINESS_SPANS = ['parser.complete', 'parser.failed', 'geometry.streamComplete', 'scene.finalize'] as const;

/**
 * TODO(remove-by: first release after 2026-10-06, i.e. one after #6977, with
 * the regex fallback in viewer-benchmark-page.ts; #7005): console lines for a
 * viewer build that predates the spans. `browser-cold-ab.mts` serves an older base
 * build with THIS harness, so until the base side carries #6977 (no trace at
 * all) and #6979 (`scene.finalize`), readiness falls back to them.
 */
function legacyReadiness(logs: readonly string[]) {
  return {
    metadataFailed: logs.some(log => /\[useIfc\].*(?:metadata|Data model) (?:parse|parsing) failed/i.test(log)),
    metadata: logs.some(log => /\[useIfc\] (?:Native )?(?:metadata|Data model) (?:parse|parsing) complete/i.test(log)),
    geometry: logs.some(log => /\[useIfc\] (?:Native )?(?:Stream complete|Geometry streaming complete)/i.test(log)),
    renderer: logs.some(log => /\[GeomStream\] finalizeStreamingAsync complete:/.test(log)),
  };
}

/**
 * Renderer initialisation has no span: the renderer starts at boot, before any
 * load (and so any trace) exists. Its failure line stays the one console
 * signal readiness reads on every build, to fail fast instead of timing out.
 */
const RENDERER_INIT_FAILED = /\[Viewport\] Renderer init failed/;

/**
 * Metadata + geometry + renderer finalize + allocated canvas; no WebGPU
 * pixel-readback claim (#3978). Signals come from the load-trace spans.
 */
export async function waitForMetadataRenderReadiness(options: {
  trace: () => Promise<LoadTraceProbe | null>;
  logs: () => readonly string[];
  canvasReady: () => Promise<boolean>;
  now: () => number;
  pause: () => Promise<void>;
  timeoutMs: number;
}): Promise<number> {
  const start = options.now();
  while (options.now() - start < options.timeoutMs) {
    const probe = await options.trace();
    const logs = options.logs();
    const legacy = legacyReadiness(logs);
    const done = new Set(probe?.done ?? []);
    const failed = new Set(probe?.failed ?? []);
    if (done.has('parser.failed') || (!probe && legacy.metadataFailed)) {
      throw new Error('Metadata failed before metadata/render readiness');
    }
    if (failed.has('scene.finalize') || logs.some(log => RENDERER_INIT_FAILED.test(log))) {
      throw new Error('Renderer failed before metadata/render readiness');
    }
    const metadata = probe ? done.has('parser.complete') : legacy.metadata;
    const geometry = probe ? done.has('geometry.streamComplete') : legacy.geometry;
    const renderer = done.has('scene.finalize') || legacy.renderer;
    if (metadata && geometry && renderer && await options.canvasReady()) return options.now();
    await options.pause();
  }
  throw new Error('Timed out awaiting metadata, geometry, renderer finalize and allocated canvas; sample incomplete');
}
