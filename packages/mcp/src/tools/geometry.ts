/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry tools (spec §7.3).
 *
 * Two tiers:
 *   - Quantity-derived, no meshing: geometry_bbox / geometry_volume /
 *     geometry_area read straight off IfcElementQuantity — cheap and exact when
 *     the model authored quantities.
 *   - Mesh-derived, headless tessellation: geometry_get and raycast tessellate
 *     the model once via @ifc-lite/geometry (shared cache in mesh.ts, same
 *     tessellation clash uses) and answer from real triangles. This runs in the
 *     MCP server's Node process — @ifc-lite/geometry loads its WASM off disk
 *     headlessly, so these no longer fall back to bounding boxes.
 *
 * Mesh-frame note: tessellated positions live in the viewer's Y-up frame with a
 * possible large-coordinate origin shift. geometry_get returns that frame and
 * echoes `coordinateInfo`; raycast operates in the SAME frame so the two compose.
 */

import { EntityNode } from '@ifc-lite/query';
import { GLTFExporter } from '@ifc-lite/export';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { meshModel } from './mesh.js';
import { castRay } from './raycast.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

/** Total vertices returned across a geometry_get(json) selection before capping. */
const GEOMETRY_VERTEX_CAP = 200_000;

interface IdInput {
  model_id?: string;
  global_id?: string;
  express_id?: number;
}

function resolveExpressIds(m: ReturnType<typeof resolveModel>, input: Record<string, unknown>): number[] {
  const ids: number[] = [];
  if (Array.isArray(input.express_ids)) ids.push(...(input.express_ids as number[]));
  if (typeof input.express_id === 'number') ids.push(input.express_id);
  if (typeof input.global_id === 'string') {
    const gid = input.global_id;
    for (const [, list] of m.store.entityIndex.byType) {
      for (const id of list) {
        const node = new EntityNode(m.store, id);
        if (node.globalId === gid) ids.push(id);
      }
    }
  }
  if (Array.isArray(input.global_ids)) {
    const set = new Set(input.global_ids as string[]);
    for (const [, list] of m.store.entityIndex.byType) {
      for (const id of list) {
        const node = new EntityNode(m.store, id);
        if (set.has(node.globalId)) ids.push(id);
      }
    }
  }
  return ids;
}

const geometryGet: Tool = {
  name: 'geometry_get',
  description:
    'Tessellated mesh for an entity selection, meshed headlessly. format="json" (default) returns raw '
    + 'positions/normals/indices arrays (capped by vertex budget); format="gltf" returns a base64 GLB of the '
    + 'selection. Positions are in the model tessellation frame (see coordinateInfo). Requires explicit geometry.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
      format: { type: 'string', enum: ['json', 'gltf'], default: 'json' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const ids = resolveExpressIds(m, input);
    if (ids.length === 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'Provide an entity selector (global_id(s) or express_id(s)).',
      });
    }
    const idSet = new Set(ids);
    const result = await meshModel(m, ctx);
    const selected = result.meshes.filter((mesh) => idSet.has(mesh.expressId));
    if (selected.length === 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.UNSUPPORTED_OPERATION,
        message: `None of the ${ids.length} requested entit${ids.length === 1 ? 'y has' : 'ies have'} tessellated geometry.`,
        hint: 'They may be quantity-only or non-geometric; try geometry_volume / geometry_area / geometry_bbox.',
      });
    }

    const format = (input.format as string | undefined) ?? 'json';

    if (format === 'gltf') {
      const isolated = new Set(selected.map((s) => s.expressId));
      const glb = new GLTFExporter(result).exportGLB({ visibleOnly: true, isolatedEntityIds: isolated });
      return okResult(
        `GLB for ${selected.length} entit${selected.length === 1 ? 'y' : 'ies'} (${glb.byteLength.toLocaleString()} bytes, base64).`,
        {
          format: 'gltf',
          entityCount: selected.length,
          byteLength: glb.byteLength,
          glbBase64: Buffer.from(glb).toString('base64'),
        },
      );
    }

    const entities: Array<Record<string, unknown>> = [];
    let vertexBudget = GEOMETRY_VERTEX_CAP;
    let omitted = 0;
    for (const mesh of selected) {
      const vertexCount = mesh.positions.length / 3;
      if (vertexBudget - vertexCount < 0) { omitted++; continue; }
      vertexBudget -= vertexCount;
      entities.push({
        expressId: mesh.expressId,
        ifcType: mesh.ifcType ?? null,
        vertexCount,
        triangleCount: mesh.indices.length / 3,
        positions: Array.from(mesh.positions),
        normals: Array.from(mesh.normals),
        indices: Array.from(mesh.indices),
      });
    }
    const note = omitted > 0
      ? ` ${omitted} entit${omitted === 1 ? 'y' : 'ies'} omitted to stay under the ${GEOMETRY_VERTEX_CAP.toLocaleString()}-vertex cap — request fewer, or use format="gltf".`
      : '';
    return okResult(
      `Tessellated ${entities.length}/${selected.length} requested entit${selected.length === 1 ? 'y' : 'ies'}.${note}`,
      {
        format: 'json',
        entities,
        omitted,
        coordinateInfo: result.coordinateInfo,
      },
    );
  },
};

