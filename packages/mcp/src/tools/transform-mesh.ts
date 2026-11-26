/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry transforms over the model's IFC bytes (pending edits baked in by
 * `withIfcBytes`): `model_simplify` (DemeshSession, as `ifc-lite simplify`)
 * and `model_lod` (`generateLod0` / `generateLod1`, as `ifc-lite lod`).
 */

import { writeFile } from 'node:fs/promises';
import { countGlbMeshes, DemeshSession, generateLod0, generateLod1 } from '@ifc-lite/export';
import type { Tool } from './types.js';
import { fmtInt, okResult } from './util.js';
import { refusingEmpty, withIfcBytes } from './export-source.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import { FILE_WRITE_ANNOTATIONS, fileOutputSchema, invalid, optionalOutputPath, refuseSourceIdsWhilePending, requireDistinctPaths, resolveStepModel, beforeWrite, unsupported, writeSidecar } from './transform-schema.js';

const modelSimplify: Tool = {
  name: 'model_simplify',
  title: 'Simplify element geometry',
  description:
    'Simplify, decimate or lighten element meshes and write an IFC where each simplified element\'s body becomes an IfcTriangulatedFaceSet. Levels 1-4 drop enclosed cavities and keep 50/25/10/3% of the triangles; level 5 replaces each element with its bounding box. IFC2X3 input is upconverted to IFC4.',
  scope: 'export',
  annotations: FILE_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Source model; optional when one model is loaded.' },
      file_path: { type: 'string', description: 'Output .ifc path, inside the allowed paths.' },
      level: { type: 'integer', minimum: 1, maximum: 5, description: 'Simplification level (default 1).' },
      express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, description: 'Elements to simplify. Default: every element with geometry.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  outputSchema: fileOutputSchema({
    level: { type: 'integer' },
    simplified: { type: 'integer', description: 'Meshes the mesh pass simplified.' },
    replaced: { type: 'integer', description: 'Representations replaced in the written IFC.' },
    skipped: { type: 'integer' },
    exportSkipped: { type: 'integer' },
    trianglesBefore: { type: 'integer' },
    trianglesAfter: { type: 'integer' },
    bytesBefore: { type: 'integer' },
    upconverted: { type: 'boolean' },
  }),
  async handler(input, ctx) {
    const m = resolveStepModel(ctx, input.model_id as string | undefined, 'model_simplify');
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const level = (input.level as number | undefined) ?? 1;
    if (input.express_ids !== undefined) refuseSourceIdsWhilePending(m, 'express_ids');
    return withIfcBytes(m, async (bytes) => {
      const session = new DemeshSession(bytes);
      try {
        const ids = (input.express_ids as number[] | undefined)
          ?? (await session.heaviest(Number.MAX_SAFE_INTEGER)).map((e) => e.expressId);
        if (ids.length === 0) throw unsupported('The model produced no element meshes to simplify.');
        const simplified = await session.simplify(ids, level);
        if (simplified.elements.length === 0) {
          throw unsupported(`No elements could be simplified (${simplified.skipped.length} skipped).`);
        }
        const exported = await session.exportIfc();
        // The export report is the authority on what the file contains; with
        // nothing replaced there is no lighter file to write.
        const replaced = exported.report.replaced.length;
        if (replaced === 0) {
          throw new ToolExecutionError({
            code: ToolErrorCode.INTERNAL_ERROR,
            message: `Simplified ${simplified.elements.length} meshes, but none could be applied to the IFC (${exported.report.skipped.length} skipped at export). Nothing written.`,
          });
        }
        beforeWrite(ctx, m);
        await writeFile(filePath, exported.bytes);
        const trianglesBefore = simplified.elements.reduce((s, e) => s + e.trisBefore, 0);
        const trianglesAfter = simplified.elements.reduce((s, e) => s + e.trisAfter, 0);
        return okResult(
          `Simplified ${simplified.elements.length} meshes at level ${level}, replaced ${replaced} representations. ` +
            `Triangles ${fmtInt(trianglesBefore)} -> ${fmtInt(trianglesAfter)}, bytes ${fmtInt(exported.bytesBefore)} -> ${fmtInt(exported.bytesAfter)}. Wrote ${filePath}.`,
          {
            filePath,
            bytes: exported.bytesAfter,
            level,
            simplified: simplified.elements.length,
            replaced,
            skipped: simplified.skipped.length,
            exportSkipped: exported.report.skipped.length,
            trianglesBefore,
            trianglesAfter,
            bytesBefore: exported.bytesBefore,
            upconverted: exported.upconverted,
          },
        );
      } finally {
        session.destroy();
      }
    });
  },
};

const modelLod: Tool = {
  name: 'model_lod',
  title: 'Generate LOD artifact',
  description:
    'Generate a lightweight level-of-detail artifact. Level 0 writes JSON with one world transform and bounding box per element; level 1 writes a GLB of simplified element shells, plus optional metadata JSON mapping express ids to GLB nodes.',
  scope: 'export',
  annotations: FILE_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Source model; optional when one model is loaded.' },
      level: { type: 'integer', enum: [0, 1], description: 'LOD level.' },
      file_path: { type: 'string', description: 'Output path: .json for level 0, .glb for level 1.' },
      meta_path: { type: 'string', description: 'Level 1 only: also write the metadata JSON here.' },
    },
    required: ['level', 'file_path'],
    additionalProperties: false,
  },
  outputSchema: fileOutputSchema({
    level: { type: 'integer' },
    elementCount: { type: 'integer', description: 'Level 0: elements in the JSON.' },
    status: { type: 'string', enum: ['ok', 'degraded'], description: 'Level 1: degraded when some elements fell back to boxes.' },
    failedElements: { type: 'integer', description: 'Level 1: elements that failed to mesh.' },
    metaPath: { type: ['string', 'null'] },
  }),
  async handler(input, ctx) {
    const m = resolveStepModel(ctx, input.model_id as string | undefined, 'model_lod');
    const level = input.level as 0 | 1;
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    if (level === 0 && input.meta_path != null) throw invalid('meta_path applies to level 1 only.');
    const metaPath = await optionalOutputPath(input, 'meta_path', ctx);
    requireDistinctPaths(filePath, metaPath, 'meta_path');
    return withIfcBytes(m, async (bytes) => {
      if (level === 0) {
        const lod0 = await refusingEmpty(() => generateLod0(bytes), (r) => r.elements.length, 'LOD0 produced no elements: the model has no exportable geometry.');
        const json = Buffer.from(JSON.stringify(lod0, null, 2));
        beforeWrite(ctx, m);
        await writeFile(filePath, json);
        return okResult(
          `Wrote LOD0 for ${fmtInt(lod0.elements.length)} elements to ${filePath}.`,
          { filePath, bytes: json.length, level, elementCount: lod0.elements.length, metaPath: null },
        );
      }
      const { glb, meta } = await refusingEmpty(() => generateLod1(bytes), (r) => countGlbMeshes(r.glb), 'LOD1 produced no meshes: the model has no exportable geometry.');
      beforeWrite(ctx, m);
      // One after the other: a failed meta write must not race a GLB still landing.
      await writeFile(filePath, glb);
      if (metaPath) await writeSidecar(filePath, metaPath, JSON.stringify(meta, null, 2));
      return okResult(
        `Wrote LOD1 GLB (${meta.status}, ${meta.failedElements.length} failed elements) to ${filePath}.`,
        { filePath, bytes: glb.length, level, status: meta.status, failedElements: meta.failedElements.length, metaPath },
      );
    });
  },
};

export const meshTransformTools: Tool[] = [modelSimplify, modelLod];
