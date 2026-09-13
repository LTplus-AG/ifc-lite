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
  const [status, setStatus] = useState<WebGPUStatus>({
    supported: false,
    checking: true,
    reason: null,
    category: null,
  });

  useEffect(() => {
    async function checkWebGPUSupport() {
      // Step 1: Check if WebGPU API is available
      if (!navigator.gpu) {
        if (!window.isSecureContext) {
          setStatus({
            supported: false,
            checking: false,
            reason: 'This page is not a secure context (WebGPU requires https:// or http://localhost)',
            category: 'insecure-context',
          });
          return;
        }
        setStatus({
          supported: false,
          checking: false,
          reason: 'WebGPU API not available in this browser',
          category: 'no-api',
        });
        return;
      }

      try {
        // Step 2: Try to get a GPU adapter
        // This confirms actual hardware/driver support
        const adapter = await navigator.gpu.requestAdapter();

        if (!adapter) {
          setStatus({
            supported: false,
            checking: false,
            reason: 'No compatible GPU adapter found',
            category: 'no-gpu',
          });
          return;
        }

        // Optional: Check for required features if needed
        // const features = adapter.features;
        // const limits = adapter.limits;

        setStatus({
          supported: true,
          checking: false,
          reason: null,
          category: null,
        });
      } catch (error) {
        setStatus({
          supported: false,
          checking: false,
          reason: error instanceof Error ? error.message : 'Failed to initialize WebGPU',
          category: 'no-gpu',
        });
      }
    }

    checkWebGPUSupport();
  }, []);

  return status;
}
