/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer tools — open the WebGL viewer, drive it from the agent, and
 * surface live user selection back into MCP.
 *
 * Design:
 *   • `viewer_open` boots an HTTP server that serves /index.html (the
 *     WebGL viewer) and /events (an SSE stream of selection picks).
 *     It also swaps in streaming adapters on the headless backend so
 *     SDK calls (`bim.viewer.colorize`, `bim.visibility.isolate`, …)
 *     fire commands at the running viewer.
 *   • Every other tool here is a thin wrapper around the SDK so an
 *     agent can call `viewer_colorize` instead of orchestrating
 *     query → resolve refs → adapter call by hand.
 *   • `viewer_get_selection` reports what the user has clicked. The
 *     resource `ifc-lite://viewer/selection` mirrors the same data and
 *     supports `resources/subscribe` so a subscribing agent gets a
 *     `notifications/resources/updated` push every time the user picks.
 */

import { EntityNode } from '@ifc-lite/query';
import type { EntityRef } from '@ifc-lite/sdk';
import type { Tool } from './types.js';
import type { ToolContext } from '../context.js';
import type { ViewerManager } from '../viewer-manager.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

function requireViewer(ctx: ToolContext): ViewerManager {
  const viewer = ctx.viewer;
  if (!viewer) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'No viewer manager attached.' });
  return viewer;
}

function refsForGlobalIds(m: ReturnType<typeof resolveModel>, gids: string[]): EntityRef[] {
  const wanted = new Set(gids);
  const refs: EntityRef[] = [];
  for (const [, list] of m.store.entityIndex.byType) {
    for (const id of list) {
      if (refs.length >= wanted.size) break;
      const node = new EntityNode(m.store, id);
      if (wanted.has(node.globalId)) refs.push({ modelId: m.id, expressId: id });
    }
  }
  return refs;
}

function refsForExpressIds(m: ReturnType<typeof resolveModel>, eids: number[]): EntityRef[] {
  return eids.map((expressId) => ({ modelId: m.id, expressId }));
}

function resolveTargetRefs(m: ReturnType<typeof resolveModel>, input: Record<string, unknown>): EntityRef[] {
  const refs: EntityRef[] = [];
  if (Array.isArray(input.global_ids)) refs.push(...refsForGlobalIds(m, input.global_ids as string[]));
  if (Array.isArray(input.express_ids)) refs.push(...refsForExpressIds(m, input.express_ids as number[]));
  if (typeof input.global_id === 'string') refs.push(...refsForGlobalIds(m, [input.global_id]));
  if (typeof input.express_id === 'number') refs.push({ modelId: m.id, expressId: input.express_id });
  if (typeof input.type === 'string') {
    for (const e of m.bim.query().byType(input.type).toArray()) refs.push(e.ref);
  }
  return refs;
}

function parseColor(input: unknown): [number, number, number, number] {
  if (Array.isArray(input)) {
    const arr = (input as unknown[]).map(Number);
    if (arr.length === 3) return [arr[0], arr[1], arr[2], 1];
    if (arr.length === 4) return [arr[0], arr[1], arr[2], arr[3]];
  }
  if (typeof input === 'string') {
    const named: Record<string, [number, number, number, number]> = {
      red: [1, 0.2, 0.2, 1],
      orange: [1, 0.6, 0.1, 1],
      yellow: [1, 0.9, 0.1, 1],
      green: [0.2, 0.8, 0.2, 1],
      blue: [0.2, 0.4, 1, 1],
      purple: [0.6, 0.2, 0.8, 1],
      gray: [0.6, 0.6, 0.6, 1],
      white: [1, 1, 1, 1],
      black: [0, 0, 0, 1],
    };
    if (named[input.toLowerCase()]) return named[input.toLowerCase()];
    // #RRGGBB / #RGB hex
    const hex = input.replace('#', '');
    if (hex.length === 6) {
      return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 1];
    }
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16) / 255, parseInt(hex[1] + hex[1], 16) / 255, parseInt(hex[2] + hex[2], 16) / 255, 1];
    }
  }
  throw new ToolExecutionError({
    code: ToolErrorCode.INVALID_INPUT,
    message: 'color must be [r,g,b] / [r,g,b,a] (0–1), a hex string (#ff8800), or a name (red, orange, …).',
  });
}