const geometryBbox: Tool = {
  name: 'geometry_bbox',
  description: 'Axis-aligned bounding box for one or many entities, computed from IfcElementQuantity values when available.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const ids = resolveExpressIds(m, input);
    if (ids.length === 0) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide an entity selector.' });
    }
    const boxes: Array<{ expressId: number; bbox: { width?: number; height?: number; length?: number } | null }> = [];
    for (const id of ids) {
      const node = new EntityNode(m.store, id);
      const qsets = node.quantities();
      let length: number | undefined;
      let width: number | undefined;
      let height: number | undefined;
      for (const qset of qsets) {
        for (const q of qset.quantities) {
          if (q.name === 'Length' || q.name === 'GrossLength') length = q.value;
          else if (q.name === 'Width' || q.name === 'GrossWidth') width = q.value;
          else if (q.name === 'Height' || q.name === 'GrossHeight') height = q.value;
        }
      }
      const bbox = (length || width || height)
        ? { length: length ?? null, width: width ?? null, height: height ?? null }
        : null;
      boxes.push({ expressId: id, bbox: bbox as { width?: number; height?: number; length?: number } | null });
    }
    const withData = boxes.filter((b) => b.bbox).length;
    return okResult(
      `Read ${withData}/${boxes.length} bounding boxes from quantity sets.`,
      { boxes, missing: boxes.length - withData },
    );
  },
};

const geometryVolume: Tool = {
  name: 'geometry_volume',
  description: 'Element volume (m³) read from IfcElementQuantity. Returns null per entity when no quantity is present.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const ids = resolveExpressIds(m, input);
    const results: Array<{ expressId: number; volume: number | null }> = [];
    let total = 0;
    let counted = 0;
    for (const id of ids) {
      const node = new EntityNode(m.store, id);
      const qsets = node.quantities();
      let volume: number | null = null;
      outer: for (const qset of qsets) {
        for (const q of qset.quantities) {
          if (/Volume$/i.test(q.name)) { volume = q.value; break outer; }
        }
      }
      if (volume != null) { total += volume; counted++; }
      results.push({ expressId: id, volume });
    }
    return okResult(
      `${counted}/${results.length} entities reported a volume; total = ${total.toFixed(3)} m³.`,
      { total, counted, results },
    );
  },
};

const geometryArea: Tool = {
  name: 'geometry_area',
  description: 'Element surface area (m²) read from IfcElementQuantity.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const ids = resolveExpressIds(m, input);
    const results: Array<{ expressId: number; area: number | null }> = [];
    let total = 0;
    let counted = 0;
    for (const id of ids) {
      const node = new EntityNode(m.store, id);
      const qsets = node.quantities();
      let area: number | null = null;
      outer: for (const qset of qsets) {
        for (const q of qset.quantities) {
          if (/(GrossSideArea|GrossArea|NetArea|Area)$/i.test(q.name)) { area = q.value; break outer; }
        }
      }
      if (area != null) { total += area; counted++; }
      results.push({ expressId: id, area });
    }
    return okResult(
      `${counted}/${results.length} entities reported an area; total = ${total.toFixed(3)} m².`,
      { total, counted, results },
    );
  },
};

const raycast: Tool = {
  name: 'raycast',
  description:
    'Cast a ray against the tessellated model and return the nearest entity hit (expressId, ifcType, '
    + 'distance, point) or null. Origin/direction are in the model tessellation frame — the same frame '
    + 'geometry_get returns (Y-up, see its coordinateInfo), so the two compose. Direction need not be unit length.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      origin: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    },
    required: ['origin', 'direction'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const origin = input.origin as number[] | undefined;
    const direction = input.direction as number[] | undefined;
    if (!origin || origin.length !== 3 || !direction || direction.length !== 3) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'origin and direction must each be 3-number arrays [x, y, z].',
      });
    }
    if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'direction must be non-zero.' });
    }

    const result = await meshModel(m, ctx);
    const hit = castRay(
      result.meshes,
      [origin[0], origin[1], origin[2]],
      [direction[0], direction[1], direction[2]],
    );

    if (!hit) {
      return okResult('Ray missed all geometry.', { hit: false, coordinateInfo: result.coordinateInfo });
    }
    const node = new EntityNode(m.store, hit.expressId);
    return okResult(
      `Hit ${hit.ifcType ?? 'entity'} #${hit.expressId} at distance ${hit.distance.toFixed(3)}.`,
      {
        hit: true,
        expressId: hit.expressId,
        globalId: node.globalId || null,
        ifcType: hit.ifcType,
        name: node.name || null,
        distance: hit.distance,
        point: hit.point,
        coordinateInfo: result.coordinateInfo,
      },
    );
  },
};

export const geometryTools: Tool[] = [
  geometryGet,
  geometryBbox,
  geometryVolume,
  geometryArea,
  raycast,
];
