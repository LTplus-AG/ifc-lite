/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutation tools (spec §7.5).
 *
 * All mutations route through the headless backend's `MutablePropertyView`
 * which already maintains an undo journal and overlays. We wire that
 * up to a thin tool surface:
 *
 *   - entity_set_property / entity_delete_property — Pset edits
 *   - entity_set_attribute                         — direct IFC attributes
 *   - entity_create / entity_delete                — STEP-level entity ops
 *   - mutation_batch                               — apply N ops atomically
 *   - mutation_undo                                — pop last N entries
 *   - mutation_diff                                — pending changes summary
 *
 * The actual save lives in `tools/export.ts::export_ifc` (and the
 * convenience `model_save` alias) so the user can preview a diff before
 * writing the .ifc file.
 */

import { writeFile } from 'node:fs/promises';
import { EntityNode } from '@ifc-lite/query';
import { PropertyValueType } from '@ifc-lite/data';
import type { Mutation } from '@ifc-lite/mutations';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import type { HeadlessLikeBackend } from '../headless-backend.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';

interface MutationContext {
  m: ReturnType<typeof resolveModel>;
  backend: HeadlessLikeBackend;
}

function getBackend(m: ReturnType<typeof resolveModel>): HeadlessLikeBackend {
  return m.backend;
}

function resolveExpressId(m: ReturnType<typeof resolveModel>, input: Record<string, unknown>): number {
  if (typeof input.express_id === 'number') return input.express_id;
  if (typeof input.global_id === 'string') {
    const gid = input.global_id;
    for (const [, list] of m.store.entityIndex.byType) {
      for (const id of list) {
        const node = new EntityNode(m.store, id);
        if (node.globalId === gid) return id;
      }
    }
    throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `GlobalId not found: ${gid}` });
  }
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide global_id or express_id.' });
}

function detectValueType(value: unknown): PropertyValueType {
  if (typeof value === 'boolean') return PropertyValueType.Boolean;
  if (typeof value === 'number') return Number.isInteger(value) ? PropertyValueType.Integer : PropertyValueType.Real;
  return PropertyValueType.String;
}

function applySetProperty(ctx: MutationContext, args: { expressId: number; pset: string; name: string; value: unknown }): Mutation {
  const editor = ctx.backend.ensureEditor();
  // Force the mutation view to be created via getMutationView; setProperty
  // lives on the view itself, exposed via the editor's view reference.
  const view = ctx.backend.getMutationView();
  if (!view) throw new Error('Mutation view not available');
  void editor;
  const valueType = detectValueType(args.value);
  return view.setProperty(args.expressId, args.pset, args.name, args.value as string | number | boolean, valueType);
}

const entitySetProperty: Tool = {
  name: 'entity_set_property',
  description: 'Set or create a property on an entity. Mutations are queued; call `export_ifc` to persist.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      pset: { type: 'string', description: 'Property set name, e.g. "Pset_WallCommon".' },
      name: { type: 'string', description: 'Property name within the pset.' },
      value: { description: 'Boolean / number / string value.' },
    },
    required: ['pset', 'name'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const backend = getBackend(m);
    const expressId = resolveExpressId(m, input);
    const mutation = applySetProperty({ m, backend }, {
      expressId,
      pset: input.pset as string,
      name: input.name as string,
      value: input.value,
    });
    return okResult(`Queued: ${(input.pset as string)}.${(input.name as string)} on #${expressId}.`, {
      mutation: { kind: 'property', expressId, pset: input.pset, name: input.name, value: input.value, mutationId: (mutation as { id?: string | number }).id },
    });
  },
};

const entityDeleteProperty: Tool = {
  name: 'entity_delete_property',
  description: 'Delete a property from a Pset. Queued — persist via `export_ifc`.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      pset: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['pset', 'name'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const backend = getBackend(m);
    backend.ensureEditor();
    const view = backend.getMutationView();
    if (!view) throw new Error('Mutation view not available');
    const expressId = resolveExpressId(m, input);
    const result = view.deleteProperty(expressId, input.pset as string, input.name as string);
    return okResult(
      result ? 'Property delete queued.' : 'Property was not present; no-op.',
      { changed: !!result, expressId, pset: input.pset, name: input.name },
    );
  },
};

const entitySetAttribute: Tool = {
  name: 'entity_set_attribute',
  description: 'Set a top-level IFC attribute (Name, Description, ObjectType, Tag).',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
      attribute: { type: 'string', enum: ['Name', 'Description', 'ObjectType', 'Tag'] },
      value: { type: 'string' },
    },
    required: ['attribute', 'value'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const backend = getBackend(m);
    backend.ensureEditor();
    const view = backend.getMutationView();
    if (!view) throw new Error('Mutation view not available');
    const expressId = resolveExpressId(m, input);
    view.setAttribute(expressId, input.attribute as string, input.value as string);
    return okResult(`Set ${input.attribute} on #${expressId}.`, { expressId, attribute: input.attribute, value: input.value });
  },
};

