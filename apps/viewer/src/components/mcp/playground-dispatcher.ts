/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * playground-dispatcher.ts — client-side execution surface for the MCP
 * tool catalogue.
 *
 * The web playground talks to Anthropic with the same tool definitions the
 * stdio MCP server advertises. When Claude emits a `tool_use` block we run
 * it through `dispatch()` here, which:
 *
 *   1. Resolves the tool name to an SDK call against the loaded model's
 *      `BimContext` (built on top of `HeadlessLikeBackend`, the same
 *      backend the Node MCP server uses — so behaviour matches).
 *   2. Catches `ToolExecutionError`s and converts them to MCP-shaped
 *      `tool_result` payloads with `is_error: true` + a stable error code.
 *   3. Emits a structured payload that is small enough to round-trip back
 *      into Claude’s context without blowing the message budget.
 *
 * Coverage: read + mutate + BCF + IDS + export are all wired. Disk I/O
 * (model_save, export_*) stages a Blob in `playgroundFiles` that the user
 * downloads on click — never auto-triggered. The handful of tools that
 * genuinely don't fit a browser (model_load federated, export_glb /
 * export_ifcx / export_pdf_report) return a friendly
 * UNSUPPORTED_OPERATION so the agent can route the user to the stdio MCP
 * for those.
 */

import { IfcParser, type IfcDataStore, extractLengthUnitScale } from '@ifc-lite/parser';
import {
  BsddNamespace,
  createBimContext,
  type BimContext,
  type EntityRef,
} from '@ifc-lite/sdk';
import { EntityNode } from '@ifc-lite/query';
import {
  HeadlessLikeBackend,
  ToolErrorCode,
  ToolExecutionError,
} from '@ifc-lite/mcp/browser';
import {
  addCommentToTopic,
  addTopicToProject,
  addViewpointToTopic,
  createBCFComment,
  createBCFProject,
  createBCFTopic,
  updateTopicStatus,
  writeBCF,
  type BCFProject,
  type BCFTopic,
} from '@ifc-lite/bcf';
import { parseIDS, validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { CATALOG, paramsFor } from './data';
import type { CatalogTool } from './types';
import type { ViewerController, ColorTuple } from './PlaygroundViewer';
import { playgroundFiles } from './playground-files';
import { playgroundUploads } from './playground-uploads';

// ── loaded-model handle ────────────────────────────────────────────────────

export interface LoadedPlaygroundModel {
  id: string;
  name: string;
  fileSize: number;
  /** Raw bytes — kept around so the geometry processor can re-parse on
   *  demand. `store.source` would work too but only for stores parsed by
   *  this exact path; keeping our own copy is cheaper than hunting it. */
  bytes: Uint8Array;
  store: IfcDataStore;
  bim: BimContext;
}

/** Parse an IFC ArrayBuffer in the browser using the same path the
 * stdio CLI uses (just `IfcParser.parseColumnar`). */
export async function parsePlaygroundModel(
  buffer: ArrayBuffer,
  filename: string,
): Promise<LoadedPlaygroundModel> {
  // Snapshot the buffer up-front. parseColumnar may keep references into
  // it but the geometry processor wants a fresh, owning Uint8Array.
  const bytes = new Uint8Array(buffer.slice(0));
  const parser = new IfcParser();
  const store = await parser.parseColumnar(buffer);
  store.fileSize = buffer.byteLength;
  const id = filename.replace(/\.ifc$/i, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() || 'model';
  const backend = new HeadlessLikeBackend(store, filename, id);
  const bim = createBimContext({ backend });
  return { id, name: filename, fileSize: buffer.byteLength, bytes, store, bim };
}

// ── tool execution ────────────────────────────────────────────────────────

/**
 * Outcome of dispatching a single tool call. Mirrors the relevant fields
 * of an MCP `CallToolResult` so the chat view can render success and
 * failure with the same components.
 *
 * When a tool produces a downloadable artifact (bcf_export, model_save,
 * export_ifc / csv / json, ids_validate) it sets `download` so the chat
 * panel can surface an inline "Get .bcf" / "Save IFC" button under the
 * tool call card. The actual file lives in `playgroundFiles` (also
 * mirrored in the sidebar Downloads panel); `download.fileId` is the
 * handle the chat uses to trigger the click.
 *
 * Strict rule: download is OPT-IN per click. Tools NEVER auto-trigger.
 */
export interface ToolDispatchResult {
  text: string;
  structured: unknown;
  isError: boolean;
  errorCode?: string;
  hint?: string;
  download?: {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    /** Short label for the download button, e.g. "Get .bcf", "Save IFC". */
    label: string;
  };
}

/** Optional context surfaces the dispatcher can use beyond the model. */
export interface DispatchContext {
  /** Inline 3D viewer controller. When absent, viewer_* tools fail with
   *  UNSUPPORTED_OPERATION and ask the user to open the viewer panel. */
  viewer?: ViewerController | null;
  /** Open the inline viewer panel if it's collapsed. The viewer_open tool
   *  forwards here so the agent can request it. */
  openViewerPanel?: () => void;
  /** Optional federated models (model_id → model). When omitted only the
   *  primary `model` argument to dispatch() is reachable; diff tools that
   *  need two models use `model_id` to look the second one up. */
  registry?: Map<string, LoadedPlaygroundModel>;
}

// ── BCF session state ─────────────────────────────────────────────────────
// One BCF project per playground tab — bcf_topic_create accumulates topics,
// bcf_export bundles the lot. Lives at module scope so tools can mutate it
// across calls without threading it through every dispatch invocation.
let bcfProject: BCFProject | null = null;
function getBcfProject(): BCFProject {
  if (!bcfProject) bcfProject = createBCFProject({ name: 'ifc-lite-playground', version: '2.1' });
  return bcfProject;
}

/**
 * Auto-stage a fresh `.bcfzip` blob in playgroundFiles after every BCF
 * mutation. This way the chat shows a `Get .bcfzip` button on EVERY BCF
 * call — the user doesn't have to wait for the agent to remember to
 * call bcf_export. We re-use the same fileId across calls so the
 * sidebar Downloads panel shows ONE always-current entry instead of
 * a long history of stale bundles.
 *
 * Returns the download metadata to splice into a tool result, or null
 * when the project has no topics yet (nothing to download).
 */
let stagedBcfFileId: string | null = null;
async function autoStageBcfDownload(): Promise<NonNullable<ToolDispatchResult['download']> | null> {
  const project = getBcfProject();
  if (project.topics.size === 0) return null;
  const blob = await writeBCF(project);
  // Drop the previous staged copy so the panel only ever shows the latest.
  if (stagedBcfFileId) playgroundFiles.remove(stagedBcfFileId);
  const filename = coerceFilename(undefined, 'bcfzip', 'issues');
  const file = playgroundFiles.add({
    filename,
    mimeType: 'application/zip',
    size: blob.size,
    blob,
    source: 'bcf (auto-staged)',
    description: `${project.topics.size} topic(s) · auto-updates as you edit`,
  });
  stagedBcfFileId = file.id;
  return {
    fileId: file.id,
    filename,
    mimeType: 'application/zip',
    size: blob.size,
    label: 'Get .bcfzip',
  };
}

/**
 * Read-only tool implementations the v1 playground supports. Each entry
 * returns a (text, structured) pair the chat panel can render directly.
 * Anything not in this map → UNSUPPORTED_OPERATION.
 */
type ToolImplResult = {
  text: string;
  structured: unknown;
  download?: ToolDispatchResult['download'];
};
type ToolImpl = (model: LoadedPlaygroundModel, args: Record<string, unknown>, ctx: DispatchContext) => Promise<ToolImplResult>;

function requireViewer(ctx: DispatchContext): ViewerController {
  if (!ctx.viewer || !ctx.viewer.isLoaded()) {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'Viewer is not open. Call viewer_open first to mount the inline 3D panel.',
      hint: 'Click the "show 3D viewer" button or have the agent call viewer_open.',
    });
  }
  return ctx.viewer;
}

function parseColorArg(input: unknown): ColorTuple {
  // Accept hex strings, named colors, or [r,g,b] / [r,g,b,a] arrays in 0-1.
  if (Array.isArray(input)) {
    const arr = input.map(Number);
    if (arr.length === 3) return [arr[0], arr[1], arr[2], 1];
    if (arr.length === 4) return [arr[0], arr[1], arr[2], arr[3]];
  }
  if (typeof input === 'string') {
    const hex = input.startsWith('#') ? input.slice(1) : input;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 1];
    }
    const named: Record<string, ColorTuple> = {
      red: [1, 0.2, 0.2, 1], orange: [1, 0.6, 0.1, 1], yellow: [1, 0.9, 0.1, 1],
      green: [0.2, 0.8, 0.2, 1], blue: [0.2, 0.4, 1, 1], purple: [0.6, 0.2, 0.8, 1],
      pink: [1, 0.4, 0.8, 1], teal: [0.45, 0.85, 0.79, 1], gray: [0.5, 0.5, 0.5, 1],
      white: [1, 1, 1, 1], black: [0, 0, 0, 1],
      chartreuse: [0.84, 1.0, 0.25, 1], magenta: [1.0, 0.36, 0.86, 1],
    };
    if (named[input.toLowerCase()]) return named[input.toLowerCase()];
  }
  // Default chartreuse
  return [0.84, 1.0, 0.25, 1];
}