// ── open / close / status ─────────────────────────────────────────────────

const viewerOpen: Tool = {
  name: 'viewer_open',
  description: 'Boot the in-process WebGL viewer for a model. Returns the URL to open in a browser. Idempotent for the same model.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Model to load. Defaults to the active model.' },
      port: { type: 'integer', description: 'Preferred HTTP port (0 / omit = auto).', default: 0, minimum: 0, maximum: 65535 },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const viewer = requireViewer(ctx);
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const port = (input.port as number | undefined) ?? 0;
    const state = await viewer.open(m, port);
    // Swap streaming adapters into the headless backend so subsequent
    // bim.viewer.* and bim.visibility.* calls hit this viewer instance.
    const adapters = viewer.adapters();
    if (adapters) m.backend.attachStreamingAdapters(adapters.viewer, adapters.visibility);
    ctx.log.log('info', 'viewer_open', { url: state.url, model: m.id });
    return okResult(
      `Viewer ready at ${state.url}. Open it in a browser to see '${m.name}'. Pick interactions sync back via 'ifc-lite://viewer/selection'.`,
      { ...state, instructions: `Open ${state.url} in a browser to interact with the model.` },
    );
  },
};

const viewerClose: Tool = {
  name: 'viewer_close',
  description: 'Stop the in-process viewer and clear its selection state.',
  scope: 'read',
  inputSchema: { type: 'object', additionalProperties: false },
  handler(_input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) return okResult('Viewer was already closed.', { wasOpen: false });
    // Restore no-op adapters before tearing down the manager.
    for (const m of ctx.registry.list()) m.backend.detachStreamingAdapters();
    viewer.close();
    return okResult('Viewer closed.', { wasOpen: true });
  },
};

const viewerStatus: Tool = {
  name: 'viewer_status',
  description: 'Report whether the viewer is open, on what port, and the current selection.',
  scope: 'read',
  inputSchema: { type: 'object', additionalProperties: false },
  handler(_input, ctx) {
    const viewer = requireViewer(ctx);
    const state = viewer.state();
    if (!state) return okResult('Viewer is closed.', { open: false });
    return okResult(`Viewer open at ${state.url} (${state.clientCount} client${state.clientCount === 1 ? '' : 's'} connected).`, { open: true, ...state });
  },
};

// ── visibility / paint ────────────────────────────────────────────────────

const viewerColorize: Tool = {
  name: 'viewer_colorize',
  description: 'Paint a set of entities with a color. Pass `type`, `global_ids`, or `express_ids` to pick the set; pass `color` as [r,g,b]/[r,g,b,a] (0–1), a #hex, or a named color.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      color: { description: '[r,g,b], [r,g,b,a], hex, or named color.' },
      reset_others: { type: 'boolean', default: false, description: 'When true, reset all other element colors first.' },
    },
    required: ['color'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open. Call viewer_open first.' });
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const refs = resolveTargetRefs(m, input);
    if (refs.length === 0) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'No entities matched the selector.' });
    const color = parseColor(input.color);
    if (input.reset_others) m.bim.viewer.resetColors();
    m.bim.viewer.colorizeRgba(refs, color);
    return okResult(`Painted ${refs.length} entit${refs.length === 1 ? 'y' : 'ies'}.`, { count: refs.length, color });
  },
};

const viewerIsolate: Tool = {
  name: 'viewer_isolate',
  description: 'Hide everything except the listed entities. Great for "show me only the load-bearing walls".',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const refs = resolveTargetRefs(m, input);
    if (refs.length === 0) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'No entities matched.' });
    m.bim.viewer.isolate(refs);
    return okResult(`Isolated ${refs.length} entit${refs.length === 1 ? 'y' : 'ies'}.`, { count: refs.length });
  },
};

const viewerHide: Tool = {
  name: 'viewer_hide',
  description: 'Hide a set of entities in the viewer.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const refs = resolveTargetRefs(m, input);
    m.bim.viewer.hide(refs);
    return okResult(`Hid ${refs.length} entit${refs.length === 1 ? 'y' : 'ies'}.`, { count: refs.length });
  },
};

