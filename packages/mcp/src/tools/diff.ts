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
import { diffModels, type ContentMatch, type ContentMatchKind } from '@ifc-lite/diff';
import type { Tool } from './types.js';
import { okResult, assertModelAccess } from './util.js';
import { buildModelFingerprints, type DiffRef } from './diff-fingerprints.js';
import { foldedTypeCounts, pendingMutationsField, pendingOverlay, type PendingOverlay } from '../overlay.js';
import type { LoadedModel, ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

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

/** Default cap on the listed `contentMatches`. Per-kind totals are reported
 *  whole, so the cap bounds the payload without hiding anything. */
const DEFAULT_MAX_MATCHES = 200;

/**
 * Default cap on the GlobalIds listed per side of one match.
 *
 * `max_matches` bounds how many groups come back, not how big one is, and a
 * `duplicated` / `deduplicated` / `ambiguous` group is a set of candidates that
 * in a repetitive model can run to thousands of entities on each side. Without
 * this, `max_matches: 1` could still return a model-sized payload and overflow
 * the context window the cap exists to protect.
 *
 * 20 is chosen against what the list is *for*. A group is the engine declining
 * to guess, so its members are a hand-off to the caller; twenty candidates on a
 * side is already past what anyone resolves by reading a list rather than by
 * querying the two models. The overwhelmingly common match is a 1:1 `renamed`
 * pair, which this never touches. Every group still reports `baseCount` and
 * `headCount` whole, computed before the cap for the same reason
 * `contentMatchCounts` is: truncation must never be what makes a model look
 * cleanly matched.
 */
const DEFAULT_MAX_GROUP_MEMBERS = 20;

/**
 * Kinds an agent has to resolve itself, listed before the ones the engine
 * already retired. Truncating the list must never be what drops the
 * "we could not tell" groups.
 */
const UNRESOLVED_FIRST: ContentMatchKind[] = [
  'ambiguous',
  'duplicated',
  'deduplicated',
  'moved',
  'reshaped',
  'renamed',
];

/**
 * Run the real `@ifc-lite/diff` engine over two loaded models (issue #1891).
 *
 * **Data scope only.** This server has no geometry pipeline, so there is no
 * world geometry hash and no bounding box; `scope: 'data'` is the honest
 * description of what it can see, and every unambiguous 1:1 content match is
 * therefore reported as `renamed` rather than `moved`/`reshaped`. See
 * `diff-fingerprints.ts`.
 */
function contentDiff(
  left: LoadedModel,
  right: LoadedModel,
  overlays: { left: PendingOverlay | null; right: PendingOverlay | null },
  maxMatches: number,
  maxGroupMembers: number,
): Record<string, unknown> {
  const diff = diffModels(
    buildModelFingerprints(left.store, overlays.left),
    buildModelFingerprints(right.store, overlays.right),
    { scope: 'data', matchUnpairedByContent: true },
  );

  const matches = [...(diff.contentMatches ?? [])].sort(
    (a: ContentMatch<DiffRef>, b: ContentMatch<DiffRef>) =>
      UNRESOLVED_FIRST.indexOf(a.kind) - UNRESOLVED_FIRST.indexOf(b.kind),
  );
  const byKind: Record<string, number> = {};
  for (const match of matches) byKind[match.kind] = (byKind[match.kind] ?? 0) + 1;

  return {
    scope: diff.scope,
    counts: diff.counts,
    // Whole totals, computed before the cap: an agent reading `contentMatches`
    // can always tell whether the list it got is the whole story.
    contentMatchCounts: byKind,
    contentMatches: matches.slice(0, maxMatches).map((match) => ({
      kind: match.kind,
      ifcType: match.base[0]?.ifcType ?? match.head[0]?.ifcType,
      // Groups are reported as groups. Collapsing a `duplicated` or
      // `ambiguous` set to a single pair would be the engine guessing, which
      // is exactly what it refuses to do (#1923). Long groups are cut to
      // `maxGroupMembers` per side and say so, whole size included, so a cut
      // group still reads as a group of that size.
      ...listSide('base', match.base, maxGroupMembers),
      ...listSide('head', match.head, maxGroupMembers),
      ...(match.distance !== undefined ? { distance: match.distance } : {}),
    })),
    truncatedMatches: Math.max(0, matches.length - maxMatches),
    // Uncommitted edits are folded into the comparison; saying how many there
    // are is what separates "the two files differ" from "this session has
    // edits it has not written yet". Absent when neither model has any.
    //
    // `pendingMutations` is the scalar every other payload carries; the split a
    // two-model comparison can additionally give lives under its own name rather
    // than overloading that one.
    ...pendingMutationsField(overlays.left, overlays.right),
    ...(overlays.left || overlays.right
      ? {
        pendingMutationsBySide: {
          base: overlays.left?.pendingMutations ?? 0,
          head: overlays.right?.pendingMutations ?? 0,
        },
      }
      : {}),
  };
}

/** One side of a match: the (capped) keys, the whole count, and whether the
 *  list was cut. Emits `base`/`baseCount`/`baseTruncated` (or `head…`). */
function listSide(
  side: 'base' | 'head',
  entities: ReadonlyArray<{ key: string }>,
  maxGroupMembers: number,
): Record<string, unknown> {
  return {
    [side]: entities.slice(0, maxGroupMembers).map((entity) => entity.key),
    [`${side}Count`]: entities.length,
    [`${side}Truncated`]: entities.length > maxGroupMembers,
  };
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
          + '(renamed / moved / reshaped are resolved; duplicated / deduplicated / ambiguous are listed '
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
      max_group_members: {
        type: 'integer',
        default: DEFAULT_MAX_GROUP_MEMBERS,
        minimum: 1,
        description:
          'Cap on the GlobalIds listed per side of one match (by_content only). A duplicated / '
          + 'deduplicated / ambiguous group can hold thousands. `baseCount` / `headCount` always report '
          + 'the whole size and `baseTruncated` / `headTruncated` say whether the list was cut.',
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
    const content = (input.by_content as boolean | undefined) ?? false
      ? contentDiff(
        left,
        right,
        { left: leftOverlay, right: rightOverlay },
        (input.max_matches as number | undefined) ?? DEFAULT_MAX_MATCHES,
        (input.max_group_members as number | undefined) ?? DEFAULT_MAX_GROUP_MEMBERS,
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

/** One-line human summary of the engine result, for the text block. */
function describeCounts(content: Record<string, unknown>): string {
  const counts = content.counts as { added: number; modified: number; deleted: number; unchanged: number };
  const byKind = content.contentMatchCounts as Record<string, number>;
  const kinds = Object.entries(byKind).map(([kind, n]) => `${n} ${kind}`).join(', ');
  return `${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, `
    + `${counts.unchanged} unchanged`
    + (kinds ? `; content matches: ${kinds}` : '; no content matches');
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
          ? (model.bim.storey(e.ref)?.name ?? '(none)')
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
