/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Session-scoped layer workspaces + ownership checks (#1030): workspace
 * isolation between transport sessions, owner-gated mutations that are
 * indistinguishable from unknown ids (no cross-tenant enumeration),
 * reviewer allowances, and per-session workspace disposal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import type { SessionIdentity, ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { ToolExecutionError } from '../errors.js';
import { draftLayerTools } from './layer.js';
import { layerReviewTools } from './layer-review.js';
import { disposeLayerWorkspace, getLayerWorkspace, resetLayerWorkspace } from './layer-store.js';
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

async function call(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  const result: CallToolResult = await tool(name).handler(input, ctx);
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

async function callErr(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionError> {
  try {
    await tool(name).handler(input, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolExecutionError);
    return err as ToolExecutionError;
  }
  throw new Error(`expected ${name} to throw`);
}

const CREATE_WALL_OPS = [{ op: 'create_entity', path: WALL, ifc_type: 'IfcWall' }];

beforeEach(() => {
  resetLayerWorkspace();
});

describe('session-scoped workspaces', () => {
  it('isolates drafts between transport sessions', async () => {
    const ctxA = makeCtx({ id: 'session-a' });
    const ctxB = makeCtx({ id: 'session-b' });

    const created = await call('create_draft_layer', { intent: 'session A work' }, ctxA);
    const draftId = created.draft_id as string;
    expect(getLayerWorkspace('session-a').drafts.has(draftId)).toBe(true);
    expect(getLayerWorkspace('session-b').drafts.size).toBe(0);

    // B cannot touch A's draft, and B's error must not enumerate A's ids.
    const err = await callErr('draft_apply_ops', { draft_id: draftId, ops: CREATE_WALL_OPS }, ctxB);
    expect(err.code).toBe('ENTITY_NOT_FOUND');
    expect(err.details?.drafts).toEqual([]);
  });

  it('keeps the local (no-session) workspace separate from session workspaces', async () => {
    const local = makeCtx();
    const created = await call('create_draft_layer', { intent: 'local work' }, local);
    expect(getLayerWorkspace().drafts.has(created.draft_id as string)).toBe(true);
    expect(getLayerWorkspace('session-a').drafts.size).toBe(0);
  });

  it('disposeLayerWorkspace drops the draft space; the same id then gets a fresh one', async () => {
    const ctxA = makeCtx({ id: 'session-a' });
    await call('create_draft_layer', { intent: 'doomed' }, ctxA);
    const before = getLayerWorkspace('session-a');
    expect(before.drafts.size).toBe(1);

    disposeLayerWorkspace('session-a');
    const after = getLayerWorkspace('session-a');
    expect(after.drafts).not.toBe(before.drafts);
    expect(after.drafts.size).toBe(0);
  });

  it('published layers and refs survive session disposal (shared record)', async () => {
    const ctxA = makeCtx({ id: 'session-a' });
    const created = await call('create_draft_layer', { intent: 'publish then leave' }, ctxA);
    await call('draft_apply_ops', { draft_id: created.draft_id, ops: CREATE_WALL_OPS }, ctxA);
    const published = await call('publish_layer', { draft_id: created.draft_id }, ctxA);
    getLayerWorkspace('session-a').refs.set('main', [published.layer_id as string]);

    disposeLayerWorkspace('session-a');

    // A different session keeps building on the published record.
    const ctxB = makeCtx({ id: 'session-b' });
    const onMain = await call('create_draft_layer', { intent: 'stacked work', base: 'main' }, ctxB);
    expect(onMain.draft_id).toBeTypeOf('string');
    expect(getLayerWorkspace('session-b').layers.has(published.layer_id as string)).toBe(true);
  });
});

describe('draft ownership', () => {
  const alice = (): ToolContext => makeCtx({ id: 'shared', principal: 'alice' });
  const mallory = (): ToolContext => makeCtx({ id: 'shared', principal: 'mallory' });

  it('denies non-owner mutations with an error indistinguishable from an unknown id', async () => {
    const created = await call('create_draft_layer', { intent: 'alice work' }, alice());
    const draftId = created.draft_id as string;

    const denied = await callErr('draft_apply_ops', { draft_id: draftId, ops: CREATE_WALL_OPS }, mallory());
    const unknown = await callErr('draft_apply_ops', { draft_id: 'no-such-draft', ops: CREATE_WALL_OPS }, mallory());

    expect(denied.code).toBe('ENTITY_NOT_FOUND');
    expect(denied.code).toBe(unknown.code);
    // Byte-identical shape modulo the probed id: a foreign id must read
    // exactly like a nonexistent one.
    expect(denied.message).toBe(unknown.message.replace('no-such-draft', draftId));
    expect(denied.details).toEqual(unknown.details);
    expect(denied.details?.drafts).toEqual([]);

    const publishDenied = await callErr('publish_layer', { draft_id: draftId }, mallory());
    expect(publishDenied.code).toBe('ENTITY_NOT_FOUND');
    expect(publishDenied.details?.drafts).toEqual([]);

    // The owner is unaffected.
    const applied = await call('draft_apply_ops', { draft_id: draftId, ops: CREATE_WALL_OPS }, alice());
    expect(applied.applied).toBe(1);
    const published = await call('publish_layer', { draft_id: draftId }, alice());
    expect(published.layer_id).toMatch(/^blake3:/);
  });

  it('leaves unowned drafts accessible to any principal in the workspace', async () => {
    const anonymous = makeCtx({ id: 'shared' });
    const created = await call('create_draft_layer', { intent: 'unowned' }, anonymous);
    const applied = await call(
      'draft_apply_ops',
      { draft_id: created.draft_id, ops: CREATE_WALL_OPS },
      mallory(),
    );
    expect(applied.applied).toBe(1);
  });

  it('filters foreign draft ids out of unknown-id error details', async () => {
    const created = await call('create_draft_layer', { intent: 'alice work' }, alice());
    const mine = await call('create_draft_layer', { intent: 'mallory work' }, mallory());

    const err = await callErr('draft_apply_ops', { draft_id: 'nope', ops: CREATE_WALL_OPS }, mallory());
    expect(err.details?.drafts).toEqual([mine.draft_id]);
    expect(err.details?.drafts).not.toContain(created.draft_id);
  });
});

describe('review ownership', () => {
  const alice = (): ToolContext => makeCtx({ id: 'shared', principal: 'alice' });
  const bob = (): ToolContext => makeCtx({ id: 'shared', principal: 'bob' });
  const mallory = (): ToolContext => makeCtx({ id: 'shared', principal: 'mallory' });

  /** Alice publishes a layer onto 'main' and opens a review with Bob as reviewer. */
  async function seedReview(): Promise<string> {
    const created = await call('create_draft_layer', { intent: 'reviewed work' }, alice());
    await call('draft_apply_ops', { draft_id: created.draft_id, ops: CREATE_WALL_OPS }, alice());
    const published = await call('publish_layer', { draft_id: created.draft_id }, alice());
    getLayerWorkspace('shared').refs.set('main', [published.layer_id as string]);
    const review = await call(
      'request_review',
      { layer_id: published.layer_id, into: 'main', reviewers: ['bob'] },
      alice(),
    );
    return review.review_id as string;
  }

  it('respond_to_review is owner-only and denies like an unknown id', async () => {
    const reviewId = await seedReview();

    const denied = await callErr('respond_to_review', { review_id: reviewId }, mallory());
    const unknown = await callErr('respond_to_review', { review_id: 'no-such-review' }, mallory());
    expect(denied.code).toBe('ENTITY_NOT_FOUND');
    expect(denied.message).toBe(unknown.message.replace('no-such-review', reviewId));
    expect(denied.details).toEqual(unknown.details);
    expect(denied.details?.reviews).toEqual([]);

    const response = await call('respond_to_review', { review_id: reviewId }, alice());
    expect(response.draft_id).toBeTypeOf('string');
  });

  it('add_review_feedback allows the owner and listed reviewers, denies strangers', async () => {
    const reviewId = await seedReview();
    const decision = { entity: WALL, decision: 'reject', comment: 'needs work' };

    const denied = await callErr('add_review_feedback', { review_id: reviewId, decisions: [decision] }, mallory());
    expect(denied.code).toBe('ENTITY_NOT_FOUND');
    expect(denied.details?.reviews).toEqual([]);

    const byReviewer = await call('add_review_feedback', { review_id: reviewId, decisions: [decision] }, bob());
    expect(byReviewer.decision_count).toBe(1);

    const byOwner = await call('add_review_feedback', { review_id: reviewId, decisions: [decision] }, alice());
    expect(byOwner.decision_count).toBe(2);
  });

  it('review reads admit owner and listed reviewers, deny strangers like an unknown id', async () => {
    const reviewId = await seedReview();

    const byOwner = await call('get_review_feedback', { review_id: reviewId }, alice());
    expect(byOwner.status).toBe('open');
    const byReviewer = await call('get_review_feedback', { review_id: reviewId }, bob());
    expect(byReviewer.status).toBe('open');

    // Reviews are process-shared across sessions, so reads are gated too:
    // a stranger probing a foreign review id must see a nonexistent one.
    const denied = await callErr('get_review_feedback', { review_id: reviewId }, mallory());
    const unknown = await callErr('get_review_feedback', { review_id: 'no-such-review' }, mallory());
    expect(denied.code).toBe('ENTITY_NOT_FOUND');
    expect(denied.message).toBe(unknown.message.replace('no-such-review', reviewId));
    expect(denied.details).toEqual(unknown.details);
  });
});

describe('cross-session review collaboration', () => {
  // Each principal necessarily holds its own HTTP session (the transport
  // rejects scope mismatches on session reuse), so the review loop must
  // work across sessions: shared reviews + reviewer visibility.
  const alice = (): ToolContext => makeCtx({ id: 'session-alice', principal: 'alice' });
  const bob = (): ToolContext => makeCtx({ id: 'session-bob', principal: 'bob' });
  const stranger = (): ToolContext => makeCtx({ id: 'session-eve', principal: 'eve' });

  async function publishAndRequestReview(): Promise<string> {
    const created = await call('create_draft_layer', { intent: 'cross-session work' }, alice());
    await call('draft_apply_ops', { draft_id: created.draft_id, ops: CREATE_WALL_OPS }, alice());
    const published = await call('publish_layer', { draft_id: created.draft_id }, alice());
    getLayerWorkspace('session-alice').refs.set('main', [published.layer_id as string]);
    const review = await call(
      'request_review',
      { layer_id: published.layer_id, into: 'main', reviewers: ['bob'] },
      alice(),
    );
    return review.review_id as string;
  }

  it("a listed reviewer reaches the review from their own session; strangers don't", async () => {
    const reviewId = await publishAndRequestReview();

    // Bob acts from session-bob — a workspace that never saw the draft.
    const feedback = await call('get_review_feedback', { review_id: reviewId }, bob());
    expect(feedback.status).toBe('open');
    const added = await call(
      'add_review_feedback',
      { review_id: reviewId, decisions: [{ entity: WALL, decision: 'accept' }] },
      bob(),
    );
    expect(added.decision_count).toBe(1);

    // Eve probes from her own session: indistinguishable from nonexistent.
    const denied = await callErr('get_review_feedback', { review_id: reviewId }, stranger());
    expect(denied.code).toBe('ENTITY_NOT_FOUND');
    expect(denied.details?.reviews).toEqual([]);
  });

  it("the owner responds to reviewer feedback from a later session; drafts stay session-private", async () => {
    const reviewId = await publishAndRequestReview();
    await call(
      'add_review_feedback',
      { review_id: reviewId, decisions: [{ entity: WALL, decision: 'reject', comment: 'thinner' }] },
      bob(),
    );

    // Alice reconnects under a fresh session id — reviews are keyed to the
    // principal, not the transport session, so she can still respond.
    const aliceLater = makeCtx({ id: 'session-alice-2', principal: 'alice' });
    const response = await call('respond_to_review', { review_id: reviewId }, aliceLater);
    const followUp = response.draft_id as string;

    // The follow-up draft was created in *her* session's draft space …
    expect(getLayerWorkspace('session-alice-2').drafts.has(followUp)).toBe(true);
    // … and is invisible from Bob's.
    expect(getLayerWorkspace('session-bob').drafts.has(followUp)).toBe(false);
  });
});