const viewerShow: Tool = {
  name: 'viewer_show',
  description: 'Make a set of entities visible (un-hide).',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const refs = resolveTargetRefs(m, input);
    m.bim.viewer.show(refs);
    return okResult(`Showed ${refs.length} entit${refs.length === 1 ? 'y' : 'ies'}.`, { count: refs.length });
  },
};

const viewerReset: Tool = {
  name: 'viewer_reset',
  description: 'Reset visibility (show all) and clear all per-element color overrides.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' } }, additionalProperties: false },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const m = resolveModel(ctx, input.model_id as string | undefined);
    m.bim.viewer.resetVisibility();
    m.bim.viewer.resetColors();
    return okResult('Reset visibility + colors.', {});
  },
};

const viewerFlyTo: Tool = {
  name: 'viewer_fly_to',
  description: 'Animate the camera to frame the listed entities.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      global_ids: { type: 'array', items: { type: 'string' } },
      express_ids: { type: 'array', items: { type: 'integer' } },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const refs = resolveTargetRefs(m, input);
    if (refs.length === 0) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'No entities matched.' });
    m.bim.viewer.flyTo(refs);
    return okResult(`Flying to ${refs.length} entit${refs.length === 1 ? 'y' : 'ies'}.`, { count: refs.length });
  },
};

// ── section ───────────────────────────────────────────────────────────────

const viewerSetSection: Tool = {
  name: 'viewer_set_section',
  description: 'Apply a section plane to the viewer.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      axis: { type: 'string', enum: ['x', 'y', 'z'] },
      position: { type: 'number' },
      flipped: { type: 'boolean', default: false },
      enabled: { type: 'boolean', default: true },
    },
    required: ['axis', 'position'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    await viewer.sendCommand('section', {
      section: { axis: input.axis, position: input.position, flipped: input.flipped ?? false, enabled: input.enabled ?? true },
    });
    return okResult(`Section ${input.axis} = ${(input.position as number).toFixed(2)}.`, {});
  },
};

const viewerClearSection: Tool = {
  name: 'viewer_clear_section',
  description: 'Remove the active section plane.',
  scope: 'read',
  inputSchema: { type: 'object', additionalProperties: false },
  async handler(_input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    await viewer.sendCommand('clearSection');
    return okResult('Section cleared.', {});
  },
};

// ── color helpers ─────────────────────────────────────────────────────────

const viewerColorByStorey: Tool = {
  name: 'viewer_color_by_storey',
  description: 'Apply a default per-storey color overlay (built-in viewer preset).',
  scope: 'read',
  inputSchema: { type: 'object', additionalProperties: false },
  async handler(_input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    await viewer.sendCommand('colorByStorey');
    return okResult('Colored by storey.', {});
  },
};

const PALETTE: [number, number, number, number][] = [
  [0.20, 0.40, 1.00, 1], [1.00, 0.60, 0.10, 1], [0.20, 0.80, 0.20, 1],
  [0.95, 0.20, 0.30, 1], [0.60, 0.20, 0.80, 1], [0.10, 0.70, 0.70, 1],
  [0.95, 0.85, 0.10, 1], [0.50, 0.50, 0.50, 1], [0.85, 0.40, 0.65, 1],
];

const viewerColorByProperty: Tool = {
  name: 'viewer_color_by_property',
  description: 'Color a type set by the value of a property — distinct color per unique value, plus a "missing" group. Returns the legend so the agent can describe what colors mean.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      pset: { type: 'string' },
      property: { type: 'string' },
      missing_color: { description: 'Color for entities that lack the property.', default: 'gray' },
    },
    required: ['type', 'pset', 'property'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const buckets = new Map<string, EntityRef[]>();
    for (const e of m.bim.query().byType(input.type as string).toArray()) {
      const v = m.bim.property(e.ref, input.pset as string, input.property as string);
      const key = v == null ? '__missing__' : String(v);
      const list = buckets.get(key) ?? [];
      list.push(e.ref);
      buckets.set(key, list);
    }
    const legend: Array<{ value: string; count: number; color: [number, number, number, number] }> = [];
    let i = 0;
    m.bim.viewer.resetColors();
    for (const [value, refs] of buckets) {
      const color = value === '__missing__' ? parseColor(input.missing_color ?? 'gray') : PALETTE[i++ % PALETTE.length];
      m.bim.viewer.colorizeRgba(refs, color);
      legend.push({ value, count: refs.length, color });
    }
    return okResult(
      `Colored ${input.type} by ${input.pset}.${input.property} — ${legend.length} bucket(s).`,
      { legend },
    );
  },
};

