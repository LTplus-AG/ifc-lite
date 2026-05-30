/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash detection tools (spec section 7.3).
 *
 * These wire the headless geometry pipeline (@ifc-lite/geometry) to the
 * representation-agnostic clash engine (@ifc-lite/clash). The whole model is
 * meshed once and cached by model id; the engine's rule SELECTORS (TYPE-based,
 * e.g. `IfcDuct*|IfcPipe*`) pick the element groups for each run.
 *
 *   - clash_check   one ad-hoc rule between two selectors.
 *   - clash_matrix  the standard discipline matrix (MEP x STR, HVAC x ARCH, ...).
 *
 * Clash lists are always capped for display; the cap and the dropped count are
 * stated explicitly so output never silently truncates.
 */

import { readFile } from 'node:fs/promises';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import {
  createClashEngine,
  disciplineMatrixRules,
  type Clash,
  type ClashMode,
  type ClashResult,
  type ClashRule,
} from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { LoadedModel, ToolContext } from '../context.js';

/** Cap on clashes returned in a tool result. The dropped count is reported. */
const CLASH_DISPLAY_CAP = 50;

/**
 * Module-level mesh cache, keyed by model id, so repeated clash calls on the
 * same model don't re-run the (expensive) headless tessellation.
 */
const meshCache = new Map<string, MeshData[]>();

/** Mesh the whole model once (headless, no DOM) and cache by model id. */
async function meshModel(m: LoadedModel, ctx: ToolContext): Promise<MeshData[]> {
  const cached = meshCache.get(m.id);
  if (cached) return cached;

  const bytes = await resolveIfcBytes(m);
  ctx.progress.report(0.1, 'Tessellating model geometry', 1);
  const gp = new GeometryProcessor();
  await gp.init();
  if (ctx.signal.aborted) {
    throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'Clash run cancelled before meshing.' });
  }
  const result = await gp.process(bytes);
  const meshes = result.meshes;
  if (meshes.length === 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'No mesh geometry could be produced for this model; clash detection needs tessellated solids.',
      hint: 'Confirm the model carries explicit geometry (not quantity-only data).',
    });
  }
  meshCache.set(m.id, meshes);
  return meshes;
}

/** Raw IFC bytes for meshing: prefer the in-memory source, fall back to disk. */
async function resolveIfcBytes(m: LoadedModel): Promise<Uint8Array> {
  if (m.store.source && m.store.source.byteLength > 0) return m.store.source;
  if (m.filePath) return readFile(m.filePath);
  throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message: 'Model has no in-memory source bytes and no file path to re-read for meshing.',
  });
}

/** Run a rule set against a model, returning the engine result. */
async function runRules(m: LoadedModel, rules: ClashRule[], ctx: ToolContext): Promise<ClashResult> {
  const meshes = await meshModel(m, ctx);
  const { elements, exclusions } = elementsFromStep({ store: m.store, meshes, modelId: m.id });
  const engine = createClashEngine({ backend: 'ts' });
  return engine.run(elements, rules, {
    exclusions,
    signal: ctx.signal,
    onProgress: (p) => {
      const ratio = p.total > 0 ? p.done / p.total : 0;
      ctx.progress.report(0.2 + ratio * 0.8, `Clash ${p.phase}: ${p.rule} (${p.done}/${p.total})`, 1);
    },
  });
}

/** Project a `Clash` down to a compact, JSON-friendly display row. */
function displayClash(c: Clash): Record<string, unknown> {
  return {
    id: c.id,
    rule: c.rule,
    status: c.status,
    severity: c.severity,
    distance: c.distance,
    point: c.point,
    a: { key: c.a.key, ref: c.a.ref, tag: c.a.tag, name: c.a.name },
    b: { key: c.b.key, ref: c.b.ref, tag: c.b.tag, name: c.b.name },
  };
}

/**
 * Top clashes by |distance| (deepest penetration / smallest gap first), capped
 * for display. Returns the rows plus an explicit `truncated` note when capped.
 */
