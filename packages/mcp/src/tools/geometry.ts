/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry tools (spec §7.3).
 *
 * v0.1 strategy: serve the cheap, accurate values that come straight off
 * IfcElementQuantity (volume, area), and surface a UNSUPPORTED_OPERATION
 * with a useful hint for tools that need WASM-driven mesh tessellation
 * (geometry_get, raycast, clash_check). When `@ifc-lite/wasm` lands in the
 * MCP container we wire it in here without changing the tool surface.
 */

import { EntityNode } from '@ifc-lite/query';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

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
  description: 'Mesh data (positions, indices, normals) for an entity selection. Requires the WASM geometry pipeline; returns UNSUPPORTED_OPERATION when the server runs without it.',
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
  handler() {
    // The geometry tessellation pipeline lives in @ifc-lite/wasm and is
    // browser-shaped today. v0.1 surfaces a clear refusal so agents can
    // pick a different path (geometry_bbox / geometry_volume).
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'geometry_get requires the WASM geometry pipeline, which is not loaded in this MCP build.',
      hint: 'Use geometry_bbox / geometry_volume / geometry_area for quantity-based answers, or run the server with the geometry profile (planned for v0.2).',
    });
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
  description: 'Cast a world-space ray against the model. Requires the WASM geometry pipeline.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      origin: { type: 'array', items: { type: 'number' } },
      direction: { type: 'array', items: { type: 'number' } },
    },
    required: ['origin', 'direction'],
    additionalProperties: false,
  },
  handler() {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'raycast requires the WASM geometry pipeline (planned for v0.2).',
    });
  },
};

const clashCheck: Tool = {
  name: 'clash_check',
  description: 'Pairwise clash detection on element selections. Requires the WASM geometry pipeline.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      a: { type: 'array', items: { type: 'string' }, description: 'GlobalIds for set A.' },
      b: { type: 'array', items: { type: 'string' }, description: 'GlobalIds for set B.' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  handler() {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'clash_check requires the WASM geometry pipeline (planned for v0.2).',
    });
  },
};

export const geometryTools: Tool[] = [
  geometryGet,
  geometryBbox,
  geometryVolume,
  geometryArea,
  raycast,
  clashCheck,
];
