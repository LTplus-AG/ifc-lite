/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Diff & comparison tools (spec §7.8).
 *
 * Both inputs reference loaded models by id; if you want to diff against an
 * on-disk file, call `model_load` first.
 */

import { EntityNode } from '@ifc-lite/query';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import type { Tool } from './types.js';
import { okResult, assertModelAccess } from './util.js';
import { parseAuthoredKeySpec } from '@ifc-lite/parser';
import {
  contentDiff,
  describeCounts,
  DEFAULT_MAX_GROUP_MEMBERS,
  DEFAULT_MAX_MATCHES,
} from './diff-content.js';
import { foldedTypeCounts, pendingMutationsField, pendingOverlay, type PendingOverlay } from '../overlay.js';
import type { LoadedModel, ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { firstNonBlank } from '../material-naming.js';

function resolveTwo(ctx: ToolContext, a: string, b: string) {
  const left = ctx.registry.get(a);
  const right = ctx.registry.get(b);
  if (!left || !right) {
    throw new ToolExecutionError({
      code: ToolErrorCode.MODEL_NOT_FOUND,
      message: `Both models must be loaded; missing: ${[!left && a, !right && b].filter(Boolean).join(', ')}`,
    });
  }
  // Enforce the caller's per-model allowlist on BOTH operands (the direct
  // registry.get above bypasses resolveModel's central check).
  assertModelAccess(ctx, left);
  assertModelAccess(ctx, right);
  return { left, right };
}

const modelDiff: Tool = {
  name: 'model_diff',
  description:
    'Compare two loaded models. Reports added/removed entities by GlobalId and per-type count deltas. '
    + 'Set by_content=true when the two models may have been re-exported from scratch (new GlobalIds): '
    + 'that runs the real diff engine, which matches entities by content so a re-GUID stops reading as '
    + 'the whole model deleted and re-added.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'string', description: 'model_id of base.' },
      b: { type: 'string', description: 'model_id of head.' },
      by_entity: { type: 'boolean', default: true, description: 'Include per-entity GlobalId additions/removals.' },
      by_content: {
        type: 'boolean',
        default: false,
        description:
          'Run the @ifc-lite/diff engine with content-keyed matching over every IfcObjectDefinition. '
          + 'Adds `contentDiff` with added/modified/deleted/unchanged counts and the content matches '
          + '(renamed / moved / reshaped / respecified are resolved; duplicated / deduplicated / ambiguous are listed '
          + 'as groups for you to resolve). Data scope only — this server has no geometry pipeline.',
      },
      max_matches: {
        type: 'integer',
        default: DEFAULT_MAX_MATCHES,
        minimum: 1,
        description:
          'Cap on the listed content matches (by_content only). Unresolved groups are listed first and '
          + '`contentMatchCounts` always reports whole per-kind totals.',
      },
      key_from: {
        type: 'string',
        description:
          'Compare on an authored identifier instead of GlobalId (by_content only): "Tag", or '
          + '"<PsetName>.<PropertyName>" such as "Pset_Asset.AssetId". An entity carrying a non-empty, '
          + 'unique value is keyed on it; the rest keep their GlobalId. Values shared by several entities '
          + 'are listed in duplicateAuthoredKeys.',
      },
      max_group_members: {
        type: 'integer',
        default: DEFAULT_MAX_GROUP_MEMBERS,
        minimum: 1,
        description:
          'Cap on the GlobalIds listed per side of one match (by_content only). A duplicated / '
          + 'deduplicated / ambiguous group can hold thousands. `baseCount` / `headCount` always report '
          + 'the whole size and `baseTruncated` / `headTruncated` say whether the list was cut.',
      },
      split_merge: {
        type: 'boolean',
        default: false,
        description:
          'Opt in to the split/merge detector (by_content only, issue #4956). Geometry-only stage: '
          + 'this server has no geometry pipeline yet, so `contentDiff.splitMerges` currently stays '
          + 'absent regardless of this flag — wired through so it starts producing claims the moment '
          + 'one lands, with no client-side change.',
      },
      successors: {
        type: 'boolean',
        default: false,
        description:
          'Opt in to the successor-match detector: suggestions that one deleted entity was replaced '
          + 'in place by one added entity (by_content only, issue #4956). Same geometry-only caveat as '
          + '`split_merge` — `contentDiff.successors` currently stays absent on this server.',
      },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const { left, right } = resolveTwo(ctx, input.a as string, input.b as string);
    // A model_id names a session, not a file: fold in whatever `entity_create`
    // / `entity_delete` / `entity_set_*` have queued, on every pass. Null (the
    // common case — the backend builds the overlay lazily on first mutation)
    // leaves each pass on its original store-only path.
    const leftOverlay = pendingOverlay(left);
    const rightOverlay = pendingOverlay(right);

    // Type-level diff
    const types1 = foldedTypeCounts(left.store, leftOverlay);
    const types2 = foldedTypeCounts(right.store, rightOverlay);
    const allTypes = new Set([...types1.keys(), ...types2.keys()]);
    const typeDiffs: Array<{ type: string; left: number; right: number; delta: number }> = [];
    for (const t of allTypes) {
      const c1 = types1.get(t) ?? 0;
      const c2 = types2.get(t) ?? 0;
      if (c1 !== c2) typeDiffs.push({ type: IFC_ENTITY_NAMES[t] ?? t, left: c1, right: c2, delta: c2 - c1 });
    }
    typeDiffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    let entityDiff: { added: string[]; removed: string[]; common: number } | null = null;
    if ((input.by_entity as boolean | undefined) ?? true) {
      const gids1 = collectGlobalIds(left, leftOverlay);
      const gids2 = collectGlobalIds(right, rightOverlay);
      const added: string[] = [];
      const removed: string[] = [];
      let common = 0;
      for (const g of gids1) (gids2.has(g) ? common++ : removed.push(g));
      for (const g of gids2) if (!gids1.has(g)) added.push(g);
      entityDiff = { added, removed, common };
    }

    // Opt-in, and deliberately so. An `ambiguous` group has no honest scalar
    // form, so turning this on by default would change what `counts` means
    // under agent scripts that already read this tool.
    const keyFrom = typeof input.key_from === 'string' && input.key_from.trim() ? input.key_from.trim() : undefined;
    if (keyFrom !== undefined && !parseAuthoredKeySpec(keyFrom)) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'key_from must be "Tag" or "<PsetName>.<PropertyName>", got "' + keyFrom + '"',
      });
    }
    const content = (input.by_content as boolean | undefined) ?? false
      ? contentDiff(
        left,
        right,
        { left: leftOverlay, right: rightOverlay },
        (input.max_matches as number | undefined) ?? DEFAULT_MAX_MATCHES,
        (input.max_group_members as number | undefined) ?? DEFAULT_MAX_GROUP_MEMBERS,
        keyFrom,
        (input.split_merge as boolean | undefined) ?? false,
        (input.successors as boolean | undefined) ?? false,
      )
      : null;

    const pendingField = pendingMutationsField(leftOverlay, rightOverlay);
    const pending = pendingField.pendingMutations ?? 0;
    const summary = [
      `Diff ${input.a}→${input.b}: ${typeDiffs.length} type changes`,
      entityDiff ? `, +${entityDiff.added.length}/-${entityDiff.removed.length} entities by GlobalId` : '',
      content
        ? `. By content (data scope): ${describeCounts(content)}`
        : '',
      // An agent that just edited a model and then asked what changed should be
      // told its unsaved edits are part of the answer, not left to infer it.
      pending > 0 ? `. Includes ${pending} unsaved mutation(s)` : '',
    ].join('');

    // Top level, not only inside `contentDiff`: `typeDiffs` and `entityDiff`
    // fold too, and a payload that folds says so (#2014). The per-side split
    // stays on `contentDiff` where a base/head distinction means something.
    return okResult(summary, {
      typeDiffs,
      entityDiff,
      contentDiff: content,
      ...pendingField,
    });
  },
};