function formatColorTuple(c: ColorTuple): string {
  const r = Math.round(c[0] * 255).toString(16).padStart(2, '0');
  const g = Math.round(c[1] * 255).toString(16).padStart(2, '0');
  const b = Math.round(c[2] * 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/**
 * Browser-safe bSDD client routed through this site's `/api/bsdd/*` proxy.
 * The default BsddNamespace hits `api.bsdd.buildingsmart.org` directly,
 * which fails CORS in browsers. Vite (dev) and Vercel (prod) both rewrite
 * `/api/bsdd/*` to that host already, so we share the SDK's namespace
 * implementation but swap the base URL.
 */
const PROXIED_BSDD = new BsddNamespace({ apiBase: '/api/bsdd' });

const IMPLS: Record<string, ToolImpl> = {
  // ── Discovery ───────────────────────────────────────────────────────────
  async model_info(m) {
    const counts: Record<string, number> = {};
    for (const [type, ids] of m.store.entityIndex.byType) counts[type] = ids.length;
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([type, count]) => ({ type, count }));
    const summary = `Model '${m.name}' (${m.store.schemaVersion}): ${m.store.entityCount.toLocaleString()} entities, ${formatBytes(m.fileSize)}`;
    return {
      text: summary,
      structured: {
        id: m.id,
        name: m.name,
        schema: m.store.schemaVersion,
        entityCount: m.store.entityCount,
        fileSize: m.fileSize,
        typeCountsTop20: top,
      },
    };
  },

  async model_list(m) {
    return {
      text: `1 model loaded: ${m.name} (${m.store.entityCount.toLocaleString()} entities).`,
      structured: { models: [{ id: m.id, name: m.name, entityCount: m.store.entityCount, schema: m.store.schemaVersion }] },
    };
  },

  async schema_describe(_m, args) {
    const type = String(args.type ?? '');
    if (!type) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`type` is required.' });
    }
    return {
      text: `Schema description for ${type} is best read from /mcp#schema_describe — the full reflection table requires the @ifc-lite/data introspection map (server-side only in v1).`,
      structured: { type, note: 'In-browser schema reflection is in v0.3.' },
    };
  },

  // ── Query ───────────────────────────────────────────────────────────────
  async query_entities(m, args) {
    const type = args.type as string | undefined;
    const limit = Math.min(Number(args.limit ?? 50), 200);
    const offset = Number(args.offset ?? 0);
    let q = m.bim.query();
    if (type) q = q.byType(type);
    const all = q.toArray();
    const page = all.slice(offset, offset + limit);
    const head = `Found ${all.length.toLocaleString()} matching entit${all.length === 1 ? 'y' : 'ies'}${page.length < all.length ? ` (showing ${page.length})` : ''}.`;
    const lines = page.slice(0, 25).map((e) => {
      const name = e.name ? ` '${e.name}'` : '';
      const gid = e.globalId ? ` GlobalId=${e.globalId}` : '';
      return `  • ${e.type ?? '?'} #${e.ref.expressId}${name}${gid}`;
    });
    return {
      text: [head, ...lines].join('\n'),
      structured: {
        count: all.length,
        truncated: page.length < all.length,
        entities: page.map((e) => ({
          expressId: e.ref.expressId,
          modelId: e.ref.modelId,
          globalId: e.globalId,
          name: e.name,
          type: e.type,
          description: e.description,
          objectType: e.objectType,
        })),
      },
    };
  },

  async count_entities(m, args) {
    const groupBy = (args.group_by as string | undefined) ?? 'type';
    const counts = new Map<string, number>();
    if (groupBy === 'type') {
      for (const [type, ids] of m.store.entityIndex.byType) counts.set(type, ids.length);
    } else if (groupBy === 'storey') {
      for (const e of m.bim.query().toArray()) {
        const node = new EntityNode(m.store, e.ref.expressId);
        const storey = node.storey();
        const key = storey?.name ?? '(no storey)';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } else if (groupBy === 'material') {
      for (const e of m.bim.query().toArray()) {
        const mat = m.bim.materials(e.ref);
        const key = mat?.name ?? '(no material)';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const groups = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }));
    return {
      text: `Counted ${groups.length} group(s) by ${groupBy}.\n${groups.slice(0, 25).map((g) => `  • ${g.key} — ${g.count}`).join('\n')}`,
      structured: { groupBy, groups },
    };
  },

  async get_entity(m, args) {
    const ref = resolveRef(m, args);
    const data = m.bim.entity(ref);
    if (!data) {
      throw new ToolExecutionError({
        code: ToolErrorCode.ENTITY_NOT_FOUND,
        message: `No entity at ${refStr(ref)} in this model.`,
      });
    }
    return {
      text: `${data.type} '${data.name ?? '(unnamed)'}' (#${data.ref.expressId})`,
      structured: data,
    };
  },

  async get_entities_bulk(m, args) {
    const gids = (args.global_ids as string[] | undefined) ?? [];
    const out: unknown[] = [];
    for (const gid of gids.slice(0, 200)) {
      try {
        const ref = resolveRef(m, { global_id: gid });
        out.push(m.bim.entity(ref));
      } catch {
        out.push(null);
      }
    }
    return { text: `Resolved ${out.filter(Boolean).length}/${gids.length} entities.`, structured: { entities: out } };
  },

  async spatial_hierarchy(m) {
    // Lightweight tree walk using EntityNode. The IFC spatial graph uses
    // IfcRelAggregates for "decomposes" + IfcRelContainedInSpatialStructure
    // for "contains" — EntityNode exposes both.
    interface Node { expressId: number; type?: string; name?: string; children: Node[] }
    const projects = m.store.entityIndex.byType.get('IFCPROJECT') ?? [];
    function build(expressId: number, depth: number): Node {
      const node = new EntityNode(m.store, expressId);
      const out: Node = { expressId, type: node.type, name: node.name, children: [] };
      if (depth > 6) return out; // bound the recursion for the chat budget
      for (const child of node.decomposes()) out.children.push(build(child.expressId, depth + 1));
      for (const child of node.contains()) out.children.push(build(child.expressId, depth + 1));
      return out;
    }
    const root = projects.map((id) => build(id, 0));
    return { text: `Spatial hierarchy for '${m.name}'.`, structured: { tree: root } };
  },

  async containment_chain(m, args) {
    const ref = resolveRef(m, args);
    const path: Array<{ expressId: number; type?: string; name?: string; globalId?: string }> = [];
    let current: EntityNode | null = new EntityNode(m.store, ref.expressId);
    let safety = 32;
    while (current && safety-- > 0) {
      const step: EntityNode = current;
      path.push({ expressId: step.expressId, type: step.type, name: step.name, globalId: step.globalId });
      // Walk up via spatial containment first, then aggregate parent.
      const next: EntityNode | null = step.containedIn() ?? step.decomposedBy();
      if (!next || path.some((p) => p.expressId === next.expressId)) break;
      current = next;
    }
    return { text: `${path.length}-step containment path.`, structured: { path } };
  },

  async relationships(m, args) {
    const ref = resolveRef(m, args);
    const data = m.bim.relationships(ref);
    return { text: `Relationships`, structured: data };
  },

  async properties_unique(m, args) {
    const type = String(args.type ?? '');
    const psetName = String(args.pset ?? '');
    const propName = String(args.property ?? '');
    if (!type || !psetName || !propName) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'type, pset and property are all required.',
      });
    }
    const counts = new Map<string, number>();
    let total = 0;
    for (const e of m.bim.query().byType(type).toArray()) {
      const v = m.bim.property(e.ref, psetName, propName);
      const key = v == null ? '(missing)' : String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
    const values = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
    const head = `${values.length} unique value(s) for ${type}.${psetName}.${propName} across ${total} entit${total === 1 ? 'y' : 'ies'}:`;
    return { text: [head, ...values.slice(0, 30).map((v) => `  • ${v.value} — ${v.count}`)].join('\n'), structured: { values, total } };
  },

  async materials_list(m) {
    const counts = new Map<string, number>();
    for (const e of m.bim.query().toArray()) {
      const mat = m.bim.materials(e.ref);
      if (!mat) continue;
      const key = mat.name ?? '(unnamed)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const list = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    return {
      text: `${list.length} distinct material(s) in use:\n${list.slice(0, 30).map((m) => `  • ${m.name} — ${m.count}`).join('\n')}`,
      structured: { materials: list },
    };
  },

  async classifications_list(m) {
    const counts = new Map<string, number>();
    for (const e of m.bim.query().toArray()) {
      for (const c of m.bim.classifications(e.ref)) {
        const key = `${c.system ?? '?'}:${c.identification ?? c.name ?? '?'}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const list = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
    return {
      text: `${list.length} distinct classification reference(s):\n${list.slice(0, 30).map((c) => `  • ${c.key} — ${c.count}`).join('\n')}`,
      structured: { classifications: list },
    };
  },

  async georeferencing(m) {
    const counts = m.store.entityIndex.byType.get('IFCMAPCONVERSION') ?? [];
    return {
      text: counts.length === 0 ? 'Model has no IfcMapConversion (no georeferencing).' : `${counts.length} IfcMapConversion entity (georeferenced).`,
      structured: { hasGeoreference: counts.length > 0 },
    };
  },

  async units(m) {
    const scale = m.store.source && m.store.entityIndex
      ? extractLengthUnitScale(m.store.source, m.store.entityIndex)
      : 1.0;
    return {
      text: `Length unit scale: ${scale} (lengths × ${scale} → metres). Schema: ${m.store.schemaVersion}.`,
      structured: { lengthUnitScale: scale, schema: m.store.schemaVersion },
    };
  },

  // ── Geometry (read from quantity sets) ──────────────────────────────────
  async geometry_bbox(m, args) {
    const ref = resolveRef(m, args);
    const qsets = m.bim.quantities(ref);
    return { text: 'Bounding-box derived from quantity sets when available; full WASM geometry is v0.2.', structured: { quantitySets: qsets } };
  },
  async geometry_volume(m, args) {
    const ref = resolveRef(m, args);
    const qsets = m.bim.quantities(ref);
    let vol: number | null = null;
    for (const q of qsets) for (const x of q.quantities) if (/Volume/i.test(x.name) && typeof x.value === 'number') { vol = x.value; break; }
    return { text: vol == null ? 'No Volume quantity present.' : `Volume = ${vol.toFixed(3)} m³.`, structured: { volume: vol } };
  },
  async geometry_area(m, args) {
    const ref = resolveRef(m, args);
    const qsets = m.bim.quantities(ref);
    let area: number | null = null;
    for (const q of qsets) for (const x of q.quantities) if (/Area/i.test(x.name) && typeof x.value === 'number') { area = x.value; break; }
    return { text: area == null ? 'No Area quantity present.' : `Area = ${area.toFixed(3)} m².`, structured: { area } };
  },

  // ── Validation ──────────────────────────────────────────────────────────
  async model_audit(m) {
    let issues = 0;
    const products = m.bim.query().toArray();
    let missingGid = 0, missingName = 0;
    for (const e of products) {
      if (!e.globalId) missingGid++;
      if (!e.name) missingName++;
    }
    issues = missingGid + (missingName > products.length / 2 ? 1 : 0);
    const score = Math.max(0, 100 - issues * 5);
    return {
      text: `Audit score: ${score}/100${issues > 0 ? ` (${issues} issue${issues === 1 ? '' : 's'}).` : '. Clean.'}`,
      structured: { overall: score, issues: { missingGlobalIds: missingGid, missingNamesRatio: missingName / Math.max(1, products.length) } },
    };
  },

  // ── bSDD (network — proxied through /api/bsdd to dodge CORS) ───────────
  async bsdd_search(_m, args) {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`query` is required.' });
    try {
      const results = await PROXIED_BSDD.search(query);
      const head = `bSDD search '${query}' — ${results.length} result(s)${results.length > 25 ? ', showing first 25' : ''}:`;
      const lines = results.slice(0, 25).map((r) => `• ${r.code || r.name} — ${r.name ?? ''}\n  ${r.uri}`);
      return { text: [head, ...lines].join('\n'), structured: { query, count: results.length, results: results.slice(0, 25) } };
    } catch (err) {
      throw rethrowBsdd(err, 'search');
    }
  },
  async bsdd_class(_m, args) {
    const ifcType = String(args.ifc_type ?? '');
    if (!ifcType) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`ifc_type` is required.' });
    try {
      const info = await PROXIED_BSDD.fetchClassInfo(ifcType);
      if (!info) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `bSDD has no class for '${ifcType}'.` });
      const psetGroups = new Map<string, string[]>();
      for (const p of info.classProperties) {
        const k = p.propertySet ?? '(no Pset)';
        const list = psetGroups.get(k) ?? [];
        list.push(`${p.name}${p.dataType ? ` (${p.dataType})` : ''}`);
        psetGroups.set(k, list);
      }
      const head = `bSDD class ${info.code} — ${info.classProperties.length} properties across ${psetGroups.size} Psets:`;
      const lines: string[] = [head];
      for (const [pset, props] of psetGroups) {
        lines.push(`• ${pset} (${props.length}):`);
        for (const p of props.slice(0, 10)) lines.push(`    - ${p}`);
        if (props.length > 10) lines.push(`    - … +${props.length - 10} more`);
      }
      return { text: lines.join('\n'), structured: info as unknown as Record<string, unknown> };
    } catch (err) {
      throw rethrowBsdd(err, 'class lookup');
    }
  },
  // ── Mutation (queues edits on the in-memory store, persists via model_save) ─
  async entity_set_property(m, args) {
    const ref = resolveRef(m, args);
    const pset = String(args.pset ?? '');
    const name = String(args.name ?? '');
    if (!pset || !name) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'pset and name are required.' });
    m.bim.mutate.setProperty(ref, pset, name, args.value as string | number | boolean);
    return { text: `Queued ${pset}.${name} = ${JSON.stringify(args.value)} on #${ref.expressId}.`, structured: { expressId: ref.expressId, pset, name, value: args.value } };
  },
  async entity_delete_property(m, args) {
    const ref = resolveRef(m, args);
    const pset = String(args.pset ?? '');
    const name = String(args.name ?? '');
    if (!pset || !name) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'pset and name are required.' });
    m.bim.mutate.deleteProperty(ref, pset, name);
    return { text: `Queued delete ${pset}.${name} on #${ref.expressId}.`, structured: { expressId: ref.expressId, pset, name } };
  },
  async entity_set_attribute(m, args) {
    const ref = resolveRef(m, args);
    const attribute = String(args.attribute ?? '');
    const value = args.value;
    if (!attribute) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'attribute is required.' });
    m.bim.mutate.setAttribute(ref, attribute, String(value));
    return { text: `Queued ${attribute} = ${JSON.stringify(value)} on #${ref.expressId}.`, structured: { expressId: ref.expressId, attribute, value } };
  },
  async entity_create(m, args) {
    const type = String(args.type ?? '');
    if (!type) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'type is required.' });
    // Use HeadlessLikeBackend's editor — it's the same path the stdio MCP
    // takes for entity_create.
    const editor = (m.bim as unknown as { backend: { ensureEditor(): { addEntity(t: string, a: unknown[]): { expressId: number } } } }).backend.ensureEditor();
    const attrs = (args.attributes as unknown[] | undefined) ?? [];
    const ref = editor.addEntity(type, attrs as Parameters<typeof editor.addEntity>[1]);
    return { text: `Created ${type} as #${ref.expressId}.`, structured: { expressId: ref.expressId, type } };
  },
  async entity_delete(m, args) {
    const ref = resolveRef(m, args);
    // The mutate namespace doesn't expose a delete on its public surface,
    // but the headless backend's mutation view does.
    const view = (m.bim as unknown as { backend: { getMutationView(): { deleteEntity(id: number): boolean } | null } }).backend.getMutationView();
    if (!view) throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'Mutation view unavailable.' });
    const ok = view.deleteEntity(ref.expressId);
    return { text: ok ? `Deleted #${ref.expressId}.` : `#${ref.expressId} was not in the store.`, structured: { expressId: ref.expressId, deleted: ok } };
  },
  async mutation_diff(m) {
    const view = (m.bim as unknown as { backend: { getMutationView(): { mutationHistory?: unknown[] } | null } }).backend.getMutationView();
    const hist = view ? (view as { mutationHistory?: unknown[] }).mutationHistory ?? [] : [];
    return { text: `${hist.length} pending mutation(s).`, structured: { count: hist.length, mutations: hist } };
  },
  async mutation_undo(m, args) {
    const n = Math.max(1, Number(args.n ?? 1));
    let undone = 0;
    for (let i = 0; i < n; i++) {
      if (m.bim.mutate.undo(m.id)) undone++;
      else break;
    }
    return { text: `Undone ${undone} mutation(s).`, structured: { undone } };
  },
  async model_save(m, args) {
    // "Save" in the playground = stage a downloadable .ifc Blob. The user
    // explicitly clicks the download button later — never auto-triggered.
    // Filename is always .ifc — the agent sometimes invents .ids / .bcf
    // extensions based on prior context; we ignore them.
    const filename = coerceFilename(args.file_path as string | undefined, 'ifc', m.id);
    const schema = (args.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined) ?? (m.store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3');
    const content = m.bim.export.ifc([], { schema });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    const blob = new Blob([text], { type: 'application/x-step' });
    const file = playgroundFiles.add({
      filename, mimeType: 'application/x-step', size: blob.size, blob,
      source: 'model_save', description: `Saved model with pending mutations · ${schema}`,
    });
    return {
      text: `Saved ${filename} (${formatBytes(blob.size)}, ${schema}).`,
      structured: { fileId: file.id, filename, bytes: blob.size, schema },
      download: { fileId: file.id, filename, mimeType: 'application/x-step', size: blob.size, label: 'Save IFC' },
    };
  },

  // ── BCF (in-session project; bcf_export stages a .bcfzip download) ─────
  // NOTE: BCF tool text outputs print the FULL guid every time. Truncating
  // (`guid.slice(0,8)…`) breaks the agent loop — the agent only sees the
  // text content, so a follow-up bcf_viewpoint_create / bcf_topic_update
  // call has nothing to anchor on. Always include the complete guid.
  async bcf_topic_list(_m, args) {
    const project = getBcfProject();
    const filter = typeof args.status === 'string' ? args.status : undefined;
    const topics: BCFTopic[] = Array.from(project.topics.values()).filter((t) => !filter || t.topicStatus === filter);
    return {
      text: `${topics.length} topic(s).${topics.length === 0 ? '' : '\n' + topics.map((t) => `• ${t.guid} · ${t.topicStatus} · ${t.title}`).join('\n')}`,
      structured: { count: topics.length, topics: topics.map((t) => ({ guid: t.guid, title: t.title, status: t.topicStatus, type: t.topicType, priority: t.priority, comments: t.comments.length })) },
    };
  },
  async bcf_topic_create(_m, args) {
    const title = String(args.title ?? '').trim();
    if (!title) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'title is required.' });
    const project = getBcfProject();
    const topic = createBCFTopic({
      title,
      description: typeof args.description === 'string' ? args.description : undefined,
      author: typeof args.author === 'string' ? args.author : 'ifc-lite-playground',
      topicType: typeof args.type === 'string' ? args.type : 'Issue',
      topicStatus: typeof args.status === 'string' ? args.status : 'Open',
      priority: typeof args.priority === 'string' ? args.priority : undefined,
      assignedTo: typeof args.assigned_to === 'string' ? args.assigned_to : undefined,
      labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined,
    });
    addTopicToProject(project, topic);
    const download = await autoStageBcfDownload();
    return {
      text: `Created topic '${topic.title}' · guid=${topic.guid}`,
      structured: { guid: topic.guid, title: topic.title },
      ...(download ? { download } : {}),
    };
  },
  async bcf_topic_update(_m, args) {
    const project = getBcfProject();
    const guid = String(args.guid ?? '');
    const topic = project.topics.get(guid);
    if (!topic) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Topic ${guid} not found.` });
    const author = typeof args.modified_by === 'string' ? args.modified_by : 'ifc-lite-playground';
    if (typeof args.status === 'string') updateTopicStatus(topic, args.status, author);
    if (typeof args.priority === 'string') topic.priority = args.priority;
    if (typeof args.comment === 'string') {
      addCommentToTopic(topic, createBCFComment({ author, comment: args.comment }));
    }
    const download = await autoStageBcfDownload();
    return {
      text: `Topic ${guid} updated.`,
      structured: { guid, status: topic.topicStatus },
      ...(download ? { download } : {}),
    };
  },
  async bcf_topic_close(_m, args) {
    const project = getBcfProject();
    const guid = String(args.guid ?? '');
    const topic = project.topics.get(guid);
    if (!topic) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Topic ${guid} not found.` });
    updateTopicStatus(topic, 'Closed', typeof args.modified_by === 'string' ? args.modified_by : 'ifc-lite-playground');
    const download = await autoStageBcfDownload();
    return {
      text: `Closed ${guid}.`,
      structured: { guid },
      ...(download ? { download } : {}),
    };
  },
  async bcf_viewpoint_create(_m, args) {
    const project = getBcfProject();
    const guid = String(args.guid ?? '');
    const topic = project.topics.get(guid);
    if (!topic) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Topic ${guid} not found.` });
    const selection = (args.selection_global_ids as string[] | undefined) ?? [];
    const viewpoint = {
      guid: cryptoRandomUuid(),
      components: { selection: selection.map((g) => ({ ifcGuid: g, OriginatingSystem: 'ifc-lite-playground' })) },
    };
    addViewpointToTopic(topic, viewpoint as unknown as Parameters<typeof addViewpointToTopic>[1]);
    const download = await autoStageBcfDownload();
    return {
      text: `Viewpoint added (${selection.length} entity selection).`,
      structured: { viewpointGuid: viewpoint.guid, selection: selection.length },
      ...(download ? { download } : {}),
    };
  },
  async bcf_export(_m, args) {
    const project = getBcfProject();
    const filename = coerceFilename(args.file_path as string | undefined, 'bcfzip', 'issues');
    const blob = await writeBCF(project);
    const file = playgroundFiles.add({
      filename, mimeType: 'application/zip', size: blob.size, blob,
      source: 'bcf_export', description: `${project.topics.size} topic(s)`,
    });
    return {
      text: `Bundled ${filename} (${formatBytes(blob.size)}, ${project.topics.size} topic(s)).`,
      structured: { fileId: file.id, filename, bytes: blob.size, topics: project.topics.size },
      download: { fileId: file.id, filename, mimeType: 'application/zip', size: blob.size, label: 'Get .bcfzip' },
    };
  },

  // ── IDS (parses + validates against the loaded model) ─────────────────
  async ids_validate(m, args) {
    const xml = resolveIdsXml(args);
    if (!xml) throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: 'Provide IDS via `ids_path` (filename of an attached upload) or `ids_xml` (raw XML). Tell the user to drag a .ids file onto the chat input if they haven\'t attached one yet.',
    });
    let doc: IDSDocument;
    try {
      doc = parseIDS(xml);
    } catch (err) {
      throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: err instanceof Error ? err.message : String(err) });
    }
    const accessor = makeIdsAccessor(m);
    const report = await validateIDS(doc, accessor, {
      modelId: m.id,
      schemaVersion: m.store.schemaVersion,
      entityCount: m.store.entityCount,
    });
    const head = `IDS '${doc.info?.title ?? 'untitled'}' · ${report.summary.passedSpecifications}/${report.summary.totalSpecifications} specs passed (${report.summary.overallPassRate.toFixed(0)}%).`;
    const lines = report.specificationResults.map((s) => {
      const ok = s.status === 'pass';
      const skipped = s.status === 'not_applicable';
      const tag = skipped ? '·' : ok ? '✓' : '✗';
      return `${tag} ${s.specification.name ?? '(unnamed)'} — ${s.passedCount} pass / ${s.failedCount} fail · ${s.passRate.toFixed(0)}%`;
    });
    // Stage a downloadable JSON report so the user can save / share it.
    const reportBlob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const reportSlug = (doc.info?.title ?? 'spec').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    const reportFilename = coerceFilename(undefined, 'json', `ids-report-${reportSlug}`);
    const reportFile = playgroundFiles.add({
      filename: reportFilename, mimeType: 'application/json', size: reportBlob.size, blob: reportBlob,
      source: 'ids_validate',
      description: `${report.summary.passedSpecifications}/${report.summary.totalSpecifications} specs passed`,
    });
    return {
      text: [head, ...lines].join('\n'),
      structured: report as unknown as Record<string, unknown>,
      download: { fileId: reportFile.id, filename: reportFilename, mimeType: 'application/json', size: reportBlob.size, label: 'Get IDS report' },
    };
  },
  async ids_explain(_m, args) {
    const xml = resolveIdsXml(args);
    if (!xml) throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: 'Provide IDS via `ids_path` (filename of an attached upload) or `ids_xml` (raw XML).',
    });
    let doc: IDSDocument;
    try {
      doc = parseIDS(xml);
    } catch (err) {
      throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: err instanceof Error ? err.message : String(err) });
    }
    const head = `IDS '${doc.info?.title ?? 'untitled'}' · ${doc.specifications.length} specification(s).`;
    const lines = doc.specifications.map((s, i) => `${i + 1}. ${s.name ?? '(unnamed)'} — applies to ${s.applicability.facets.length} facet(s); requires ${s.requirements.length} clause(s).`);
    return { text: [head, ...lines].join('\n'), structured: doc as unknown as Record<string, unknown> };
  },

  // ── Export (CSV / JSON / IFC — staged for download) ───────────────────
  async export_ifc(m, args) {
    const filename = coerceFilename(args.file_path as string | undefined, 'ifc', m.id);
    const schema = (args.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined) ?? (m.store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3');
    let refs: EntityRef[] = [];
    if (Array.isArray(args.global_ids)) {
      const wanted = new Set(args.global_ids as string[]);
      for (const e of m.bim.query().toArray()) if (wanted.has(e.globalId)) refs.push(e.ref);
    }
    const content = m.bim.export.ifc(refs, { schema });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    const blob = new Blob([text], { type: 'application/x-step' });
    const file = playgroundFiles.add({
      filename, mimeType: 'application/x-step', size: blob.size, blob,
      source: 'export_ifc', description: `${refs.length || m.store.entityCount} entit${(refs.length || m.store.entityCount) === 1 ? 'y' : 'ies'}`,
    });
    return {
      text: `Wrote ${filename} (${formatBytes(blob.size)}).`,
      structured: { fileId: file.id, filename, bytes: blob.size },
      download: { fileId: file.id, filename, mimeType: 'application/x-step', size: blob.size, label: 'Save IFC' },
    };
  },
  async export_csv(m, args) {
    const cols = (args.columns as string[] | undefined) ?? ['GlobalId', 'Type', 'Name'];
    const sep = (args.separator as string | undefined) ?? ',';
    const filterType = args.type as string | undefined;
    const refs = (filterType ? m.bim.query().byType(filterType).toArray() : m.bim.query().toArray()).map((e) => e.ref);
    const csv = m.bim.export.csv(refs, { columns: cols, separator: sep });
    const filename = coerceFilename(args.file_path as string | undefined, 'csv', filterType ?? 'entities');
    const blob = new Blob([csv], { type: 'text/csv' });
    const file = playgroundFiles.add({
      filename, mimeType: 'text/csv', size: blob.size, blob,
      source: 'export_csv', description: `${refs.length} row(s) · ${cols.join(', ')}`,
    });
    return {
      text: `Wrote ${filename} (${refs.length} rows, ${formatBytes(blob.size)}).`,
      structured: { fileId: file.id, filename, rows: refs.length, bytes: blob.size },
      download: { fileId: file.id, filename, mimeType: 'text/csv', size: blob.size, label: 'Get .csv' },
    };
  },
  async export_json(m, args) {
    const cols = (args.columns as string[] | undefined) ?? ['GlobalId', 'Type', 'Name'];
    const filterType = args.type as string | undefined;
    const refs = (filterType ? m.bim.query().byType(filterType).toArray() : m.bim.query().toArray()).map((e) => e.ref);
    const rows = m.bim.export.json(refs, cols);
    const filename = coerceFilename(args.file_path as string | undefined, 'json', filterType ?? 'entities');
    const text = JSON.stringify(rows, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const file = playgroundFiles.add({
      filename, mimeType: 'application/json', size: blob.size, blob,
      source: 'export_json', description: `${rows.length} row(s) · ${cols.join(', ')}`,
    });
    return {
      text: `Wrote ${filename} (${rows.length} rows, ${formatBytes(blob.size)}).`,
      structured: { fileId: file.id, filename, rows: rows.length, bytes: blob.size },
      download: { fileId: file.id, filename, mimeType: 'application/json', size: blob.size, label: 'Get .json' },
    };
  },

  // ── Diff (needs two loaded models — uses ctx.registry) ────────────────
  async model_diff(m, args, ctx) {
    const { left, right } = resolveDiffModels(m, args, ctx);
    const types1 = new Map<string, number>();
    const types2 = new Map<string, number>();
    for (const [type, ids] of left.store.entityIndex.byType) types1.set(type, ids.length);
    for (const [type, ids] of right.store.entityIndex.byType) types2.set(type, ids.length);
    const diffs: Array<{ type: string; left: number; right: number; delta: number }> = [];
    for (const t of new Set([...types1.keys(), ...types2.keys()])) {
      const a = types1.get(t) ?? 0;
      const b = types2.get(t) ?? 0;
      if (a !== b) diffs.push({ type: t, left: a, right: b, delta: b - a });
    }
    diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const head = `Diff ${left.id} → ${right.id}: ${diffs.length} type-count change(s).`;
    return { text: [head, ...diffs.slice(0, 25).map((d) => `  • ${d.type}: ${d.left} → ${d.right} (${d.delta > 0 ? '+' : ''}${d.delta})`)].join('\n'), structured: { typeDiffs: diffs } };
  },
  async quantity_diff(m, args, ctx) {
    const { left, right } = resolveDiffModels(m, args, ctx);
    const type = (args.type as string | undefined) ?? 'IfcWall';
    const qName = (args.quantity as string | undefined) ?? 'Volume';
    function sumFor(model: LoadedPlaygroundModel): number {
      let total = 0;
      for (const e of model.bim.query().byType(type).toArray()) {
        const v = model.bim.quantity(e.ref, '', qName);
        if (typeof v === 'number') total += v;
      }
      return total;
    }
    const a = sumFor(left);
    const b = sumFor(right);
    return { text: `${type}.${qName}: ${a.toFixed(2)} → ${b.toFixed(2)} (${(b - a).toFixed(2)})`, structured: { type, quantity: qName, left: a, right: b, delta: b - a } };
  },

  // ── Viewer (drives the inline Three.js panel) ──────────────────────────
  async viewer_ask(_m, args) {
    const reason = String(args.reason ?? '');
    return {
      text: `Ask the user: "I'd like to open the inline 3D viewer${reason ? ` to ${reason}` : ''}. May I?" If they agree, call viewer_open.`,
      structured: { suggestedTool: 'viewer_open', reason },
    };
  },

  async viewer_open(_m, _args, ctx) {
    if (ctx.openViewerPanel) ctx.openViewerPanel();
    if (ctx.viewer && ctx.viewer.isLoaded()) {
      const status = ctx.viewer.status();
      return {
        text: `Inline viewer ready (${status.meshCount} entities rendered). Pick interactions sync back via viewer_get_selection.`,
        structured: { open: true, meshCount: status.meshCount, inline: true },
      };
    }
    return {
      text: 'Asked to open the inline viewer. Geometry is processing — call viewer_status in a moment to confirm it’s ready.',
      structured: { open: true, pending: true },
    };
  },

  async viewer_close(_m, _args, ctx) {
    // The panel-collapse in this v1 isn't agent-controllable (the user owns
    // chrome). We surface a friendly status instead of pretending we
    // dismantled the canvas.
    void ctx;
    return { text: 'Inline viewer panel is user-controlled in the playground; toggle it from the chevron above the canvas.', structured: { closed: false, note: 'user-toggle' } };
  },

  async viewer_status(_m, _args, ctx) {
    const v = ctx.viewer;
    if (!v) return { text: 'No viewer attached.', structured: { open: false } };
    const s = v.status();
    return {
      text: s.loaded ? `Viewer open · ${s.meshCount} meshes · ${s.selection.length} picked.` : 'Viewer panel mounted but no geometry yet.',
      structured: s,
    };
  },

  async viewer_colorize(_m, args, ctx) {
    const v = requireViewer(ctx);
    const color = parseColorArg(args.color);
    const out = v.colorize({
      globalIds: args.global_ids as string[] | undefined,
      expressIds: args.express_ids as number[] | undefined,
      type: args.type as string | undefined,
      color,
    });
    return { text: `Painted ${out.count} entit${out.count === 1 ? 'y' : 'ies'} ${formatColorTuple(color)}.`, structured: { count: out.count, color } };
  },

  async viewer_isolate(_m, args, ctx) {
    const v = requireViewer(ctx);
    const out = v.isolate({
      globalIds: args.global_ids as string[] | undefined,
      expressIds: args.express_ids as number[] | undefined,
      type: args.type as string | undefined,
    });
    return { text: `Isolated ${out.count} entit${out.count === 1 ? 'y' : 'ies'}; everything else hidden.`, structured: { count: out.count } };
  },

  async viewer_hide(_m, args, ctx) {
    const v = requireViewer(ctx);
    const out = v.hide({
      globalIds: args.global_ids as string[] | undefined,
      expressIds: args.express_ids as number[] | undefined,
      type: args.type as string | undefined,
    });
    return { text: `Hid ${out.count} entit${out.count === 1 ? 'y' : 'ies'}.`, structured: { count: out.count } };
  },

  async viewer_show(_m, args, ctx) {
    const v = requireViewer(ctx);
    const out = v.show({
      globalIds: args.global_ids as string[] | undefined,
      expressIds: args.express_ids as number[] | undefined,
      type: args.type as string | undefined,
    });
    return { text: `Showed ${out.count} entit${out.count === 1 ? 'y' : 'ies'}.`, structured: { count: out.count } };
  },

  async viewer_reset(_m, _args, ctx) {
    const v = requireViewer(ctx);
    v.reset();
    return { text: 'Reset: visibility, colours, and section restored to defaults.', structured: { reset: true } };
  },

  async viewer_fly_to(_m, args, ctx) {
    const v = requireViewer(ctx);
    const out = v.flyTo({
      globalIds: args.global_ids as string[] | undefined,
      expressIds: args.express_ids as number[] | undefined,
    });
    if (out.count === 0) {
      throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: 'No matching entities to frame.' });
    }
    return { text: `Flying camera to ${out.count} entit${out.count === 1 ? 'y' : 'ies'}.`, structured: { count: out.count } };
  },

  async viewer_set_section(_m, args, ctx) {
    const v = requireViewer(ctx);
    const axis = String(args.axis ?? '').toLowerCase();
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'axis must be "x", "y", or "z".' });
    }
    const position = Number(args.position ?? 0);
    if (!Number.isFinite(position)) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'position must be a number.' });
    }
    v.setSection({ axis: axis as 'x' | 'y' | 'z', position });
    return { text: `Section ${axis} = ${position.toFixed(2)}.`, structured: { axis, position } };
  },

  async viewer_clear_section(_m, _args, ctx) {
    const v = requireViewer(ctx);
    v.clearSection();
    return { text: 'Section cleared.', structured: { cleared: true } };
  },

  async viewer_color_by_storey(_m, _args, ctx) {
    const v = requireViewer(ctx);
    const out = v.colorByStorey();
    return { text: `Coloured by storey — ${out.groups} group${out.groups === 1 ? '' : 's'}.`, structured: out };
  },

  async viewer_color_by_property(m, args, ctx) {
    const v = requireViewer(ctx);
    const type = String(args.type ?? '');
    const psetName = String(args.pset ?? '');
    const propName = String(args.property ?? '');
    if (!type || !psetName || !propName) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'type, pset, and property are required.' });
    }
    const out = v.colorByProperty({
      type,
      pset: psetName,
      property: propName,
      sample: (expressId) => {
        const ref: EntityRef = { modelId: m.id, expressId };
        return m.bim.property(ref, psetName, propName);
      },
    });
    const lines = out.legend.map((l) => `  • ${l.value} — ${l.count}`);
    return { text: `Coloured ${type} by ${psetName}.${propName} — ${out.legend.length} bucket(s):\n${lines.join('\n')}`, structured: out };
  },

  async viewer_get_selection(m, args, ctx) {
    const v = requireViewer(ctx);
    const sel = v.getSelection();
    if (sel.length === 0) return { text: 'No selection in viewer.', structured: { selection: [] } };
    const include = new Set((args.include as string[] | undefined) ?? ['attributes']);
    const enriched = sel.map((s) => {
      const ref: EntityRef = { modelId: m.id, expressId: s.expressId };
      const data = m.bim.entity(ref);
      const out: Record<string, unknown> = { ...s, entity: data };
      if (include.has('attributes') && data) out.attributes = m.bim.attributes(ref);
      if (include.has('properties') && data) out.properties = m.bim.properties(ref);
      if (include.has('quantities') && data) out.quantities = m.bim.quantities(ref);
      if (include.has('classifications') && data) out.classifications = m.bim.classifications(ref);
      if (include.has('materials') && data) out.materials = m.bim.materials(ref);
      return out;
    });
    const head = `${sel.length} entit${sel.length === 1 ? 'y' : 'ies'} selected:`;
    const lines = enriched.map((e) => {
      const data = e.entity as { type?: string; name?: string; globalId?: string } | null;
      return `• ${data?.type ?? '?'} #${(e as { expressId: number }).expressId}${data?.name ? ` '${data.name}'` : ''}${data?.globalId ? ` GlobalId=${data.globalId}` : ''}`;
    });
    return { text: [head, ...lines].join('\n'), structured: { selection: enriched } };
  },

  async viewer_describe_selection(m, _args, ctx) {
    const v = requireViewer(ctx);
    const sel = v.getSelection();
    if (sel.length === 0) return { text: 'Nothing selected — click an entity in the viewer first.', structured: { selection: [] } };
    const enriched = sel.map((s) => {
      const ref: EntityRef = { modelId: m.id, expressId: s.expressId };
      return {
        ...s,
        entity: m.bim.entity(ref),
        attributes: m.bim.attributes(ref),
        properties: m.bim.properties(ref),
        quantities: m.bim.quantities(ref),
        classifications: m.bim.classifications(ref),
        materials: m.bim.materials(ref),
      };
    });
    const head = `${enriched.length} selected (full detail):`;
    const lines: string[] = [head];
    for (const e of enriched) {
      const data = e.entity as { type?: string; name?: string; globalId?: string } | null;
      lines.push(`• ${data?.type ?? '?'} #${e.expressId} '${data?.name ?? '(unnamed)'}'`);
      if (data?.globalId) lines.push(`  GlobalId: ${data.globalId}`);
      if (e.properties && e.properties.length > 0) {
        const psets = e.properties.map((p) => `${p.name} (${p.properties.length})`);
        lines.push(`  Property sets: ${psets.join(', ')}`);
      }
      if (e.materials) {
        const mat = e.materials as { name?: string; layers?: Array<{ materialName?: string; name?: string }> };
        if (mat.layers?.length) lines.push(`  Materials: ${mat.layers.map((l) => l.materialName ?? l.name).join(', ')}`);
        else if (mat.name) lines.push(`  Material: ${mat.name}`);
      }
    }
    return { text: lines.join('\n'), structured: { selection: enriched } };
  },

  async bsdd_property_sets(_m, args) {
    const ifcType = String(args.ifc_type ?? '');
    if (!ifcType) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`ifc_type` is required.' });
    try {
      const psets = await PROXIED_BSDD.getPropertySets(ifcType);
      const groups = Array.from(psets.entries()).map(([name, props]) => ({ name, properties: props }));
      const head = `bSDD property sets for ${ifcType} — ${groups.length} Pset(s):`;
      const lines = [head, ...groups.map((g) => `• ${g.name} (${g.properties.length} properties)`)];
      return { text: lines.join('\n'), structured: { ifcType, propertySets: groups } };
    } catch (err) {
      throw rethrowBsdd(err, 'property-set lookup');
    }
  },

  async bsdd_match(m, args) {
    // Find related bSDD classes for an entity by IFC type. Mirrors the
    // stdio MCP path: pull the entity's IFC type, then ask bSDD for related
    // dictionary classes.
    let expressId: number | null = null;
    if (typeof args.express_id === 'number') expressId = args.express_id;
    else if (typeof args.global_id === 'string') {
      const ref = resolveRef(m, args);
      expressId = ref.expressId;
    }
    if (expressId == null) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide express_id or global_id.' });
    }
    const ifcType = m.store.entities.getTypeName(expressId) ?? 'Unknown';
    try {
      const candidates = await PROXIED_BSDD.searchRelatedClasses(ifcType);
      const head = `bSDD candidates for ${ifcType} (#${expressId}) — ${candidates.length} match(es):`;
      const lines = [head, ...candidates.slice(0, 10).map((c) => `• ${c.code} — ${c.name} (${c.dictionaryUri})`)];
      if (candidates.length > 10) lines.push(`  … +${candidates.length - 10} more`);
      return { text: lines.join('\n'), structured: { ifcType, expressId, candidates } };
    } catch (err) {
      throw rethrowBsdd(err, 'related-class search');
    }
  },

  // ── Discovery (extras) ─────────────────────────────────────────────────
  async model_unload(m, args) {
    // The playground v1 design is single-model. We accept the call and
    // report it, but do NOT actually drop the model — the parent owns the
    // load lifecycle (sample picker / drop zone). Surface that contract
    // honestly instead of silently no-oping.
    const target = String(args.model_id ?? m.id);
    if (target === m.id) {
      return {
        text: `model_unload is a no-op in the web playground — close the tab or pick another sample to drop the model. (Targeted '${target}'.)`,
        structured: { modelId: target, unloaded: false, reason: 'browser-singleton' },
      };
    }
    return {
      text: `Model '${target}' isn't loaded in this session.`,
      structured: { modelId: target, unloaded: false, reason: 'not-loaded' },
    };
  },

  async model_load(_m, args) {
    // Federated load isn't wired in v1 — only the active sample is loaded.
    // Throw so the agent sees an error result and routes the user to the
    // sample picker / dropzone (or the stdio MCP).
    const path = String(args.file_path ?? '');
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: `model_load isn't supported in the web playground (single-model session). To load '${path || 'another file'}', the user picks it from the sample list or drops it on the dropzone. The stdio MCP supports federated load.`,
    });
  },

  // ── Mutation (composer) ────────────────────────────────────────────────
  async mutation_batch(m, args, ctx) {
    // Apply N ops in order. We just dispatch each op back through the
    // existing IMPLS so behaviour exactly matches calling them one by one
    // — no separate codepath to drift from. Failure stops the batch and
    // reports per-step results so the agent can decide whether to undo.
    const ops = args.operations as Array<{ tool: string; args?: Record<string, unknown> }> | undefined;
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`operations: [{tool, args}, …]` is required.' });
    }
    const results: Array<{ tool: string; ok: boolean; text: string; errorCode?: string }> = [];
    for (const op of ops) {
      const impl = IMPLS[op.tool];
      if (!impl) {
        results.push({ tool: op.tool, ok: false, text: `Unknown tool: ${op.tool}`, errorCode: ToolErrorCode.INVALID_INPUT });
        break;
      }
      try {
        const out = await impl(m, op.args ?? {}, ctx);
        results.push({ tool: op.tool, ok: true, text: out.text });
      } catch (err) {
        const code = err instanceof ToolExecutionError ? err.code : ToolErrorCode.INTERNAL_ERROR;
        results.push({ tool: op.tool, ok: false, text: err instanceof Error ? err.message : String(err), errorCode: code });
        break;
      }
    }
    const passed = results.filter((r) => r.ok).length;
    const head = passed === ops.length
      ? `Batch ok · ${passed}/${ops.length} ops applied.`
      : `Batch stopped · ${passed}/${ops.length} ops applied; the rest were skipped.`;
    const lines = [head, ...results.map((r, i) => `  ${i + 1}. ${r.ok ? 'ok' : 'fail'} — ${r.tool}: ${r.text}`)];
    return { text: lines.join('\n'), structured: { results, passed, total: ops.length } };
  },

  // ── Viewer (extras) ────────────────────────────────────────────────────
  async viewer_wait_for_selection(_m, args, ctx) {
    // Block until the user clicks something in the viewer (or timeout).
    // The viewer already exposes `setOnSelectionChange`; we register a
    // one-shot listener and resolve when it fires with a non-empty
    // selection, falling back to the timeout payload otherwise.
    const v = requireViewer(ctx);
    const timeoutMs = Math.max(500, Math.min(Number(args.timeout_ms ?? 60_000), 5 * 60_000));
    const t0 = Date.now();
    const initial = v.getSelection();
    if (initial.length > 0) {
      // Already something selected — return immediately so the agent
      // doesn't pointlessly stall.
      return {
        text: `Already selected ${initial.length} entit${initial.length === 1 ? 'y' : 'ies'}.`,
        structured: { selection: initial, waitedMs: 0, timedOut: false },
      };
    }
    const hits: import('./PlaygroundViewer').SelectionHit[] = await new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        v.setOnSelectionChange(null);
        resolve([]);
      }, timeoutMs);
      v.setOnSelectionChange((sel) => {
        if (sel.length === 0) return; // ignore deselects
        window.clearTimeout(timer);
        v.setOnSelectionChange(null);
        resolve(sel);
      });
    });
    const waitedMs = Date.now() - t0;
    if (hits.length === 0) {
      return {
        text: `Timed out after ${Math.round(waitedMs / 1000)}s with no selection.`,
        structured: { selection: [], waitedMs, timedOut: true },
      };
    }
    return {
      text: `User selected ${hits.length} entit${hits.length === 1 ? 'y' : 'ies'} (waited ${Math.round(waitedMs / 1000)}s).`,
      structured: { selection: hits, waitedMs, timedOut: false },
    };
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function resolveRef(m: LoadedPlaygroundModel, args: Record<string, unknown>): EntityRef {
  if (typeof args.express_id === 'number') {
    return { modelId: m.id, expressId: args.express_id };
  }
  if (typeof args.global_id === 'string') {
    // Linear scan — fine for v1 since we only have one model in memory.
    for (const [, ids] of m.store.entityIndex.byType) {
      for (const id of ids) {
        const node = new EntityNode(m.store, id);
        if (node.globalId === args.global_id) return { modelId: m.id, expressId: id };
      }
    }
    throw new ToolExecutionError({
      code: ToolErrorCode.ENTITY_NOT_FOUND,
      message: `No entity with GlobalId '${args.global_id}' in this model.`,
    });
  }
  throw new ToolExecutionError({
    code: ToolErrorCode.INVALID_INPUT,
    message: 'Provide either global_id or express_id.',
  });
}

