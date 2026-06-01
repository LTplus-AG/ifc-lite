/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared headless meshing for the geometry-backed tools (clash, geometry_get,
 * raycast).
 *
 * The whole model is tessellated once by `@ifc-lite/geometry`'s
 * `GeometryProcessor` (no DOM — this runs in the MCP server's Node process) and
 * the full `GeometryResult` is cached by model id, so clash runs, mesh fetches,
 * and ray casts on the same model never re-pay the (expensive) tessellation.
 *
 * Headless tessellation works because `@ifc-lite/geometry` loads the WASM binary
 * off disk in a Node runtime; before that fix every geometry tool here failed at
 * init and callers silently fell back to quantity-derived bounding boxes.
 */

import { readFile } from 'node:fs/promises';
import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { LoadedModel, ToolContext } from '../context.js';

/** Module-level cache, keyed by model id, of the full tessellation result. */
const geometryCache = new Map<string, GeometryResult>();

/** Tessellate the whole model once (headless, no DOM) and cache by model id. */
export async function meshModel(m: LoadedModel, ctx: ToolContext): Promise<GeometryResult> {
  const cached = geometryCache.get(m.id);
  if (cached) return cached;

  const bytes = await resolveIfcBytes(m);
  ctx.progress.report(0.1, 'Tessellating model geometry', 1);
  const gp = new GeometryProcessor();
  await gp.init();
  if (ctx.signal.aborted) {
    throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'Geometry run cancelled before meshing.' });
  }
  const result = await gp.process(bytes);
  if (result.meshes.length === 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'No mesh geometry could be produced for this model; it carries no tessellated solids.',
      hint: 'Confirm the model has explicit geometry (not quantity-only data).',
    });
  }
  geometryCache.set(m.id, result);
  return result;
}

/** Convenience: just the meshes from the cached tessellation. */
export async function meshesFor(m: LoadedModel, ctx: ToolContext): Promise<MeshData[]> {
  return (await meshModel(m, ctx)).meshes;
}

/** Raw IFC bytes for meshing: prefer the in-memory source, fall back to disk. */
export async function resolveIfcBytes(m: LoadedModel): Promise<Uint8Array> {
  if (m.store.source && m.store.source.byteLength > 0) return m.store.source;
  if (m.filePath) return readFile(m.filePath);
  throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message: 'Model has no in-memory source bytes and no file path to re-read for meshing.',
  });
}
