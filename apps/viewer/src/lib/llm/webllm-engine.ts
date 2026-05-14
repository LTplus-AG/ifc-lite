/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Singleton wrapper around the MLC WebLLM engine.
 *
 * Holds at most one loaded model in memory. Switching to a different model
 * unloads the previous one to free VRAM. Download progress is fanned out
 * to any subscribers (the ModelDownloadCard listens during first-load).
 */

import type { MLCEngineInterface, InitProgressReport } from '@mlc-ai/web-llm';

export interface WebLLMProgress {
  modelId: string;
  /** Progress fraction in [0, 1], or null when MLC hasn't reported one yet. */
  progress: number | null;
  /** Human-readable status text from MLC (e.g. "Loading model from cache"). */
  text: string;
}

type ProgressListener = (event: WebLLMProgress) => void;

let engine: MLCEngineInterface | null = null;
let engineModelId: string | null = null;
let loading: Promise<MLCEngineInterface> | null = null;
const listeners = new Set<ProgressListener>();

export function onWebLLMProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: WebLLMProgress): void {
  for (const l of listeners) {
    try { l(event); } catch { /* swallow listener errors */ }
  }
}

export function getActiveWebLLMModelId(): string | null {
  return engineModelId;
}

/**
 * Load (or reuse) the engine for the given MLC model id. If a different
 * model is currently loaded, unload it first.
 */
export async function ensureWebLLMEngine(modelId: string): Promise<MLCEngineInterface> {
  if (engine && engineModelId === modelId) return engine;
  if (loading && engineModelId === modelId) return loading;

  // Switching models — unload the previous engine before loading the new one.
  if (engine && engineModelId !== modelId) {
    const previous = engine;
    engine = null;
    engineModelId = null;
    try { await previous.unload(); } catch { /* best-effort */ }
  }

  engineModelId = modelId;
  loading = (async () => {
    const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
    const created = await CreateMLCEngine(modelId, {
      initProgressCallback: (report: InitProgressReport) => {
        emit({ modelId, progress: report.progress ?? null, text: report.text });
      },
    });
    engine = created;
    return created;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Unload the currently active engine, if any. */
export async function unloadWebLLMEngine(): Promise<void> {
  const previous = engine;
  engine = null;
  engineModelId = null;
  if (previous) {
    try { await previous.unload(); } catch { /* best-effort */ }
  }
}
