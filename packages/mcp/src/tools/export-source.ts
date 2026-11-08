/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isNoRenderGeometryError } from '@ifc-lite/geometry';
import { readFile } from 'node:fs/promises';
import { resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

/**
 * Run `fn` over the current model's IFC bytes for the wasm exporters: bake
 * pending edits through the same STEP exporter as export_ifc, otherwise prefer
 * the in-memory source and fall back to disk.
 *
 * Scoped rather than returning the buffer (#2183): each Rust exporter below
 * takes the WHOLE file, so the source really is materialised — but only for the
 * duration of one export, so the buffer never outlives the tool call.
 */
export async function withIfcBytes<T>(
  m: ReturnType<typeof resolveModel>,
  fn: (bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  if (m.backend.getMutationView()?.hasPendingChanges()) {
    const content = m.bim.export.ifc(undefined, { includeMutations: true });
    return fn(typeof content === 'string' ? new TextEncoder().encode(content) : content);
  }
  if (m.store.source.byteLength > 0) return m.store.source.withMaterializedAsync(fn);
  if (m.filePath) return fn(await readFile(m.filePath));
  throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message: 'Model has no in-memory source bytes and no file path to re-read for export.',
  });
}


/**
 * Run a render-geometry export. The Rust boundary's `NO_RENDER_GEOMETRY`
 * refusal (#7695) and, as defense-in-depth, an artifact whose `count` is 0
 * become a tool error carrying `emptyMessage`: a zero-mesh file is never
 * written and reported as success. Other failures propagate unchanged.
 */
export async function refusingEmpty<T>(
  run: () => T | Promise<T>,
  count: ((artifact: NonNullable<T>) => number) | null,
  emptyMessage: string,
): Promise<T> {
  const empty = () => new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: emptyMessage });
  let out: T;
  try {
    out = await run();
  } catch (err) {
    throw isNoRenderGeometryError(err) ? empty() : err;
  }
  if (out != null && count && count(out) === 0) throw empty();
  return out;
}

