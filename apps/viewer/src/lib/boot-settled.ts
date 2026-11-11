/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Idle boot work still pending before the first file (a warm-up). Exposed as
 * `globalThis.__ifc_lite_boot_settled__()` so the load scoreboard arms an open
 * the way a user picks a file: after the page has finished preparing, not merely
 * once its main thread is quiet (scripts/perf/viewer-load-boot.mjs).
 */

const pending = new Set<string>();

(globalThis as { __ifc_lite_boot_settled__?: () => boolean }).__ifc_lite_boot_settled__ = () => pending.size === 0;

/** Mark `name` pending; the returned function settles it (idempotent). */
export function holdBootSettled(name: string): () => void {
  pending.add(name);
  return () => { pending.delete(name); };
}
