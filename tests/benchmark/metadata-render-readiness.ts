/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the page's load trace says about the latest load (#6979). Read inside
 * the page (`ViewerBenchmarkPage.probeLoadTrace`) so a poll returns a few
 * names instead of the whole span tree.
 */
import type { Page } from '@playwright/test';

/** Shared trace probe for full-viewer load and frame rigs (#6975). It uses the
 * canonical fail-closed page callback, so failures are never filtered (#7180). */
export async function probeMetadataRenderTrace(page: Page): Promise<LoadTraceProbe | null> {
  try {
    return await page.evaluate(probePageLoadTrace, { key: '__IFC_LITE_LOAD_TRACE__', names: [...READINESS_SPANS] });
  } catch (error) {
    throw new Error('Cannot read required benchmark load trace (#7005)', { cause: error });
  }
}

export interface LoadTraceProbe {
  /** The load's root span ended (`trace.finish`, the app's own end of load). */
  ended: boolean;
  /** Actual loader route; cached metadata is restored instead of reparsed. */
  loadPath?: string;
  /** Finished spans among `READINESS_SPANS`. */
  done: string[];
  /** Failure markers from every span, including unfinished work. */
  failed: string[];
  invalid?: string;
}

/**
 * The spans readiness waits on: metadata (`parser.complete`, or
 * `parser.failed`), geometry (`geometry.streamComplete`) and the renderer's
 * post-stream rebuild (`scene.finalize`, recorded by the scene itself).
 */
export const READINESS_SPANS = ['parser.complete', 'parser.failed', 'cache.storeReady', 'geometry.streamComplete', 'scene.finalize'] as const;


/** Self-contained page callback: Playwright serializes this function without
 * its module closure. Completion filtering must never hide failures (#7180).
 */
export function probePageLoadTrace({ key, names }: { key: string; names: readonly string[] }): LoadTraceProbe | null {
  type Span = { name: string; start: number; end: number | null; attrs?: Record<string, unknown> };
  const api = (globalThis as unknown as Record<string, {
    latest?: () => { start: number; end: number | null; spans: Span[]; attrs?: { loadPath?: unknown; error?: unknown } } | null;
  } | undefined>)[key];
  const snapshot = api?.latest?.() ?? null;
  if (!snapshot) return null;
  if (!Number.isFinite(snapshot.start) || !Array.isArray(snapshot.spans) || (snapshot.end !== null &&
      (snapshot.end < snapshot.start || typeof snapshot.end !== 'number' || !Number.isFinite(snapshot.end)))) {
    return { ended: false, done: [], failed: [], invalid: 'Malformed load trace root or spans' };
  }
  const done: string[] = [];
  const failed: string[] = snapshot.attrs?.error === true ? ['load'] : [];
  for (const span of snapshot.spans) {
    if (!span || typeof span.name !== 'string' || !Number.isFinite(span.start) ||
        (span.end !== null && (span.end < span.start || typeof span.end !== 'number' || !Number.isFinite(span.end)))) {
      return { ended: false, done, failed, invalid: 'Malformed load trace span' };
    }
    if (span.name === 'parser.failed' || span.attrs?.error === true) failed.push(span.name);
    // Loader-owned completions precede trace.finish. Renderer finalization
    // is deferred separately and may legitimately finish after the root.
    if (span.end !== null && snapshot.end !== null &&
        ['parser.complete', 'cache.storeReady', 'geometry.streamComplete'].includes(span.name) &&
        (span.start < snapshot.start || span.end > snapshot.end)) {
      return { ended: false, done, failed, invalid: 'Loader completion outside load root' };
    }
    if (span.end !== null && names.includes(span.name)) done.push(span.name);
  }
  return {
    ended: snapshot.end !== null, done, failed,
    loadPath: typeof snapshot.attrs?.loadPath === 'string' ? snapshot.attrs.loadPath : undefined,
  };
}

export function metadataCompletionSpan(loadPath: string | undefined): 'parser.complete' | 'cache.storeReady' {
  return loadPath === 'cache' ? 'cache.storeReady' : 'parser.complete';
}

/** Elapsed readiness and completions must share one start/clock. No missing,
 * zero or predating observation is comparable (#7180). Callers with a trace
 * derive bounds from that trace, rather than trusting reported milestone fields.
 */
export function observedReadinessFollowsCompletion(observedMs: unknown, completionMs: readonly unknown[]): boolean {
  return typeof observedMs === 'number' && Number.isFinite(observedMs) && observedMs > 0 &&
    completionMs.length > 0 && completionMs.every(value =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && observedMs >= value);
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
  requireRootEnd?: boolean;
}): Promise<number> {
  const start = options.now();
  let traceSeen = false;
  while (options.now() - start < options.timeoutMs) {
    const probe = await options.trace();
    const logs = options.logs();
    if (probe?.invalid) throw new Error(`Invalid benchmark load trace: ${probe.invalid}`);
    if (probe) traceSeen = true;
    const done = new Set(probe?.done ?? []);
    const failed = new Set(probe?.failed ?? []);
    const metadataSpan = metadataCompletionSpan(probe?.loadPath);
    if (done.has('parser.failed') || failed.has('parser.failed') || failed.has(metadataSpan)) {
      throw new Error('Metadata failed before metadata/render readiness');
    }
    if (failed.has('geometry.streamComplete')) throw new Error('Geometry failed before metadata/render readiness');
    if (failed.has('scene.finalize') || logs.some(log => RENDERER_INIT_FAILED.test(log))) {
      throw new Error('Renderer failed before metadata/render readiness');
    }
    if (failed.size > 0) throw new Error(`Load failed before metadata/render readiness: ${[...failed].join(', ')}`);
    const metadata = done.has(metadataSpan);
    const geometry = done.has('geometry.streamComplete');
    const renderer = done.has('scene.finalize');
    if (metadata && geometry && renderer && (!options.requireRootEnd || probe?.ended) && await options.canvasReady()) return options.now();
    await options.pause();
  }
  if (!traceSeen) throw new Error('Missing benchmark load trace: require a viewer built after #6979 with perfTrace enabled (#7005)');
  throw new Error('Timed out awaiting metadata, geometry, renderer finalize and allocated canvas; sample incomplete');
}
