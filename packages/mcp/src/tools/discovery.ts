/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Discovery & metadata tools (spec §7.1).
 *
 * These are the always-on, read-only tools an agent calls first to figure
 * out what models are loaded and what's in them.
 */

import { withSourceWriteLock } from '../source-write-lock.js';
import {
  extractGeoreferencingOnDemand,
  extractLengthUnitScale,
  getAllAttributesForEntity,
  getEntityMetadata,
  getInheritanceChainAcrossSchemas,
  getInheritanceChainForEntity,
} from '@ifc-lite/parser';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { entityInfoAcrossSchemas, entityInfoInSchema } from '@ifc-lite/sdk/headless';
import { foldedEntityCount, foldedTypeCounts, pendingMutationsField, pendingOverlay } from '@ifc-lite/sdk/headless';
import type { Tool } from './types.js';
import { fmtInt, resolveModel, okResult } from './util.js';
import { basename } from 'node:path';
import { openOciModel, parseModelReference } from '@ifc-lite/oci/node-model';
import { deriveModelId, loadIfcModel, loadIfcModelFromBytes } from '../loader.js';
import { resolveSafePath } from '../safe-path.js';
import { modelAllowed, scopeAllows, type AuthScope } from '../auth/scope.js';
import type { ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

export const modelInfo: Tool = {
  name: 'model_info',
  description: 'Return schema, entity counts, file metadata, georeferencing, and units for the active (or named) model.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Model identifier. Optional when only one model is loaded.' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const georef = extractGeoreferencingOnDemand(m.store);
    const lengthScale = m.store.source && m.store.entityIndex
      ? extractLengthUnitScale(m.store.source, m.store.entityIndex)
      : 1.0;

    // A model_id names a session, not a file: the counts have to include what
    // `entity_create` queued and exclude what `entity_delete` tombstoned (#2004),
    // or an agent that just created a wall is told the model still has the old
    // number and that its edit did not happen.
    const overlay = pendingOverlay(m);
    const typeCounts = foldedTypeCounts(m.store, overlay);
    const entityCount = foldedEntityCount(m.store, overlay);

    const summary = `Model '${m.name}' (${m.store.schemaVersion}): ${fmtInt(entityCount)} entities, ${(m.store.fileSize / 1024).toFixed(1)} KB`
      + (overlay ? `, including ${overlay.pendingMutations} unsaved mutation(s)` : '');
    return okResult(summary, {
      id: m.id,
      name: m.name,
      schema: m.store.schemaVersion,
      entityCount,
      // `fileSize` deliberately stays the size of the file on disk: nothing has
      // been written yet, and this field says how big the parsed input was.
      fileSize: m.store.fileSize,
      filePath: m.filePath,
      loadedAt: m.loadedAt,
      lengthUnitScale: lengthScale,
      georeferencing: georef ?? null,
      // PascalCase, matching `model_diff`'s type table and `count_entities`.
      typeCountsTop20: [...typeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([type, count]) => ({ type: IFC_ENTITY_NAMES[type] ?? type, count })),
      typeCountsTotal: typeCounts.size,
      ...pendingMutationsField(overlay),
    });
  },
};

export const modelList: Tool = {
  name: 'model_list',
  description: 'List all currently loaded models with metadata.',
  scope: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    // Filter to models the caller's scope allows so a per-model allowlist is
    // not leaked via enumeration.
    const list = ctx.registry.list().filter((m) => modelAllowed(ctx.scope, m.id));
    return okResult(
      list.length === 0
        ? 'No models currently loaded.'
        : `${list.length} model${list.length === 1 ? '' : 's'} loaded.`,
      {
        count: list.length,
        models: list.map((m) => {
          // The same count `model_info` reports, computed the same way (#2014).
          // Two tools naming one number differently for the same model is the
          // defect, whichever of them is right.
          const overlay = pendingOverlay(m);
          return {
            id: m.id,
            name: m.name,
            schema: m.store.schemaVersion,
            entityCount: foldedEntityCount(m.store, overlay),
            fileSize: m.store.fileSize,
            filePath: m.filePath,
            loadedAt: m.loadedAt,
            ...pendingMutationsField(overlay),
          };
        }),
      },
    );
  },
};