// ── selection ─────────────────────────────────────────────────────────────

type IncludeKey = 'attributes' | 'properties' | 'quantities' | 'classifications' | 'materials';
const ALL_INCLUDES: readonly IncludeKey[] = ['attributes', 'properties', 'quantities', 'classifications', 'materials'];
const DEFAULT_INCLUDES: readonly IncludeKey[] = ['attributes', 'classifications', 'materials'];

/**
 * IFC EXPRESS-cased projection of an entity's identity for the viewer
 * selection payload. Keeps `expressId` as a non-IFC numeric handle (it's a
 * STEP-id concept, not an IFC EXPRESS attribute), but mirrors every IFC
 * attribute by its PascalCase EXPRESS name (`IfcType`, `GlobalId`, `Name`,
 * `Description`, `ObjectType`) so MCP clients consume the viewer payload
 * with the same casing the rest of the IFC EXPRESS surface uses. SDK-side
 * structures (attributes / properties / quantities / classifications /
 * materials) are left alone — they're cross-package types and would need
 * a wider migration; documented as the boundary here.
 */
interface ProjectedEntity {
  IfcType?: string;
  GlobalId?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
}

interface EnrichedPick {
  expressId: number;
  IfcType?: string;
  GlobalId?: string;
  entity: ProjectedEntity | null;
  attributes?: ReturnType<NonNullable<ReturnType<typeof resolveModel>>['bim']['attributes']>;
  properties?: ReturnType<NonNullable<ReturnType<typeof resolveModel>>['bim']['properties']>;
  quantities?: ReturnType<NonNullable<ReturnType<typeof resolveModel>>['bim']['quantities']>;
  classifications?: ReturnType<NonNullable<ReturnType<typeof resolveModel>>['bim']['classifications']>;
  materials?: ReturnType<NonNullable<ReturnType<typeof resolveModel>>['bim']['materials']>;
}

/** Map the SDK's camelCase entity shape to IFC EXPRESS PascalCase. */
function projectEntity(
  data: ReturnType<NonNullable<ReturnType<typeof resolveModel>>['bim']['entity']> | null | undefined,
): ProjectedEntity | null {
  if (!data) return null;
  const out: ProjectedEntity = {};
  if (data.type) out.IfcType = data.type;
  if (data.globalId) out.GlobalId = data.globalId;
  if (data.name) out.Name = data.name;
  if (data.description) out.Description = data.description;
  if (data.objectType) out.ObjectType = data.objectType;
  return out;
}

/**
 * Build the rich payload an agent needs to actually answer "what did the
 * user just click?". The structured payload always carries the full entity
 * (ref, type, name, GlobalId, description, objectType) and any sections the
 * caller asked to include. The text content mirrors that as a human-readable
 * summary so MCP clients that only forward `content[].text` to the model
 * (Claude Desktop is one) still get the substance — that's the bug-fix here:
 * before, text was just "1 selected." and the data "collapsed" out of view.
 */
