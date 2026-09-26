/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useEffect } from 'react';

/**
 * Why WebGPU is unavailable, grouped by the remedy that actually applies —
 * NOT by which line of code detected it. These have almost disjoint fixes:
 *
 * - 'insecure-context': `navigator.gpu` is only ever exposed on a secure
 *   context (https, or http on localhost). On plain http with an IP or a
 *   hostname, `navigator.gpu` is undefined in EVERY browser — which looks
 *   identical to "no browser supports this" but has nothing to do with the
 *   device. GPU flags cannot fix it; the origin has to change.
 * - 'no-api': `navigator.gpu` is missing on a secure context. Causes we can
 *   observe from here: an embedded webview that doesn't ship WebGPU, an
 *   enterprise policy disabling it, or a browser too old for the feature.
 *   We cannot tell these apart from the page, so the copy must list them as
 *   possibilities, not assert one.
 * - 'no-gpu': `navigator.gpu` exists but no adapter could be created (or
 *   adapter creation threw). This is the genuine hardware/driver case a
 *   blocklisted GPU, a VM/remote session with no GPU passthrough, or a
 *   machine with no working Vulkan/Metal/D3D12 driver and it is the only
 *   category where the blocklist-override flags belong.
 */
export type WebGPUUnavailableReason = 'insecure-context' | 'no-api' | 'no-gpu';

export interface WebGPUStatus {
  supported: boolean;
  checking: boolean;
  reason: string | null;
  category: WebGPUUnavailableReason | null;
}

const CHECKING_STATUS: WebGPUStatus = {
  supported: false,
  checking: true,
  reason: null,
  category: null,
};

// The viewer mounts the open guard in both the viewport and URL autoload,
// while the status bar also reads this hook. One browser capability probe is
// enough for all of them; a new navigator.gpu object or security context
// (as in a test) starts a new probe.
let cachedProbe: {
  gpu: Navigator['gpu'];
  secureContext: boolean;
  result: Promise<WebGPUStatus>;
  status: WebGPUStatus | null;
} | undefined;
const subscribers = new Set<(status: WebGPUStatus) => void>();

function publish(status: WebGPUStatus): void {
  for (const subscriber of subscribers) subscriber(status);
}

export function getWebGPUStatus(): WebGPUStatus {
  return cachedProbe !== undefined && cachedProbe.gpu === navigator.gpu && cachedProbe.secureContext === window.isSecureContext
    ? cachedProbe.status ?? CHECKING_STATUS
    : CHECKING_STATUS;
}

function probeWebGPU(force = false): Promise<WebGPUStatus> {
  const gpu = navigator.gpu;
  const secureContext = window.isSecureContext;
  if (!force && cachedProbe !== undefined && cachedProbe.gpu === gpu && cachedProbe.secureContext === secureContext) {
    return cachedProbe.result;
  }

  const result = (async (): Promise<WebGPUStatus> => {
    if (!gpu) {
      return secureContext
        ? { supported: false, checking: false, reason: 'WebGPU API not available in this browser', category: 'no-api' }
        : { supported: false, checking: false, reason: 'This page is not a secure context (WebGPU requires https:// or http://localhost)', category: 'insecure-context' };
    }

    try {
      const adapter = await gpu.requestAdapter();
      return adapter
        ? { supported: true, checking: false, reason: null, category: null }
        : { supported: false, checking: false, reason: 'No compatible GPU adapter found', category: 'no-gpu' };
    } catch (error) {
      return {
        supported: false,
        checking: false,
        reason: error instanceof Error ? error.message : 'Failed to initialize WebGPU',
        category: 'no-gpu',
      };
    }
  })();
  const entry = { gpu, secureContext, result, status: null as WebGPUStatus | null };
  cachedProbe = entry;
  publish(CHECKING_STATUS);
  void result.then((status) => {
    if (cachedProbe !== entry) return;
    entry.status = status;
    publish(status);
  });
  return result;
}

/** Explicit Retry rechecks a settled failure; concurrent callers still share one in-flight probe. */
export function retryWebGPU(): Promise<WebGPUStatus> {
  return probeWebGPU(cachedProbe?.status !== null);
}

/**
 * Robust WebGPU detection hook.
 *
 * Detection method:
 * 1. Check whether the page is a secure context (WebGPU is secure-context-only)
 * 2. Check if navigator.gpu exists (basic API availability)
 * 3. Attempt to request a GPU adapter (confirms actual hardware/driver support)
 *
 * This ordering is necessary because:
 * - `navigator.gpu` is undefined on an insecure origin regardless of the
 *   device, so that check has to come first or it gets mistaken for "no
 *   browser on this device supports WebGPU"
 * - Some browsers expose navigator.gpu but fail to provide an adapter
 * - Software rendering may be available but unsuitable for our use case
 * - Driver issues can prevent adapter creation even with WebGPU support
 */
export function useWebGPU(): WebGPUStatus {
  const [status, setStatus] = useState<WebGPUStatus>(CHECKING_STATUS);

  useEffect(() => {
    subscribers.add(setStatus);
    setStatus(getWebGPUStatus());
    void probeWebGPU();
    return () => { subscribers.delete(setStatus); };
  }, []);

  return status;
}
