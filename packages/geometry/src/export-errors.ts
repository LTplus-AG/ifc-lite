/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Typed export-failure contract mirrored from the Rust `ExportError` enum
 * (rust/export/src/error.rs). The wasm boundary throws an `Error` whose
 * message starts with the stable machine-readable code, so callers match on
 * the code instead of parsing prose.
 */

/** The export's visible mesh set was empty: the model has no render geometry,
 * or the caller's visibility filters removed all of it. Thrown instead of
 * returning a structurally valid but empty artifact (fail-closed). */
export const NO_RENDER_GEOMETRY = 'NO_RENDER_GEOMETRY';

/** True when `error` is the typed fail-closed "no render geometry" export
 * error thrown by the wasm boundary (e.g. `exportGlb` on a geometry-less or
 * fully filtered-out model). */
export function isNoRenderGeometryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === NO_RENDER_GEOMETRY ||
      error.message.startsWith(`${NO_RENDER_GEOMETRY}:`))
  );
}