function buildSelectionPayload(
  ctx: ToolContext,
  include: ReadonlyArray<IncludeKey>,
): { selection: EnrichedPick[]; modelId: string | null; text: string } {
  const viewer = requireViewer(ctx);
  const state = viewer.state();
  const raw = state?.selection ?? [];
  if (raw.length === 0) {
    return { selection: [], modelId: state?.modelId ?? null, text: 'No selection in viewer.' };
  }

  const modelId = state?.modelId ?? null;
  const m = modelId ? ctx.registry.get(modelId) : null;
  if (!m) {
    // We still know the basics from the SSE pick — return them so the
    // agent can at least name the entity even if the model unloaded.
    const lines = raw.map((s) => `• ${s.ifcType ?? '?'} #${s.expressId}` + (s.globalId ? ` (${s.globalId})` : ''));
    return {
      selection: raw.map((s) => ({ expressId: s.expressId, IfcType: s.ifcType, GlobalId: s.globalId, entity: null })),
      modelId,
      text: `${raw.length} selected (model '${modelId}' not resolvable):\n${lines.join('\n')}`,
    };
  }

  const includeSet = new Set(include);
  const enriched: EnrichedPick[] = raw.map((s) => {
    const ref = { modelId: m.id, expressId: s.expressId };
    const data = m.bim.entity(ref);
    const out: EnrichedPick = {
      expressId: s.expressId,
      IfcType: s.ifcType ?? data?.type,
      GlobalId: s.globalId ?? data?.globalId,
      entity: projectEntity(data),
    };
    if (includeSet.has('attributes')) out.attributes = m.bim.attributes(ref);
    if (includeSet.has('properties')) out.properties = m.bim.properties(ref);
    if (includeSet.has('quantities')) out.quantities = m.bim.quantities(ref);
    if (includeSet.has('classifications')) out.classifications = m.bim.classifications(ref);
    if (includeSet.has('materials')) out.materials = m.bim.materials(ref);
    return out;
  });

  // Build a rich, multi-line text summary so agents whose clients only
  // surface text content still see the substance of the pick.
  const blocks: string[] = [`${enriched.length} entity selected in viewer:`];
  for (const e of enriched) {
    const parts: string[] = [];
    parts.push(`• ${e.entity?.IfcType ?? e.IfcType ?? '?'} #${e.expressId}`);
    const name = e.entity?.Name;
    if (name) parts.push(`'${name}'`);
    if (e.GlobalId) parts.push(`GlobalId=${e.GlobalId}`);
    blocks.push(parts.join(' '));
    if (e.entity?.Description) blocks.push(`  Description: ${e.entity.Description}`);
    if (e.entity?.ObjectType) blocks.push(`  ObjectType: ${e.entity.ObjectType}`);
    if (e.attributes && e.attributes.length > 0) {
      const summary = e.attributes
        .filter((a) => a.value != null && a.value !== '')
        .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
        .join(', ');
      if (summary) blocks.push(`  Attributes: ${summary}`);
    }
    if (e.properties && e.properties.length > 0) {
      const psetSummaries = e.properties.map((p) => `${p.name} (${p.properties.length})`);
      blocks.push(`  Property sets: ${psetSummaries.join(', ')}`);
    }
    if (e.quantities && e.quantities.length > 0) {
      const qtoSummaries = e.quantities.map((q) => `${q.name} (${q.quantities.length})`);
      blocks.push(`  Quantity sets: ${qtoSummaries.join(', ')}`);
    }
    if (e.classifications && e.classifications.length > 0) {
      const c = e.classifications
        .map((cls) => `${cls.system ?? '?'}:${cls.identification ?? cls.name ?? '?'}`)
        .join(', ');
      blocks.push(`  Classifications: ${c}`);
    }
    if (e.materials) {
      const mat = e.materials as {
        layers?: Array<{ materialName?: string; name?: string }>;
        materials?: Array<{ name?: string }>;
        name?: string;
        materialName?: string;
      };
      if (Array.isArray(mat.layers) && mat.layers.length > 0) {
        blocks.push(`  Materials: ${mat.layers.map((l) => l.materialName ?? l.name ?? '?').join(', ')}`);
      } else if (Array.isArray(mat.materials) && mat.materials.length > 0) {
        blocks.push(`  Materials: ${mat.materials.map((l) => l.name ?? '?').join(', ')}`);
      } else if (mat.name ?? mat.materialName) {
        blocks.push(`  Material: ${mat.name ?? mat.materialName}`);
      }
    }
  }
  return { selection: enriched, modelId, text: blocks.join('\n') };
}