function refStr(ref: EntityRef): string {
  return `#${ref.expressId} (model=${ref.modelId})`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/**
 * Pull IDS XML from whichever knob the agent reached for. The MCP wire
 * surface uses `ids_path` (a filename); we look it up in the user's
 * attached uploads via `playgroundUploads`. The agent may also pass
 * `ids_xml` as raw XML (for v0.1 compat with the Node MCP that reads
 * disk). Returns trimmed XML or null when neither knob worked.
 */
function resolveIdsXml(args: Record<string, unknown>): string | null {
  // Path-based — preferred when the user attached a .ids file. Tolerate
  // a few variant arg names the agent invents.
  const path = String(args.ids_path ?? args.path ?? args.file_path ?? '').trim();
  if (path) {
    const upload = playgroundUploads.resolve(path);
    if (upload) return upload.text.trim();
    // The agent might have referenced an old / non-existent file. Surface
    // that distinct from "no IDS at all" so it can ask the user to drop
    // the file rather than re-paste raw XML.
    throw new ToolExecutionError({
      code: ToolErrorCode.ENTITY_NOT_FOUND,
      message: `No attached file matches '${path}'. Tell the user to drag the .ids onto the chat input, then retry.`,
    });
  }
  // Direct XML — works without an upload.
  const xml = String(args.ids_xml ?? args.ids ?? '').trim();
  if (xml) return xml;
  return null;
}

/**
 * Strip whatever extension the agent supplied (or any odd path components)
 * and force the canonical one for the artifact this tool actually produces.
 *
 * The agent loves to invent filenames like `wall_fire_rating.ids` when the
 * user asks "save the wall fire ratings" — but `model_save` writes IFC,
 * `bcf_export` writes BCFZIP, `ids_validate` writes a JSON report. Trusting
 * the agent's extension means the user clicks Save IFC and gets a `.ids`
 * file the OS won't recognise. Always enforce.
 *
 *   coerceFilename('wall_fire_rating.ids', 'ifc')   → 'wall_fire_rating.ifc'
 *   coerceFilename('/tmp/foo.bar/baz.csv', 'json')  → 'baz.json'
 *   coerceFilename(undefined, 'bcfzip', 'issues')   → 'issues.bcfzip'
 */
function coerceFilename(
  raw: string | undefined,
  ext: 'ifc' | 'bcfzip' | 'csv' | 'json',
  fallbackBase: string,
): string {
  // Lift the basename out of any path the agent supplied.
  let base = (typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : '').trim();
  if (!base) base = fallbackBase;
  // Drop any extension already on it (incl. multi-dot like .bcf.zip).
  base = base.replace(/\.(ifc|ifczip|bcfzip|bcf|zip|csv|json|tsv|xml|ids|gltf|glb|ifcx|pdf)$/i, '');
  base = base.replace(/[^\w.\-]+/g, '_'); // sanitize for OS download
  if (!base) base = fallbackBase;
  return `${base}.${ext}`;
}

/** Resolve (left, right) diff models from the dispatch context. The agent
 *  passes `a` / `b` model_ids; we look them up in the registry, falling
 *  back to the primary model for one side if the agent only provided the
 *  other id (rare, but lets the chat work with a single loaded model). */
function resolveDiffModels(
  primary: LoadedPlaygroundModel,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): { left: LoadedPlaygroundModel; right: LoadedPlaygroundModel } {
  const aId = String(args.a ?? '');
  const bId = String(args.b ?? '');
  if (!aId || !bId) {
    throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: 'Both `a` and `b` model_ids are required. Load a second model first.',
    });
  }
  const left = aId === primary.id ? primary : ctx.registry?.get(aId);
  const right = bId === primary.id ? primary : ctx.registry?.get(bId);
  if (!left || !right) {
    throw new ToolExecutionError({
      code: ToolErrorCode.MODEL_NOT_FOUND,
      message: `Both models must be loaded; missing: ${[!left && aId, !right && bId].filter(Boolean).join(', ')}`,
    });
  }
  return { left, right };
}

