/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Agent draft-layer lifecycle tools (spec 06-agents.md §6.2/§6.3):
 *
 *   create_draft_layer → n × draft_apply_ops → publish_layer
 *
 * Every mutation lands in a draft (a CRDT session bound to a base);
 * publishing freezes it into an immutable, content-addressed,
 * provenance-stamped layer. Scope claims are enforced twice: per op at
 * write time (before the Y.Doc is touched) and re-verified against the
 * frozen layer at publish time (`scope_verified` + `mismatches`).
 */

import {
  createEntity,
  deleteEntity,
  entityToJSON,
  getEntity,
  hasEntity,
  publishLayer,
  setAttribute,
} from '@ifc-lite/collab';
import { parseScopeClaims } from '@ifc-lite/extensions';
import { ATTR, isTypedPropertyValue, type TypedPropertyValue } from '@ifc-lite/ifcx';
import type * as Y from 'yjs';
import type { Tool } from './types.js';
import type { ToolContext } from '../context.js';
import { okResult, fmtCount } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import {
  createDraft,
  getLayerWorkspace,
  resolveBase,
} from './layer-store.js';
import { requireOwnedDraft } from './layer-access.js';
import type { DraftLayer } from './layer-store.js';
import {
  assertOpWithinClaims,
  descriptorForDraftOp,
  verifyLayerAgainstClaims,
} from './layer-ops.js';
import type { DraftOpInput } from './layer-ops.js';

/**
 * Attribute key a `set_property` op writes. Carries the Pset/Qto name so
 * the merge engine groups it under `pset:<name>` and publish-time
 * verification re-derives `model.mutate:<name>` from the key.
 */
function psetAttributeKey(pset: string, prop: string): string {
  return `bsi::ifc::v5a::${pset}::${prop}`;
}

/**
 * Canonical wire shape for property values (#1031): scalars are wrapped
 * in the typed record the collab snapshot pipeline emits, so equivalent
 * edits hash identically in the merge engine regardless of which writer
 * produced them. Already-typed records pass through; anything else
 * (arrays, foreign objects, null) is written verbatim.
 */
function typedPropertyRecord(value: unknown): unknown {
  if (isTypedPropertyValue(value)) return value;
  if (typeof value === 'boolean') return { type: 'IfcBoolean', value } satisfies TypedPropertyValue;
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'IfcInteger' : 'IfcReal', value } satisfies TypedPropertyValue;
  }
  if (typeof value === 'string') return { type: 'IfcLabel', value } satisfies TypedPropertyValue;
  return value;
}

function ifcClassOfEntity(doc: Y.Doc, path: string): string | undefined {
  const entity = getEntity(doc, path);
  if (!entity) return undefined;
  const ifcClass = entityToJSON(entity).meta.ifcClass;
  return typeof ifcClass === 'string' ? ifcClass : undefined;
}

function requireField(op: DraftOpInput, index: number, field: 'name' | 'pset' | 'prop' | 'ifc_type'): string {
  const value = op[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: `ops[${index}]: '${op.op}' requires '${field}'.`,
      details: { op: { ...op } },
    });
  }
  return value;
}

function requireEntity(draft: DraftLayer, op: DraftOpInput, index: number): void {
  if (!hasEntity(draft.doc, op.path)) {
    throw new ToolExecutionError({
      code: ToolErrorCode.ENTITY_NOT_FOUND,
      message: `ops[${index}]: entity '${op.path}' not found in draft ${draft.id}.`,
      details: { op: { ...op } },
    });
  }
}

const createDraftLayer: Tool = {
  name: 'create_draft_layer',
  description:
    'Open a draft layer (CRDT session) bound to a base ref or layer. All writes land in drafts; ' +
    '`scope` is a list of capability scope-claims that bound what the draft may touch.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'Ref name (e.g. "main") or published layer id. Omit for a baseless draft.' },
      intent: { type: 'string', minLength: 1, description: 'Human-readable why — the layer log line.' },
      scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Scope claims, e.g. "model.mutate:Pset_FireSafety*@IfcWall". Empty/omitted = unrestricted.',
      },
    },
    required: ['intent'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const ws = getLayerWorkspace(ctx.session?.id);
    const rawClaims = (input.scope as string[] | undefined) ?? [];
    const parsed = parseScopeClaims(rawClaims);
    if (!parsed.ok) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'Invalid scope claims.',
        details: { errors: parsed.errors },
        hint: 'Claims follow "scope.action[:target][@IfcType[&key=value]]".',
      });
    }
    const { base, files } = resolveBase(ws, input.base as string | undefined);
    const draft = createDraft(ws, {
      base,
      baseFiles: files,
      intent: input.intent as string,
      claims: parsed.value,
      rawClaims,
      owner: ctx.session?.principal,
    });
    return okResult(
      `Draft ${draft.id} created${base ? ` on ${base.kind} ${base.id}` : ' (no base)'}; ${fmtCount(rawClaims.length, 'scope claim')}.`,
      { draft_id: draft.id, base, scope: rawClaims },
    );
  },
};

