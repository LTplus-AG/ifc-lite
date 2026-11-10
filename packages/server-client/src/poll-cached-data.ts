/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


/** Retry transport failures and pending cache entries; absence is distinct from failure. */
export async function pollCachedData<T>(
  url: string,
  headers: HeadersInit,
  options: { maxRetries?: number; signal?: AbortSignal },
  decode: (response: Response) => Promise<T>,
  httpError: (response: Response) => Promise<Error>,
): Promise<T | null> {
  const { signal, maxRetries = 10 } = options;
  signal?.throwIfAborted();
  let delay = 100;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    signal?.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: 'GET', headers,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === maxRetries - 1) throw error;
    }
    if (response) {
      if (response.status === 200) return decode(response);
      if (response.status === 404) return null;
      if (response.status !== 202) throw await httpError(response);
    }
    if (attempt + 1 < maxRetries) {
      await wait(delay, signal);
      delay = Math.min(delay * 1.5, 2000);
    }
  }
  return null;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