/** Build the IDS validator's data accessor from a loaded model. Implements
 *  the full IFCDataAccessor surface @ifc-lite/ids expects (see
 *  packages/ids/src/types.ts:384). Each method bridges to the SDK's bim
 *  namespaces or directly to EntityNode. */
function makeIdsAccessor(m: LoadedPlaygroundModel): import('@ifc-lite/ids').IFCDataAccessor {
  const ref = (id: number): EntityRef => ({ modelId: m.id, expressId: id });
  return {
    getEntityType(id) {
      try { return new EntityNode(m.store, id).type; } catch { return undefined; }
    },
    getEntityName(id) {
      try { return new EntityNode(m.store, id).name || undefined; } catch { return undefined; }
    },
    getGlobalId(id) {
      try { return new EntityNode(m.store, id).globalId || undefined; } catch { return undefined; }
    },
    getDescription(id) {
      try { return new EntityNode(m.store, id).description || undefined; } catch { return undefined; }
    },
    getObjectType(id) {
      try { return new EntityNode(m.store, id).objectType || undefined; } catch { return undefined; }
    },
    getEntitiesByType(typeName) {
      const wantedUpper = typeName.toUpperCase();
      const out: number[] = [];
      for (const [t, ids] of m.store.entityIndex.byType) {
        if (t.toUpperCase() === wantedUpper) for (const id of ids) out.push(id);
      }
      return out;
    },
    getAllEntityIds() {
      const out: number[] = [];
      for (const id of m.store.entityIndex.byId.keys()) out.push(id);
      return out;
    },
    getPropertyValue(id, psetName, propName) {
      const v = m.bim.property(ref(id), psetName, propName);
      if (v == null) return undefined;
      return { value: v, dataType: typeof v === 'number' ? 'IFCREAL' : typeof v === 'boolean' ? 'IFCBOOLEAN' : 'IFCLABEL', propertySetName: psetName, propertyName: propName };
    },
    getPropertySets(id) {
      return m.bim.properties(ref(id)).map((pset) => ({
        name: pset.name,
        properties: pset.properties.map((p) => ({
          name: p.name,
          value: p.value as string | number | boolean | null,
          dataType: typeof p.value === 'number' ? 'IFCREAL' : typeof p.value === 'boolean' ? 'IFCBOOLEAN' : 'IFCLABEL',
        })),
      }));
    },
    getClassifications(id) {
      return m.bim.classifications(ref(id)).map((c) => ({
        system: c.system ?? '',
        value: c.identification ?? c.name ?? '',
        name: c.name,
      }));
    },
    getMaterials(id) {
      const mat = m.bim.materials(ref(id));
      if (!mat) return [];
      const layers = (mat as { layers?: Array<{ materialName?: string; name?: string }>; name?: string });
      if (Array.isArray(layers.layers) && layers.layers.length > 0) {
        return layers.layers.map((l) => ({ name: l.materialName ?? l.name ?? '' }));
      }
      if (layers.name) return [{ name: layers.name }];
      return [];
    },
    getParent(id) {
      try {
        const parent = new EntityNode(m.store, id).containedIn() ?? new EntityNode(m.store, id).decomposedBy();
        if (!parent) return undefined;
        return { expressId: parent.expressId, entityType: parent.type ?? '' };
      } catch { return undefined; }
    },
    getAttribute(id, attributeName) {
      const attrs = m.bim.attributes(ref(id));
      const found = attrs.find((a) => a.name === attributeName);
      return found ? String(found.value) : undefined;
    },
  };
}

