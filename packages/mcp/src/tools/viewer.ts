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

const viewerGetSelection: Tool = {
  name: 'viewer_get_selection',
  description: 'Return what the user has clicked in the viewer right now. Optionally include full entity data for each picked element.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        items: { type: 'string', enum: ['attributes', 'properties', 'quantities', 'classifications', 'materials'] },
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const viewer = requireViewer(ctx);
    const state = viewer.state();
    const selection = state?.selection ?? [];
    const include = new Set((input.include as string[] | undefined) ?? []);
    if (selection.length === 0) return okResult('No selection in viewer.', { selection: [] });
    if (include.size === 0) return okResult(`${selection.length} selected.`, { selection });

    const m = state?.modelId ? ctx.registry.get(state.modelId) : null;
    if (!m) return okResult(`${selection.length} selected (model not resolvable).`, { selection });

    const enriched = selection.map((s) => {
      const ref = { modelId: m.id, expressId: s.expressId };
      const data = m.bim.entity(ref);
      const out: Record<string, unknown> = { ...s, entity: data };
      if (include.has('attributes') && data) out.attributes = m.bim.attributes(ref);
      if (include.has('properties') && data) out.properties = m.bim.properties(ref);
      if (include.has('quantities') && data) out.quantities = m.bim.quantities(ref);
      if (include.has('classifications') && data) out.classifications = m.bim.classifications(ref);
      if (include.has('materials') && data) out.materials = m.bim.materials(ref);
      return out;
    });
    return okResult(`${selection.length} selected.`, { selection: enriched });
  },
};

const viewerWaitForSelection: Tool = {
  name: 'viewer_wait_for_selection',
  description: 'Block until the user picks an entity in the viewer (or `timeout_ms` elapses). Useful for "click on the wall you want me to inspect" workflows.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      timeout_ms: { type: 'integer', default: 60000, minimum: 100, maximum: 600000 },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const viewer = requireViewer(ctx);
    if (!viewer.isOpen()) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Viewer is not open.' });
    const timeout = (input.timeout_ms as number | undefined) ?? 60000;

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
        if (sel.length > 0) finish(okResult(`User picked entity #${sel[0].expressId}.`, { selection: sel }));
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
  viewerWaitForSelection,
  viewerAsk,
];
