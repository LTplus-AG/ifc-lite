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

  it('disposeLayerWorkspace drops the workspace; the same id then gets a fresh one', async () => {
    const ctxA = makeCtx({ id: 'session-a' });
    await call('create_draft_layer', { intent: 'doomed' }, ctxA);
    const before = getLayerWorkspace('session-a');
    expect(before.drafts.size).toBe(1);

    disposeLayerWorkspace('session-a');
    const after = getLayerWorkspace('session-a');
    expect(after).not.toBe(before);
    expect(after.drafts.size).toBe(0);
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

  it('keeps reviews readable within the workspace regardless of owner', async () => {
    const reviewId = await seedReview();
    const feedback = await call('get_review_feedback', { review_id: reviewId }, mallory());
    expect(feedback.status).toBe('open');
  });
});
