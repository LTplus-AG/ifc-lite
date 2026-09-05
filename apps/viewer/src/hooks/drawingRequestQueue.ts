/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

type Request = (isCurrent: () => boolean) => Promise<void>;

/** One cut at a time, with only the newest pending input retained (#3921). */
export function createDrawingRequestQueue() {
  let revision = 0;
  let pending: { run: Request; revision: number } | undefined;
  let completion: Promise<void> | undefined;

  async function drain() {
    try {
      while (pending) {
        const next = pending;
        pending = undefined;
        try {
          await next.run(() => next.revision === revision);
        } catch (error) {
          if (!pending) throw error;
          // All callers await the drain's newest request. An obsolete failure
          // is reported, but must not discard newer work already waiting.
          console.error('Superseded drawing request failed:', error);
        }
      }
    } finally {
      pending = undefined;
      completion = undefined;
    }
  }

  return {
    cancel() { revision++; pending = undefined; },
    request(run: Request): Promise<void> {
      pending = { run, revision: ++revision };
      if (completion) return completion;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // Install before running: status updates can synchronously request again.
      completion = promise;
      void drain().then(resolve, reject);
      return promise;
    },
  };
}