export const modelLoad: Tool = {
  name: 'model_load',
  description: 'Load IFC STEP, IFCZIP or IFCX from an allowed local path. Loading from an allowed OCI registry also requires mutate scope.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute local model path or an oci:// reference.' },
      model_id: { type: 'string', description: 'Optional explicit ID. Defaults to a slug of the file name.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const source = input.file_path;
    const modelId = input.model_id as string | undefined;
    const oci = typeof source === 'string' && source.startsWith('oci://');
    let label = String(source);
    try {
      const loaded = await withSourceWriteLock(ctx.registry, async () => {
        assertModelLoadAccess(modelId, ctx, oci);
        let model;
        if (oci) {
          const { registry } = parseModelReference(source);
          const allowed = ctx.config.ociHosts ?? process.env.IFC_LITE_MCP_OCI_HOSTS?.split(',') ?? [];
          if (!allowed.some((host) => host.trim().toLowerCase() === registry)) {
            throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: `OCI registry '${registry}' is outside the configured OCI hosts.` });
          }
          const { bytes, name } = await openOciModel(source);
          const id = modelId ?? deriveModelId(name);
          assertModelLoadAccess(id, ctx, oci);
          model = await loadIfcModelFromBytes(bytes, name, id, source);
        } else {
          label = await resolveSafePath(source, ctx, 'read');
          const id = modelId ?? deriveModelId(basename(label));
          assertModelLoadAccess(id, ctx, oci);
          model = await loadIfcModel(label, { modelId: id, allowedPaths: [label] });
        }
        // The scope, pending edits or cancellation can change during the parse.
        try {
          assertModelLoadAccess(model.id, ctx, oci);
        } catch (refused) {
          try {
            model.backend.dispose();
          } catch (disposeError) {
            ctx.log.log('warning', 'model_load: dispose after refusal failed', { error: String(disposeError) });
          }
          throw refused;
        }
        ctx.registry.add(model);
        return model;
      });
      ctx.log.log('info', 'model_load', { id: loaded.id, file: label, entities: loaded.store.entityCount });
      // A model the scan read short is reported as such, in the text the
      // agent reads and in the structured result (#7610).
      const warnings = loaded.scanWarnings ?? [];
      return okResult(
        `Loaded '${loaded.name}' as model '${loaded.id}' (${fmtInt(loaded.store.entityCount)} entities).` +
          warnings.map((w) => `\nWarning: ${w}`).join(''),
        {
          id: loaded.id, name: loaded.name, schema: loaded.store.schemaVersion, entityCount: loaded.store.entityCount,
          ...(warnings.length > 0 ? { scanWarnings: warnings } : {}),
        },
      );
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError({
        code: ToolErrorCode.PARSE_FAILED,
        message: `Failed to load '${label}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
};

function assertModelLoadAccess(id: string | undefined, ctx: ToolContext, oci: boolean): void {
  if (ctx.signal.aborted) {
    throw new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message: 'model_load was cancelled.' });
  }
  const live = ctx.currentScope?.() ?? ctx.scope;
  if (!scopeAllows(live, 'read')) {
    throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: 'This token no longer has read scope.' });
  }
  if (oci && !scopeAllows(live, 'mutate')) {
    throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: 'Loading an OCI model requires mutate scope.' });
  }
  if (id !== undefined) {
    assertMayLoadAs(id, ctx, live);
    assertMayDiscard(id, ctx, live);
  }
}

/**
 * `model_load` needs only `read` scope (#11534), so it must not become a way
 * around the token's model allowlist: the registry disposes a model it
 * replaces, so loading under an id the token may not access is refused.
 * Replacing or dropping a model with unsaved edits needs `mutate` (see
 * assertMayDiscard): a session narrowed after editing must not lose the edits.
 */
function assertMayLoadAs(id: string, ctx: ToolContext, scope = ctx.scope): void {
  if (!modelAllowed(scope, id)) {
    throw new ToolExecutionError({
      code: ToolErrorCode.PERMISSION_DENIED,
      message: `Access to model '${id}' is not permitted for this token.`,
    });
  }
}

/**
 * Unloading or replacing a model throws away its unsaved edits. A caller that
 * could not have made them (no `mutate` in the live scope, e.g. after setScope
 * narrowed the session) may not discard them.
 */
function assertMayDiscard(id: string, ctx: ToolContext, scope: AuthScope): void {
  const existing = ctx.registry.get(id);
  if (!existing || scopeAllows(scope, 'mutate')) return;
  if ((pendingOverlay(existing)?.pendingMutations ?? 0) > 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.PERMISSION_DENIED,
      message: `Model '${id}' has unsaved edits; dropping or replacing it needs mutate scope. Exporting keeps a copy but does not clear them; load the file under another model_id, or use a token with mutate scope.`,
    });
  }
}

export const modelUnload: Tool = {
  name: 'model_unload',
  description: 'Drop a model from session memory. Unsaved edits to it are lost.',
  // `read` for the same reason as `model_load`: it frees session memory and
  // writes nothing. A token narrowed to some models still cannot drop others.
  scope: 'read',
  // Read scope, but it drops unsaved edits, so clients should still ask.
  annotations: { destructiveHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Model identifier.' },
    },
    required: ['model_id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = input.model_id as string;
    // One live scope for every check (setScope may have narrowed it).
    const live = ctx.currentScope?.() ?? ctx.scope;
    // Allowlist first, so a narrowed token cannot probe which ids are loaded.
    assertMayLoadAs(id, ctx, live);
    if (!ctx.registry.get(id)) {
      throw new ToolExecutionError({
        code: ToolErrorCode.MODEL_NOT_FOUND,
        message: `Model '${id}' is not loaded.`,
      });
    }
    assertMayDiscard(id, ctx, live);
    ctx.registry.remove(id);
    return okResult(`Unloaded model '${id}'.`, { id });
  },
};

/**
 * Every bundled schema's entity table, keyed uppercase. Built on first miss and
 * never on the hot path: the IFC4_ADD2_TC1 codegen pin answers every question
 * this tool gets about a modern file, and this is only consulted for the
 * classes it does not carry.
 */
/**
 * The inheritance chain in this tool's documented root→leaf order.
 *
 * **The pin answers first, and that is deliberate** (#2003). The two chain
 * functions do not merely differ in order — they differ in *content* for 62 of
 * the 776 pinned classes, because the schema union lets IFC4X3 win a name
 * collision: `IfcBeam`'s supertype is `IfcBuildingElement` in IFC4 and
 * `IfcBuiltElement` in IFC4X3, and IFC4X3 inserts `IfcFacility` above
 * `IfcBuilding`. Answering `IfcBuiltElement` for an IFC4 `IfcBeam` would be a
 * new wrong answer traded for an old one, so the union only fills the gap the
 * pin leaves: the 23 IFC2X3 and 77 IFC4X3 `IfcObjectDefinition` classes (39 and
 * 80 `IfcRoot` ones) it has no row for at all, which this tool used to reject
 * outright as "unknown IFC entity type".
 *
 * The union walk is leaf→root while the pin is root→leaf, and the union walker
 * falls back to the pin, which would flip it back — so normalise by finding the
 * leaf, never by index. See
 * `packages/parser/test/inheritance-chain-equivalence.test.ts`.
 */
function inheritanceChainRootToLeaf(type: string): string[] {
  const pinned = getInheritanceChainForEntity(type);
  if (pinned.length > 0) return pinned;
  const chain = getInheritanceChainAcrossSchemas(type);
  if (chain.length < 2) return chain;
  return chain[0].toUpperCase() === type.toUpperCase() ? [...chain].reverse() : chain;
}

export const schemaDescribe: Tool = {
  name: 'schema_describe',
  description: 'Describe an IFC entity type: attributes, parents, inheritance chain. Useful for an agent to know the legal shape before mutating. '
    + 'Classes outside the IFC4_ADD2_TC1 codegen pin (IFC2X3-only and IFC4X3-only ones) are answered from the bundled schema union, '
    + 'which carries names but not attribute types — `schemaSource` says which table answered.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'IFC entity name, e.g. IfcWall.' },
      include_inherited: { type: 'boolean', default: true, description: 'Include attributes inherited from parent entities.' },
    },
    required: ['type'],
    additionalProperties: false,
  },
  handler(input) {
    const type = input.type as string;
    const includeInherited = (input.include_inherited as boolean | undefined) ?? true;
    const meta = getEntityMetadata(type);
    if (meta) {
      const attrs = includeInherited ? getAllAttributesForEntity(type) : meta.attributes;
      return okResult(
        `${type}: ${attrs.length} attributes, parent ${meta.parent ?? '(root)'}, abstract=${meta.isAbstract}.`,
        {
          type: meta.name,
          parent: meta.parent ?? null,
          isAbstract: meta.isAbstract,
          inheritanceChain: inheritanceChainRootToLeaf(type),
          attributes: attrs,
          schemaSource: 'IFC4_ADD2_TC1',
        },
      );
    }

    // Outside the pin: IFC2X3-only classes an agent can legitimately have just
    // found with `query_entities` on an IFC2X3 file, and IFC4X3 infrastructure
    // leaves. The union knows their name, parent, abstractness and attribute
    // order — not attribute types — so those are reported as names alone rather
    // than invented.
    const resolved = entityInfoAcrossSchemas(type);
    if (!resolved) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Unknown IFC entity type: '${type}'`,
        hint: 'Use canonical PascalCase names like IfcWall, IfcDoor.',
      });
    }
    const { info, schema } = resolved;
    const chain = inheritanceChainRootToLeaf(info.name);
    // `IfcEntityInfo.attributes` is already the inherited + direct list in
    // declaration order, so `include_inherited: false` has to subtract the
    // parent's rather than add to the leaf's — and the parent has to come from
    // the schema that declared this class, not from a merged map that may hold
    // a different schema's version of it.
    const parent = info.parent
      ? (entityInfoInSchema(info.parent, schema) ?? entityInfoAcrossSchemas(info.parent)?.info)
      : undefined;
    // Subtract the parent's names as a *prefix*, not as a count. Resolving the
    // parent in the leaf's own schema already fixes the common case, but a
    // schema that declares a leaf without declaring its parent still falls back
    // to another schema's row — and then a count could cut into the leaf's own
    // attributes. A prefix walk cannot: it stops at the first name that differs.
    let inherited = 0;
    const parentNames = parent?.attributes ?? [];
    while (inherited < parentNames.length
      && inherited < info.attributes.length
      && parentNames[inherited] === info.attributes[inherited]) {
      inherited++;
    }
    const names = includeInherited ? [...info.attributes] : info.attributes.slice(inherited);
    return okResult(
      `${info.name}: ${names.length} attributes, parent ${info.parent ?? '(root)'}, abstract=${info.abstract}. `
      + `Outside the IFC4 schema pin — described from ${schema}, names only, no attribute types.`,
      {
        type: info.name,
        parent: info.parent ?? null,
        isAbstract: info.abstract,
        inheritanceChain: chain,
        attributes: names.map((name) => ({ name })),
        schemaSource: 'bundled-schema-union',
      },
    );
  },
};

export const discoveryTools: Tool[] = [
  modelInfo,
  modelList,
  modelLoad,
  modelUnload,
  schemaDescribe,
];