/** Every GlobalId the session has, queued creates and deletes applied. */
function collectGlobalIds(model: LoadedModel, overlay: PendingOverlay | null): Set<string> {
  const gids = new Set<string>();
  for (const [, ids] of model.store.entityIndex.byType) {
    for (const id of ids) {
      if (overlay?.deleted.has(id)) continue;
      const node = new EntityNode(model.store, id);
      if (node.globalId) gids.add(node.globalId);
    }
  }
  for (const entity of overlay?.created ?? []) gids.add(entity.globalId);
  return gids;
}

const quantityDiff: Tool = {
  name: 'quantity_diff',
  description: 'Per-entity-type quantity comparison between two models, optionally grouped by storey.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'string' },
      type: { type: 'string', default: 'IfcWall' },
      quantity: { type: 'string', default: 'Volume' },
      group_by: { type: 'string', enum: ['storey', 'type'], default: 'type' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const { left, right } = resolveTwo(ctx, input.a as string, input.b as string);
    const type = (input.type as string | undefined) ?? 'IfcWall';
    const qName = (input.quantity as string | undefined) ?? 'Volume';

    const aggregate = (model: typeof left): Map<string, { count: number; total: number }> => {
      const out = new Map<string, { count: number; total: number }>();
      for (const e of model.bim.query().byType(type).toArray()) {
        const key = (input.group_by as string | undefined) === 'storey'
          // `model.bim.storey`, not a raw EntityNode: the SDK walk folds the
          // session's queued and deleted relationships, the store walk does not
          // (#2014).
          ? (firstNonBlank(model.bim.storey(e.ref)?.name) ?? '(none)')
          : e.type;
        let value: number | null = null;
        for (const qset of model.bim.quantities(e.ref)) {
          for (const q of qset.quantities) {
            if (q.name.endsWith(qName)) { value = q.value; break; }
          }
          if (value !== null) break;
        }
        const slot = out.get(key) ?? { count: 0, total: 0 };
        slot.count++;
        if (value != null) slot.total += value;
        out.set(key, slot);
      }
      return out;
    };

    const left1 = aggregate(left);
    const right1 = aggregate(right);
    const groups = new Set([...left1.keys(), ...right1.keys()]);
    const rows: Array<{ key: string; left: number; right: number; delta: number; deltaPct: number | null }> = [];
    for (const k of groups) {
      const l = left1.get(k)?.total ?? 0;
      const r = right1.get(k)?.total ?? 0;
      const delta = r - l;
      const pct = l === 0 ? null : (delta / l) * 100;
      rows.push({ key: k, left: l, right: r, delta, deltaPct: pct });
    }
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return okResult(
      `${rows.length} group(s) compared (${type}.${qName}).`,
      {
        type,
        quantity: qName,
        groupBy: input.group_by ?? 'type',
        rows,
        ...pendingMutationsField(pendingOverlay(left), pendingOverlay(right)),
      },
    );
  },
};

export const diffTools: Tool[] = [modelDiff, quantityDiff];
