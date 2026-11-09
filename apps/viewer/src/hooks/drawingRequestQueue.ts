/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

type Request = (isCurrent: () => boolean) => Promise<void>;
interface Entry { run: Request; revision: number; onCancel?: () => void }

/**
 * One cut at a time, with only the newest pending input retained (#3921).
 *
 * Exactly one request owns the terminal transition: the current one, which
 * publishes its own result, error or empty state. Superseding hands that
 * ownership to the newer request; `cancel()` leaves no current request, so it
 * hands it to the running one's `onCancel` instead, or a cut abandoned
 * mid-flight would leave "generating" behind for good.
 */
export function createDrawingRequestQueue() {
  let revision = 0;
  let pending: Entry | undefined;
  let running: Entry | undefined;
  let completion: Promise<void> | undefined;

  async function drain() {
    try {
      while (pending) {
        const next = pending;
        pending = undefined;
        running = next;
        try {
          await next.run(() => next.revision === revision);
        } catch (error) {
          if (!pending) throw error;
          // All callers await the drain's newest request. An obsolete failure
          // is reported, but must not discard newer work already waiting.
          console.error('Superseded drawing request failed:', error);
        } finally {
          running = undefined;
        }
      }
    } finally {
      pending = undefined;
      completion = undefined;
    }
  }

  return {
    /** A cut is running or waiting: its result will publish without another request. */
    busy() { return completion !== undefined; },
    cancel() {
      revision++; pending = undefined;
      const abandoned = running;
      running = undefined;
      abandoned?.onCancel?.();
    },
    /** `onCancel` runs once if `cancel()` abandons this request mid-flight. */
    request(run: Request, onCancel?: () => void): Promise<void> {
      pending = { run, revision: ++revision, onCancel };
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
