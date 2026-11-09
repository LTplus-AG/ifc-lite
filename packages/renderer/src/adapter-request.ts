/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bound on `requestAdapter()`. A conformant browser settles it with an adapter
 * or null, but a broken driver, a remote session or a GPU-less headless browser
 * can leave it pending forever, so nothing downstream could show an error
 * (#9076). Past the bound the request rejects with "GPU adapter request timed out".
 */
export const ADAPTER_REQUEST_TIMEOUT_MS = 10_000;

/** `gpu.requestAdapter()`, rejecting once {@link ADAPTER_REQUEST_TIMEOUT_MS} passes unsettled. */
export async function requestAdapterWithTimeout(gpu: GPU, options?: GPURequestAdapterOptions): Promise<GPUAdapter | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('GPU adapter request timed out')), ADAPTER_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([gpu.requestAdapter(options), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