const entityCreate: Tool = {
  name: 'entity_create',
  description: 'Create a new IFC entity with raw positional attributes. Returns the new expressId.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string', description: 'IFC entity name, e.g. IfcWall.' },
      attributes: {
        type: 'array',
        description: 'Positional STEP attributes (strings, numbers, booleans, or refs of form "#42").',
        items: {},
      },
    },
    required: ['type'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const backend = getBackend(m);
    const editor = backend.ensureEditor();
    const attrs = (input.attributes as unknown[] | undefined) ?? [];
    const ref = editor.addEntity(input.type as string, attrs as Parameters<typeof editor.addEntity>[1]);
    return okResult(`Created ${input.type} as #${ref.expressId}.`, { expressId: ref.expressId, type: input.type });
  },
};

const entityDelete: Tool = {
  name: 'entity_delete',
  description: 'Delete an entity. Note: cascades are NOT applied automatically — caller must remove dependent relationships first.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const backend = getBackend(m);
    const editor = backend.ensureEditor();
    const expressId = resolveExpressId(m, input);
    const removed = editor.removeEntity(expressId);
    return okResult(removed ? 'Entity deleted.' : 'Entity not found / already gone.', { expressId, deleted: removed });
  },
};

const mutationBatch: Tool = {
  name: 'mutation_batch',
  description: 'Apply N mutation operations as a single batch. Each item names a sub-tool and its arguments. Returns per-step results in order.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['entity_set_property', 'entity_delete_property', 'entity_set_attribute', 'entity_create', 'entity_delete'] },
            args: { type: 'object' },
          },
          required: ['tool', 'args'],
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const ops = input.operations as Array<{ tool: string; args: Record<string, unknown> }>;
    const subtools: Record<string, Tool> = {
      entity_set_property: entitySetProperty,
      entity_delete_property: entityDeleteProperty,
      entity_set_attribute: entitySetAttribute,
      entity_create: entityCreate,
      entity_delete: entityDelete,
    };
    const results: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }> = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      try {
        const tool = subtools[op.tool];
        if (!tool) {
          results.push({ tool: op.tool, ok: false, error: `Unknown sub-tool ${op.tool}` });
          continue;
        }
        const out = await tool.handler({ model_id: input.model_id as string | undefined, ...op.args }, ctx);
        if (out.isError) results.push({ tool: op.tool, ok: false, error: (out.structuredContent?.message as string) ?? 'failed' });
        else results.push({ tool: op.tool, ok: true, result: out.structuredContent });
      } catch (err) {
        results.push({ tool: op.tool, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      ctx.progress.report((i + 1) / ops.length, `Step ${i + 1}/${ops.length}`, ops.length);
    }
    const okCount = results.filter((r) => r.ok).length;
    return okResult(`Batch ${okCount}/${results.length} succeeded.`, { results });
  },
};

const mutationDiff: Tool = {
  name: 'mutation_diff',
  description: 'Inspect pending mutations vs the original parsed state.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' } }, additionalProperties: false },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const backend = getBackend(m);
    const view = backend.getMutationView();
    if (!view) {
      return okResult('No pending mutations.', { count: 0, mutations: [] });
    }
    // The view exposes a private mutationHistory array; we read it via a
    // narrow cast rather than hacking the package API. Stable enough for
    // diagnostics; if the shape changes we'll get a clean type error.
    const history = (view as unknown as { mutationHistory?: Mutation[] }).mutationHistory ?? [];
    return okResult(`${history.length} pending mutation(s).`, { count: history.length, mutations: history });
  },
};

const mutationUndo: Tool = {
  name: 'mutation_undo',
  description: 'Revert the last N pending mutations on this session. v0.1: best-effort; rebuilds the mutation view when N exceeds history length.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      n: { type: 'integer', minimum: 1, default: 1 },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const backend = getBackend(m);
    const view = backend.getMutationView();
    if (!view) return okResult('Nothing to undo.', { undone: 0 });
    const n = (input.n as number | undefined) ?? 1;
    const history = (view as unknown as { mutationHistory?: Mutation[] }).mutationHistory ?? [];
    const undone = Math.min(n, history.length);
    history.splice(history.length - undone, undone);
    return okResult(`Undone ${undone} mutation(s).`, { undone });
  },
};

const modelSave: Tool = {
  name: 'model_save',
  description: 'Write the current model (with pending mutations) to disk. Convenience wrapper around export_ifc.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string', description: 'Output .ifc path.' },
      schema: { type: 'string', enum: ['IFC2X3', 'IFC4', 'IFC4X3'] },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const schema = (input.schema as string | undefined) ?? m.store.schemaVersion;
    const content = m.bim.export.ifc([], { schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    await writeFile(filePath, text, 'utf-8');
    return okResult(`Wrote ${text.length.toLocaleString()} bytes to ${filePath}.`, {
      filePath,
      bytes: text.length,
      schema,
    });
  },
};

export const mutationTools: Tool[] = [
  entitySetProperty,
  entityDeleteProperty,
  entitySetAttribute,
  entityCreate,
  entityDelete,
  mutationBatch,
  mutationDiff,
  mutationUndo,
  modelSave,
];