function topClashes(clashes: Clash[], cap: number): {
  rows: Record<string, unknown>[];
  truncated: { shown: number; dropped: number; total: number } | null;
} {
  const sorted = [...clashes].sort((x, y) => Math.abs(x.distance) - Math.abs(y.distance));
  const shown = sorted.slice(0, cap);
  const rows = shown.map(displayClash);
  if (sorted.length > cap) {
    return { rows, truncated: { shown: shown.length, dropped: sorted.length - shown.length, total: sorted.length } };
  }
  return { rows, truncated: null };
}

const clashCheck: Tool = {
  name: 'clash_check',
  description:
    'Pairwise clash detection between two TYPE-based selectors (e.g. a="IfcDuct*|IfcPipe*", b="IfcWall*"). '
    + 'Meshes the model headlessly, runs one rule, and returns a summary plus the top clashes by |distance|.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      a: { type: 'string', description: 'Type selector for set A, e.g. "IfcDuct*|IfcPipe*", "!IfcSpace", "*".' },
      b: { type: 'string', description: 'Type selector for set B.' },
      mode: { type: 'string', enum: ['hard', 'clearance'], default: 'hard' },
      tolerance: { type: 'number', description: 'Touching band (m). Defaults to the engine tolerance.' },
      clearance: { type: 'number', description: 'Required gap (m) for mode="clearance".' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const a = input.a as string;
    const b = input.b as string;
    const mode = (input.mode as ClashMode | undefined) ?? 'hard';
    const tolerance = input.tolerance as number | undefined;
    const clearance = input.clearance as number | undefined;

    const rule: ClashRule = {
      id: 'clash_check',
      name: `${a} vs ${b}`,
      a,
      b,
      mode,
      ...(tolerance != null ? { tolerance } : {}),
      ...(clearance != null ? { clearance } : {}),
    };

    const result = await runRules(m, [rule], ctx);
    const { rows, truncated } = topClashes(result.clashes, CLASH_DISPLAY_CAP);

    const settings = { a, b, mode, tolerance: tolerance ?? null, clearance: clearance ?? null };
    const capNote = truncated
      ? ` Showing top ${truncated.shown} by |distance|; ${truncated.dropped} more not shown.`
      : '';
    return okResult(
      `Found ${result.summary.total} clash(es) for ${a} vs ${b} (mode=${mode}).${capNote}`,
      {
        summary: result.summary,
        settings,
        engineSettings: result.settings,
        truncated: result.truncated ?? null,
        clashes: rows,
        clashesTruncated: truncated,
      },
    );
  },
};

const clashMatrix: Tool = {
  name: 'clash_matrix',
  description:
    'Run the standard discipline clash matrix (MEP x STR, HVAC x ARCH, ...) over the whole model. '
    + 'Returns per-rule and per-severity breakdowns plus a sample of the worst clashes.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      mode: { type: 'string', enum: ['hard', 'clearance'], default: 'hard' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const mode = (input.mode as ClashMode | undefined) ?? 'hard';
    const rules = disciplineMatrixRules(mode);

    const result = await runRules(m, rules, ctx);
    const { rows, truncated } = topClashes(result.clashes, CLASH_DISPLAY_CAP);

    const capNote = truncated
      ? ` Sampling top ${truncated.shown} by |distance|; ${truncated.dropped} more not shown.`
      : '';
    return okResult(
      `Discipline matrix (mode=${mode}, ${rules.length} rules): ${result.summary.total} clash(es).${capNote}`,
      {
        mode,
        ruleCount: rules.length,
        byRule: result.summary.byRule,
        bySeverity: result.summary.bySeverity,
        byTypePair: result.summary.byTypePair,
        summary: result.summary,
        engineSettings: result.settings,
        truncated: result.truncated ?? null,
        sampleClashes: rows,
        sampleTruncated: truncated,
      },
    );
  },
};

export const clashTools: Tool[] = [clashCheck, clashMatrix];
