/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Federated adds may inspect their header while a primary is deciding, but
 * cannot publish into the scene that primary is about to replace (#10264). */
export function pendingPrimarySession(value: number) {
  let settle!: (initialized: boolean) => void;
  const ready = new Promise<boolean>(resolve => { settle = resolve; });
  return { value, ready, settle };
}

export function waitForPrimaryInitialization(ready: Promise<boolean> | undefined, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (!ready) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (initialized: boolean) => { signal.removeEventListener('abort', abort); resolve(initialized); };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    void ready.then(finish);
  });
}
