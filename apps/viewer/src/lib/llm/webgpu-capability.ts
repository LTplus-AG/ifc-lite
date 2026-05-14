/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU + cross-origin-isolation capability detection for the in-browser
 * (WebLLM) chat backend.
 *
 * The Local-LLM tier in the model picker is gated on these checks. If any
 * fails, we hide the tier rather than letting the user pick a model that
 * will then fail to load.
 */

export type WebLLMBlockReason =
  | 'no-webgpu'
  | 'no-adapter'
  | 'not-cross-origin-isolated';

export interface WebLLMCapabilityOk {
  supported: true;
  /** Estimated single-buffer cap, in GB — used to pick a default model tier. */
  vramGB: number;
  /** Suggested model tier given the heuristic VRAM/RAM check. */
  recommendedTier: 'lite' | 'default' | 'reasoning';
}

export interface WebLLMCapabilityBlocked {
  supported: false;
  reason: WebLLMBlockReason;
}

export type WebLLMCapability = WebLLMCapabilityOk | WebLLMCapabilityBlocked;

let cached: Promise<WebLLMCapability> | null = null;

interface NavigatorWithGPU {
  gpu?: {
    requestAdapter(): Promise<{ limits?: { maxBufferSize?: number } } | null>;
  };
  deviceMemory?: number;
}

export function detectWebLLMSupport(): Promise<WebLLMCapability> {
  if (cached) return cached;
  cached = (async (): Promise<WebLLMCapability> => {
    if (typeof window === 'undefined') return { supported: false, reason: 'no-webgpu' };
    if (window.isSecureContext === false) return { supported: false, reason: 'no-webgpu' };
    if (window.crossOriginIsolated === false) {
      return { supported: false, reason: 'not-cross-origin-isolated' };
    }
    const nav = navigator as unknown as NavigatorWithGPU;
    if (!nav.gpu) return { supported: false, reason: 'no-webgpu' };
    let adapter: { limits?: { maxBufferSize?: number } } | null = null;
    try {
      adapter = await nav.gpu.requestAdapter();
    } catch {
      return { supported: false, reason: 'no-adapter' };
    }
    if (!adapter) return { supported: false, reason: 'no-adapter' };
    const maxBufferBytes = adapter.limits?.maxBufferSize ?? 0;
    // maxBufferSize roughly tracks usable VRAM tier — 4 GB on integrated, 8+ on discrete.
    const vramGB = maxBufferBytes / 1e9;
    // Combine with deviceMemory (system RAM) for the recommendation.
    const ramGB = nav.deviceMemory ?? 4;
    const recommendedTier: WebLLMCapabilityOk['recommendedTier'] =
      vramGB >= 6 && ramGB >= 8 ? 'default' : ramGB >= 6 ? 'reasoning' : 'lite';
    return { supported: true, vramGB, recommendedTier };
  })();
  return cached;
}

/** Test-only: clear the memoized detection. */
export function __resetWebLLMCapabilityCache(): void {
  cached = null;
}
