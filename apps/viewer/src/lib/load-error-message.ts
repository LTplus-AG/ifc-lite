/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Humanisation of model-load failures: the user-facing half of
 * ./load-errors.ts.
 *
 * Split out from it so the classifier stays under the ~400-line module rule.
 * The two halves have different audiences and different blast radii — the
 * classifier feeds analytics grouping and the severity/drop decisions in
 * ./analytics-scrub.ts, this file only ever produces a toast string — so the
 * diff that changes matching semantics is worth being able to read on its own.
 */

import {
  classifyLoadError,
  messageOf,
  WASM_RUNTIME_UNRECOVERABLE_MARKER,
} from './load-errors.js';

/**
 * Produce a user-facing message for a load failure. Known failure modes get
 * actionable guidance; everything else falls back to the raw error text so we
 * never hide useful detail.
 *
 * @param fileName Optional file name to attribute the failure to.
 */
export function formatLoadError(err: unknown, fileName?: string): string {
  const kind = classifyLoadError(err);
  const subject = fileName ? `"${fileName}"` : 'the model';
  switch (kind) {
    case 'wasm_engine_load':
      return (
        `Couldn't load the 3D geometry engine — a required file failed to download. ` +
        `This usually means the app updated in the background, or a proxy/antivirus blocked it. ` +
        `Please reload the page (Ctrl/Cmd+Shift+R). If it persists, check your network or extensions.`
      );
    case 'out_of_memory':
      return (
        `Ran out of memory while processing ${subject}. ` +
        `Try closing other tabs, or load fewer/smaller models at once.`
      );
    case 'geometry_worker_crash':
      return (
        `A geometry worker stopped unexpectedly while processing ${subject}. ` +
        `This usually means the model is too large for this device's available memory. ` +
        `Try closing other tabs, or load fewer/smaller models at once.`
      );
    case 'geometry_stream_stalled':
      return (
        `Processing ${subject} stalled and was stopped. ` +
        `The model may be too large or complex for this device. ` +
        `Try closing other tabs, or load fewer/smaller models at once.`
      );
    case 'file_unreadable':
      return (
        `Couldn't read ${subject} — the file is no longer available to the browser. ` +
        `It may have been moved, renamed, deleted, or unloaded by a cloud-sync client ` +
        `(OneDrive/Dropbox/iCloud) since you picked it. Please select the file again.`
      );
    case 'wasm_runtime_crashed':
      // Two sub-cases, and the difference matters to the user: a trap taken by
      // one operation costs only that operation (the engine rebuilds itself on
      // the next one), while a trap taken while the engine was starting cannot
      // be undone without a new document. Never show the raw engine text here —
      // the reported occurrence put an internal sentence about "recreating the
      // worker process" in front of a user (#1898).
      return messageOf(err).includes(WASM_RUNTIME_UNRECOVERABLE_MARKER)
        ? (
          `The 3D geometry engine crashed and can't restart in this tab. ` +
          `Please reload the page (Ctrl/Cmd+R) — your work in other tabs is unaffected. ` +
          `If it happens again on the same model, it is likely too large for this device's memory.`
        )
        : (
          `The 3D geometry engine crashed while processing ${subject} and the operation was stopped. ` +
          `This is usually memory pressure on a large or complex model — try closing other tabs, ` +
          `or exporting/loading a smaller selection. Reload the page if it keeps happening.`
        );
    case 'cancelled':
      return `Loading ${subject} was cancelled.`;
    case 'network_unavailable':
      return (
        `Couldn't load ${subject}: the connection dropped while downloading. ` +
        `Check your network and try again. Nothing was lost, so loading the same file again is safe.`
      );
    default:
      return `Failed to load ${subject}: ${messageOf(err)}`;
  }
}
