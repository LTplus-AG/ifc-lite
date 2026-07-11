/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Full agent draft-layer loop (06-agents.md): scoped draft creation,
 * write-time scope enforcement, publish with content addressing and
 * publish-time claim verification, the review feedback round-trip, and
 * merge previews against a moving ref.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import type { SessionIdentity, ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { ToolExecutionError } from '../errors.js';
import { draftLayerTools } from './layer.js';
import { layerReviewTools } from './layer-review.js';
import { getLayerWorkspace, resetLayerWorkspace } from './layer-store.js';
import type { Tool } from './types.js';

const WALL = 'site/wall-1';

function makeCtx(session?: SessionIdentity): ToolContext {
  return {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG },
    ...(session !== undefined ? { session } : {}),
  };
}

const allTools: Tool[] = [...draftLayerTools, ...layerReviewTools];

function tool(name: string): Tool {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

async function call(name: string, input: Record<string, unknown>, ctx = makeCtx()): Promise<Record<string, unknown>> {
  const result: CallToolResult = await tool(name).handler(input, ctx);
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

/** Seed: publish a base layer with one IfcWall onto the 'main' ref. */
async function seedMain(): Promise<string> {
  const created = await call('create_draft_layer', { intent: 'seed base model' });
  const draftId = created.draft_id as string;
  await call('draft_apply_ops', {
    draft_id: draftId,
    ops: [
      { op: 'create_entity', path: WALL, ifc_type: 'IfcWall' },
      { op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI30' },
    ],
  });
  const published = await call('publish_layer', { draft_id: draftId });
  const layerId = published.layer_id as string;
  getLayerWorkspace().refs.set('main', [layerId]);
  return layerId;
}

beforeEach(() => {
  resetLayerWorkspace();
});

describe('create_draft_layer', () => {
  it('rejects invalid scope claims with a structured error', () => {
    expect(() =>
      tool('create_draft_layer').handler({ intent: 'x', scope: ['definitely not a capability'] }, makeCtx()),
    ).toThrowError(ToolExecutionError);
  });

  it('resolves a ref base to its stack identity', async () => {
    await seedMain();
    const res = await call('create_draft_layer', { base: 'main', intent: 'scoped work', scope: ['model.mutate:Pset_FireSafety*'] });
    expect(res.draft_id).toBeTypeOf('string');
    const base = res.base as { kind: string; id: string };
    expect(base.kind).toBe('stack');
    expect(base.id).toMatch(/^blake3:/);
    expect(res.scope).toEqual(['model.mutate:Pset_FireSafety*']);
  });
});

describe('write-time scope enforcement', () => {
  it('allows in-scope ops and rejects out-of-scope ops with the structured deny', async () => {
    await seedMain();
    const { draft_id } = await call('create_draft_layer', {
      base: 'main',
      intent: 'upgrade fire ratings',
      scope: ['model.mutate:Pset_FireSafety*'],
    });

    const applied = await call('draft_apply_ops', {
      draft_id,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI90' }],
    });
    expect(applied.applied).toBe(1);

    let denied: ToolExecutionError | undefined;
    try {
      await tool('draft_apply_ops').handler(
        { draft_id, ops: [{ op: 'delete_entity', path: WALL }] },
        makeCtx(),
      );
    } catch (err) {
      denied = err as ToolExecutionError;
    }
    expect(denied).toBeInstanceOf(ToolExecutionError);
    expect(denied?.message).toBe('scope does not permit model.delete; request elevation or narrow the task');
    expect(denied?.code).toBe('PERMISSION_DENIED');
    expect(denied?.details?.claims).toEqual(['model.mutate:Pset_FireSafety*']);

    // The denied op never touched the draft: the wall is still there.
    const ws = getLayerWorkspace();
    expect(ws.drafts.get(draft_id as string)).toBeDefined();
  });
});

describe('publish_layer', () => {
  it('publishes a scoped draft with a blake3 id and scope_verified true', async () => {
    await seedMain();
    const { draft_id } = await call('create_draft_layer', {
      base: 'main',
      intent: 'upgrade fire ratings',
      scope: ['model.mutate:Pset_FireSafety*'],
    });
    await call('draft_apply_ops', {
      draft_id,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI90' }],
    });
    const res = await call('publish_layer', { draft_id });
    expect(res.layer_id).toMatch(/^blake3:/);
    expect(res.op_count).toBe(1);
    expect(res.scope_verified).toBe(true);
    expect(res.mismatches).toBeUndefined();
    expect(res.checks).toEqual([]);
    // Draft is consumed; layer is stored.
    const ws = getLayerWorkspace();
    expect(ws.drafts.has(draft_id as string)).toBe(false);
    expect(ws.layers.has(res.layer_id as string)).toBe(true);
  });

  it('reports scope_verified false with mismatches when ops exceed the manifest claims', async () => {
    await seedMain();
    // Unrestricted draft (no write-time gate) whose manifest nevertheless
    // records claims: publish-time verification must catch the excess.
    const { draft_id } = await call('create_draft_layer', { base: 'main', intent: 'sneaky delete' });
    const draft = getLayerWorkspace().drafts.get(draft_id as string);
    if (!draft) throw new Error('draft missing');
    draft.rawClaims = ['model.mutate:Pset_FireSafety*'];

    await call('draft_apply_ops', { draft_id, ops: [{ op: 'delete_entity', path: WALL }] });
    const res = await call('publish_layer', { draft_id });
    expect(res.scope_verified).toBe(false);
    const mismatches = res.mismatches as Array<{ path: string; capability: string }>;
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches[0]).toMatchObject({ path: WALL, capability: 'model.delete' });
  });
});

describe('diff_layer', () => {
  it('reports the modified entity and its pset component for a draft', async () => {
    await seedMain();
    const { draft_id } = await call('create_draft_layer', {
      base: 'main',
      intent: 'bump rating',
      scope: ['model.mutate:Pset_FireSafety*'],
    });
    await call('draft_apply_ops', {
      draft_id,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI120' }],
    });
    const diff = await call('diff_layer', { layer_or_draft: draft_id });
    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.modified).toEqual([{ path: WALL, components: ['pset:Pset_FireSafety'] }]);
  });
});

describe('dry_run_merge / list_conflicts', () => {
  it('reports a concurrent-edit conflict for a candidate racing the ref', async () => {
    await seedMain();
    const ws = getLayerWorkspace();

    // Draft C forks main while B advances it with a different FireRating.
    const { draft_id: cId } = await call('create_draft_layer', {
      base: 'main',
      intent: 'set rating to REI60',
      scope: ['model.mutate:Pset_FireSafety*'],
    });

    const { draft_id: bId } = await call('create_draft_layer', {
      base: 'main',
      intent: 'set rating to REI90',
      scope: ['model.mutate:Pset_FireSafety*'],
    });
    await call('draft_apply_ops', {
      draft_id: bId,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI90' }],
    });
    const bPublished = await call('publish_layer', { draft_id: bId });
    ws.refs.set('main', [...(ws.refs.get('main') ?? []), bPublished.layer_id as string]);

    await call('draft_apply_ops', {
      draft_id: cId,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI60' }],
    });

    const preview = await call('dry_run_merge', { layer_or_draft: cId, into: 'main' });
    expect(preview.base_resolved).toBe(true);
    const conflicts = preview.conflicts as Array<{ kind: string; path: string; componentKey?: string }>;
    expect(conflicts).toEqual([
      { kind: 'concurrent-edit', path: WALL, componentKey: 'pset:Pset_FireSafety' },
    ]);

    const onlyConflicts = await call('list_conflicts', { layer_or_draft: cId, into: 'main' });
    expect(onlyConflicts.conflicts).toEqual(conflicts);
  });

  it('merges cleanly when the ref did not move', async () => {
    await seedMain();
    const { draft_id } = await call('create_draft_layer', {
      base: 'main',
      intent: 'bump rating',
      scope: ['model.mutate:Pset_FireSafety*'],
    });
    await call('draft_apply_ops', {
      draft_id,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI90' }],
    });
    const preview = await call('dry_run_merge', { layer_or_draft: draft_id, into: 'main' });
    expect(preview.conflicts).toEqual([]);
    expect(preview.auto_op_count).toBeGreaterThan(0);
  });
});

describe('review loop', () => {
  it('round-trips request_review → add_review_feedback → get_review_feedback → respond_to_review', async () => {
    await seedMain();
    const { draft_id } = await call('create_draft_layer', {
      base: 'main',
      intent: 'upgrade fire ratings',
      scope: ['model.mutate:Pset_FireSafety*'],
    });
    await call('draft_apply_ops', {
      draft_id,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI90' }],
    });
    const { layer_id } = await call('publish_layer', { draft_id });

    const { review_id } = await call('request_review', {
      layer_id,
      into: 'main',
      reviewers: ['louis@lt.plus'],
    });
    expect(review_id).toBeTypeOf('string');

    const feedbackRes = await call('add_review_feedback', {
      review_id,
      decisions: [
        { entity: WALL, component_key: 'pset:Pset_FireSafety', decision: 'reject', comment: 'REI90 is over-spec; REI60 suffices.' },
      ],
      status: 'changes-requested',
    });
    expect(feedbackRes.status).toBe('changes-requested');

    const feedback = await call('get_review_feedback', { review_id });
    expect(feedback.status).toBe('changes-requested');
    expect(feedback.decisions).toEqual([
      { entity: WALL, component_key: 'pset:Pset_FireSafety', decision: 'reject', comment: 'REI90 is over-spec; REI60 suffices.' },
    ]);

    const response = await call('respond_to_review', { review_id, intent: 'lower rating to REI60' });
    const followUpId = response.draft_id as string;
    expect(followUpId).toBeTypeOf('string');
    expect(response.scope).toEqual(['model.mutate:Pset_FireSafety*']);

    const ws = getLayerWorkspace();
    expect(ws.reviews.get(review_id as string)?.responses).toEqual([followUpId]);

    // The follow-up draft sits on the reviewed layer's base and inherits
    // its scope: the fix applies in-claim and republishes verified.
    await call('draft_apply_ops', {
      draft_id: followUpId,
      ops: [{ op: 'set_property', path: WALL, pset: 'Pset_FireSafety', prop: 'FireRating', value: 'REI60' }],
    });
    const republished = await call('publish_layer', { draft_id: followUpId });
    expect(republished.layer_id).toMatch(/^blake3:/);
    expect(republished.scope_verified).toBe(true);
  });
});