const viewerGetSelection: Tool = {
  name: 'viewer_get_selection',
  description: 'Return what the user has clicked in the viewer. Both the human-readable text content and the structured payload include type, expressId, globalId, name, description, and any of the optional sections in `include` (default: attributes + classifications + materials).',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        items: { type: 'string', enum: [...ALL_INCLUDES] },
        description: 'Sections to enrich the response with. Defaults to ["attributes","classifications","materials"]. Pass [] to skip enrichment.',
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    requireViewer(ctx);
    const include: ReadonlyArray<IncludeKey> = Array.isArray(input.include)
      ? (input.include as IncludeKey[]).filter((k) => (ALL_INCLUDES as readonly string[]).includes(k))
      : DEFAULT_INCLUDES;
    const { selection, modelId, text } = buildSelectionPayload(ctx, include);
    return okResult(text, { selection, modelId, includes: include });
  },
};

const viewerDescribeSelection: Tool = {
  name: 'viewer_describe_selection',
  description: 'Like viewer_get_selection but always pulls the full kitchen sink — attributes, properties, quantities, classifications, materials. Use this when the user asks "tell me everything about what I just clicked".',
  scope: 'read',
  inputSchema: { type: 'object', additionalProperties: false },
  handler(_input, ctx) {
    requireViewer(ctx);
    const { selection, modelId, text } = buildSelectionPayload(ctx, ALL_INCLUDES);
    return okResult(text, { selection, modelId, includes: ALL_INCLUDES });
  },
};

const viewerWaitForSelection: Tool = {
  name: 'viewer_wait_for_selection',
  description: 'Block until the user picks an entity in the viewer (or `timeout_ms` elapses). Useful for "click on the wall you want me to inspect" workflows. Returns the same rich payload as viewer_get_selection.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      timeout_ms: { type: 'integer', default: 60000, minimum: 100, maximum: 600000 },
      include: {
        type: 'array',
        items: { type: 'string', enum: [...ALL_INCLUDES] },
        description: 'Sections to enrich the response with. Defaults to ["attributes","classifications","materials"].',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const timeout = (input.timeout_ms as number | undefined) ?? 60000;
    const include: ReadonlyArray<IncludeKey> = Array.isArray(input.include)
      ? (input.include as IncludeKey[]).filter((k) => (ALL_INCLUDES as readonly string[]).includes(k))
      : DEFAULT_INCLUDES;

    return new Promise<ReturnType<typeof okResult>>((resolve) => {
      let resolved = false;
      const finish = (result: ReturnType<typeof okResult>) => {
        if (resolved) return;
        resolved = true;
        unsub();
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const unsub = viewer.onSelection((sel) => {
        if (sel.length > 0) {
          const { selection, modelId, text } = buildSelectionPayload(ctx, include);
          finish(okResult(text, { selection, modelId, includes: include }));
        }
      });
      const onAbort = () => finish(okResult('Wait cancelled.', { selection: [], cancelled: true }));
      ctx.signal.addEventListener('abort', onAbort);
      const timer = setTimeout(
        () => finish(okResult('Timed out waiting for selection.', { selection: [], timedOut: true })),
        timeout,
      );
    });
  },
};

// ── elicitation-style ask ─────────────────────────────────────────────────

const viewerAsk: Tool = {
  name: 'viewer_ask',
  description: 'Inform the user that the agent would like to open the viewer for visual context. Returns guidance for the agent. The agent is expected to relay this to the user, then call `viewer_open` once they confirm.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Short explanation, e.g. "to highlight non-compliant doors".' },
      model_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const reason = (input.reason as string | undefined) ?? 'visualize the result';
    return okResult(
      [
        `Ask the user: "I'd like to open the 3D viewer for ${m.name} ${reason}. May I?"`,
        `If they agree, call \`viewer_open\` with model_id="${m.id}". After it returns, share the URL with the user (\`http://localhost:<port>/\`) and tell them clicks in the viewer will sync back automatically.`,
      ].join(' '),
      { modelId: m.id, suggestedTool: 'viewer_open', suggestedArgs: { model_id: m.id } },
    );
  },
};

export const viewerTools: Tool[] = [
  viewerOpen,
  viewerClose,
  viewerStatus,
  viewerColorize,
  viewerIsolate,
  viewerHide,
  viewerShow,
  viewerReset,
  viewerFlyTo,
  viewerSetSection,
  viewerClearSection,
  viewerColorByStorey,
  viewerColorByProperty,
  viewerGetSelection,
  viewerDescribeSelection,
  viewerWaitForSelection,
  viewerAsk,
];