/** Tiny RFC4122-ish v4 UUID. Browsers ship crypto.randomUUID but TypeScript
 *  lib.dom doesn't always type it; fall back to a Math.random implementation
 *  for ancient browsers. */
function cryptoRandomUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

interface BsddHttpErrorLike {
  name: string;
  status: number;
  retryAfterSeconds?: number;
  url: string;
  statusText: string;
}
function rethrowBsdd(err: unknown, label: string): ToolExecutionError {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'BsddHttpError') {
    const e = err as BsddHttpErrorLike;
    if (e.status === 429) {
      return new ToolExecutionError({
        code: ToolErrorCode.RATE_LIMITED,
        message: `bSDD rate-limited the ${label} request (HTTP 429).`,
        details: { url: e.url, status: e.status, retryAfterSeconds: e.retryAfterSeconds },
        hint: e.retryAfterSeconds != null ? `Retry after ${e.retryAfterSeconds}s.` : 'Avoid back-to-back bSDD calls.',
      });
    }
    return new ToolExecutionError({
      code: ToolErrorCode.EXTERNAL_SERVICE_FAILED,
      message: `bSDD ${label} failed: HTTP ${e.status} ${e.statusText}.`,
      details: { url: e.url, status: e.status },
    });
  }
  if (err instanceof ToolExecutionError) return err;
  return new ToolExecutionError({
    code: ToolErrorCode.INTERNAL_ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
}

// ── public API ─────────────────────────────────────────────────────────────

/** All tool names the playground knows how to execute (for the chat tools[] list). */
export function supportedToolNames(): string[] {
  return Object.keys(IMPLS);
}

/** Anthropic-compatible JSON schema for a single tool's input. */
export interface AnthropicInputSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: AnthropicInputSchema;
}