const draftApplyOps: Tool = {
  name: 'draft_apply_ops',
  description:
    'Apply entity operations to a draft layer. Each op is checked against the draft\'s scope claims ' +
    'before it touches the document; violations return a structured error.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      draft_id: { type: 'string' },
      ops: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['create_entity', 'set_attribute', 'set_property', 'delete_entity'] },
            path: { type: 'string', description: 'Entity path, e.g. "site/wall-1".' },
            ifc_type: { type: 'string', minLength: 1, description: 'IFC class — required for create_entity, e.g. "IfcWall".' },
            name: { type: 'string', description: 'Attribute name for set_attribute.' },
            pset: { type: 'string', description: 'Property-set name for set_property.' },
            prop: { type: 'string', description: 'Property name for set_property.' },
            value: { description: 'Value for set_attribute / set_property.' },
          },
          required: ['op', 'path'],
          additionalProperties: false,
        },
      },
    },
    required: ['draft_id', 'ops'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const ws = getLayerWorkspace(ctx.session?.id);
    const draft = requireOwnedDraft(ws, input.draft_id as string, ctx.session?.principal);
    const ops = input.ops as DraftOpInput[];

    // WRITE-TIME ENFORCEMENT — derive and check every capability before a
    // single op lands, so a denied batch leaves the draft untouched.
    // `pendingTypes` lets later ops in the batch see classes of entities
    // an earlier `create_entity` in the same batch will create.
    const pendingTypes = new Map<string, string | undefined>();
    ops.forEach((op, index) => {
      if (op.op === 'set_attribute') requireField(op, index, 'name');
      if (op.op === 'set_property') {
        requireField(op, index, 'pset');
        requireField(op, index, 'prop');
      }
      let ifcType: string | undefined;
      if (op.op === 'create_entity') {
        // A typeless entity would publish without bsi::ifc::class, losing
        // the only stable signal type-scoped claims and merge rely on.
        requireField(op, index, 'ifc_type');
        ifcType = op.ifc_type;
        pendingTypes.set(op.path, op.ifc_type);
      } else {
        ifcType = ifcClassOfEntity(draft.doc, op.path) ?? pendingTypes.get(op.path);
      }
      assertOpWithinClaims(draft.claims, draft.rawClaims, descriptorForDraftOp(op, ifcType), op);
    });

    draft.doc.transact(() => {
      ops.forEach((op, index) => {
        switch (op.op) {
          case 'create_entity':
            createEntity(draft.doc, op.path, {
              ifcClass: op.ifc_type,
              attributes: { [ATTR.CLASS]: { code: op.ifc_type } },
            });
            break;
          case 'set_attribute':
            requireEntity(draft, op, index);
            setAttribute(draft.doc, op.path, op.name as string, op.value);
            break;
          case 'set_property':
            requireEntity(draft, op, index);
            setAttribute(
              draft.doc,
              op.path,
              psetAttributeKey(op.pset as string, op.prop as string),
              typedPropertyRecord(op.value),
            );
            break;
          case 'delete_entity':
            requireEntity(draft, op, index);
            deleteEntity(draft.doc, op.path);
            break;
        }
      });
    });

    return okResult(`Applied ${fmtCount(ops.length, 'op')} to draft ${draft.id}.`, {
      draft_id: draft.id,
      applied: ops.length,
    });
  },
};

/** Freeze a draft via `publishLayer` without registering the result (previews). */
export function publishDraftFile(draft: DraftLayer, ctx: ToolContext): ReturnType<typeof publishLayer> {
  return publishLayer(draft.doc, {
    intent: draft.intent,
    author: {
      kind: 'agent',
      principal: ctx.scope.user ?? 'mcp-agent',
      tool: '@ifc-lite/mcp',
      session: draft.session,
    },
    baseline: draft.baseline,
    base: draft.base,
    scope_claim: [...draft.rawClaims],
  });
}

const publishLayerTool: Tool = {
  name: 'publish_layer',
  description:
    'Freeze a draft into an immutable content-addressed layer (blake3 id + provenance manifest). ' +
    'Actual ops are re-verified against the manifest scope claims; mismatches are reported.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      draft_id: { type: 'string' },
    },
    required: ['draft_id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const ws = getLayerWorkspace(ctx.session?.id);
    const draft = requireOwnedDraft(ws, input.draft_id as string, ctx.session?.principal);

    const published = publishDraftFile(draft, ctx);
    // PUBLISH-TIME verification: claims vs the ops actually frozen into
    // the layer. Mismatches are surfaced, never silently accepted.
    const verification = verifyLayerAgainstClaims(published.file, draft.baseFiles, draft.rawClaims);

    ws.layers.set(published.layerId, published.file);
    ws.drafts.delete(draft.id);

    return okResult(
      `Published ${published.layerId} (${fmtCount(published.opCount, 'op')}); scope_verified=${verification.verified}.`,
      {
        layer_id: published.layerId,
        op_count: published.opCount,
        scope_verified: verification.verified,
        ...(verification.mismatches.length > 0 ? { mismatches: verification.mismatches } : {}),
        checks: [],
      },
    );
  },
};

export const draftLayerTools: Tool[] = [createDraftLayer, draftApplyOps, publishLayerTool];
