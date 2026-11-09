/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

type Request = (isCurrent: () => boolean) => Promise<void>;
/** `cancelled` is false when the current run ended (published, failed, or drew nothing). */
type OnEnded = (cancelled: boolean) => void;
interface Entry { run: Request; revision: number; onEnded?: OnEnded }

/**
 * One cut at a time, with only the newest pending input retained (#3921).
 *
 * Requests form chains: each new request supersedes the previous one and takes
 * over its pending outcome. A chain ends exactly once, through its newest
 * request's `onEnded` — when that request's run finishes while still current,
 * or when `cancel()` abandons the chain (whether its newest request is
 * running, queued behind an abandoned run, or never started). A superseded
 * request never ends anything, so its successor's ending covers it (#9488).
 */
export function createDrawingRequestQueue() {
  let revision = 0;
  let pending: Entry | undefined;
  /** The newest request of the chain that has not ended yet. */
  let owner: Entry | undefined;
  let completion: Promise<void> | undefined;

  function end(entry: Entry | undefined, cancelled: boolean) {
    if (!entry || entry !== owner) return;
    owner = undefined;
    entry.onEnded?.(cancelled);
  }

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
        } finally {
          if (next.revision === revision) end(next, false);
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
    cancel() { revision++; pending = undefined; end(owner, true); },
    request(run: Request, onEnded?: OnEnded): Promise<void> {
      const entry: Entry = { run, revision: ++revision, onEnded };
      pending = entry;
      owner = entry;
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