/** Build the `tools` array Anthropic expects, derived from CATALOG +
 *  supportedToolNames(). Always returns the literal-typed shape Anthropic's
 *  SDK demands (input_schema.type === 'object'). */
export function anthropicToolDefinitions(): AnthropicToolDef[] {
  const supported = new Set(supportedToolNames());
  return CATALOG.tools
    .filter((t: CatalogTool) => supported.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: ensureObjectSchema(t),
    }));
}

/** Anthropic requires every tool's input_schema.type === 'object'. Some catalog
 *  schemas are missing `properties` — fill in a minimal one from paramsFor(). */
function ensureObjectSchema(tool: CatalogTool): AnthropicInputSchema {
  const raw = tool.inputSchema as { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | undefined;
  if (raw && raw.type === 'object' && raw.properties && Object.keys(raw.properties).length > 0) {
    const properties: AnthropicInputSchema['properties'] = {};
    for (const [k, v] of Object.entries(raw.properties)) {
      properties[k] = { type: typeof v?.type === 'string' ? v.type : 'string', ...(v?.description ? { description: v.description } : {}) };
    }
    return {
      type: 'object',
      properties,
      ...(Array.isArray(raw.required) && raw.required.length > 0 ? { required: raw.required } : {}),
    };
  }
  const params = paramsFor(tool);
  const properties: AnthropicInputSchema['properties'] = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = { type: jsonSchemaType(p.type), ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function jsonSchemaType(t: string): string {
  if (t.startsWith('integer')) return 'integer';
  if (t.startsWith('number')) return 'number';
  if (t.startsWith('boolean')) return 'boolean';
  if (t.endsWith('[]') || t.startsWith('Array<')) return 'array';
  if (t.startsWith('{') || t.startsWith('object')) return 'object';
  return 'string';
}

/**
 * Run a single tool call against the loaded model. Mirrors the wire-format
 * shape of an MCP tools/call result so the chat panel renderer doesn’t have
 * to know the dispatcher is local.
 *
 * The optional `ctx` carries the live viewer controller; tools that touch
 * the inline 3D panel (viewer_*) require it. When a non-viewer tool is
 * called the context is harmlessly ignored.
 */
export async function dispatch(
  model: LoadedPlaygroundModel,
  toolName: string,
  args: Record<string, unknown>,
  ctx: DispatchContext = {},
): Promise<ToolDispatchResult> {
  const tool = CATALOG.tools.find((t) => t.name === toolName);
  if (!tool) {
    return {
      text: `Unknown tool: ${toolName}`,
      structured: null,
      isError: true,
      errorCode: ToolErrorCode.INVALID_INPUT,
    };
  }
  // The v2 surface includes mutate, BCF, IDS, export, diff. Anything with
  // an entry in IMPLS is wired client-side; the catalogue still includes
  // a few v0.2 / v0.5 entries (export_glb, export_ifcx, export_pdf_report)
  // that aren't implemented yet — those fall through to the
  // UNSUPPORTED_OPERATION branch below.
  const impl = IMPLS[toolName];
  if (!impl) {
    return {
      text: `${toolName} isn’t implemented in the web playground yet. (See the catalogue for the full surface — the stdio MCP supports it.)`,
      structured: { code: ToolErrorCode.UNSUPPORTED_OPERATION },
      isError: true,
      errorCode: ToolErrorCode.UNSUPPORTED_OPERATION,
    };
  }
  try {
    const out = await impl(model, args, ctx);
    return { text: out.text, structured: out.structured, isError: false, download: out.download };
  } catch (err) {
    if (err instanceof ToolExecutionError) {
      return {
        text: err.message,
        structured: err.details ?? null,
        isError: true,
        errorCode: err.code,
        hint: err.hint,
      };
    }
    return {
      text: err instanceof Error ? err.message : String(err),
      structured: null,
      isError: true,
      errorCode: ToolErrorCode.INTERNAL_ERROR,
    };
  }
}
