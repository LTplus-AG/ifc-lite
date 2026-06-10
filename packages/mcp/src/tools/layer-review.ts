/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer review tools (spec 06-agents.md §6.3): structured diff, dry-run
 * merge previews, and the review loop (`request_review` →
 * `add_review_feedback` → `get_review_feedback` → `respond_to_review`)
 * that lets a reviewer reject per-entity decisions and the agent open a
 * follow-up draft on the same base to address them.
 */

import { randomUUID } from 'node:crypto';
import { getProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { parseScopeClaims } from '@ifc-lite/extensions';
import {
  componentEntries,
  extractStackState,
  planThreeWayMerge,
  snapshotOf,
} from '@ifc-lite/merge';
import type { MergePlan, StackState } from '@ifc-lite/merge';
import type { Tool } from './types.js';
import type { ToolContext } from '../context.js';
import { okResult, fmtCount } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import {
  createDraft,
  getLayerWorkspace,
  refLayerFiles,
  resolveAncestorFiles,
  resolveAncestorFilesAnyRef,
} from './layer-store.js';
import { requireOwnedReview, requireReview, visibleDraftIds } from './layer-access.js';
import type { LayerReview, LayerWorkspace, ReviewDecision, ReviewStatus } from './layer-store.js';
import { publishDraftFile } from './layer.js';

interface ResolvedCandidate {
  /** Files composing the candidate's full state (base + delta). */
  stateFiles: IfcxFile[];
  /** The candidate's base stack, for ancestor/diff defaults. */
  baseFiles: IfcxFile[];
  /** The single delta layer (publish preview for drafts). */
  candidateFile: IfcxFile;
}

/** Resolve a draft id or layer id into state/base/delta files. */
function resolveCandidate(ws: LayerWorkspace, id: string, ctx: ToolContext, into?: string): ResolvedCandidate {
  const draft = ws.drafts.get(id);
  if (draft) {
    // Publish preview: `publishLayer` is pure w.r.t. the draft.
    const preview = publishDraftFile(draft, ctx).file;
    return { stateFiles: [...draft.baseFiles, preview], baseFiles: draft.baseFiles, candidateFile: preview };
  }
  const layer = ws.layers.get(id);
  if (layer) {
    const base = getProvenance(layer)?.base ?? null;
    // With an explicit ref, resolve against it; otherwise search every
    // ref — an empty ref list could never reconstruct a stack-hash base
    // and the diff would misreport the whole layer as newly added.
    const baseFiles =
      into !== undefined
        ? resolveAncestorFiles(ws, base, ws.refs.get(into) ?? [])
        : resolveAncestorFilesAnyRef(ws, base);
    return { stateFiles: [...baseFiles, layer], baseFiles, candidateFile: layer };
  }
  // Published layers carry no owner (immutable, workspace-shared); drafts
  // do, so only the caller's own / unowned draft ids may be enumerated.
  throw new ToolExecutionError({
    code: ToolErrorCode.ENTITY_NOT_FOUND,
    message: `'${id}' is neither an open draft nor a published layer.`,
    details: { drafts: visibleDraftIds(ws, ctx.session?.principal), layers: Array.from(ws.layers.keys()) },
  });
}

/** Resolve the `against` side of a diff: ref name, layer id, or draft id. */
function resolveStateFiles(ws: LayerWorkspace, id: string, ctx: ToolContext): IfcxFile[] {
  if (ws.refs.has(id)) return refLayerFiles(ws, id);
  return resolveCandidate(ws, id, ctx).stateFiles;
}

interface DiffEntry { path: string; components: string[] }

/** Structured stack-state diff — same JSON shape the review UI consumes. */
function diffStates(left: StackState, right: StackState): {
  added: string[];
  deleted: string[];
  modified: DiffEntry[];
} {
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: DiffEntry[] = [];
  const paths = new Set<string>([...left.keys(), ...right.keys()]);

  for (const path of paths) {
    const l = left.get(path);
    const r = right.get(path);
    const lAlive = l !== undefined && !l.deleted;
    const rAlive = r !== undefined && !r.deleted;
    if (!lAlive && rAlive) {
      added.push(path);
      continue;
    }
    if (lAlive && !rAlive) {
      deleted.push(path);
      continue;
    }
    if (!lAlive || !rAlive) continue;

    const lComponents = componentEntries(l);
    const rComponents = componentEntries(r);
    const changed: string[] = [];
    for (const key of new Set([...lComponents.keys(), ...rComponents.keys()])) {
      const lAttrs = lComponents.get(key);
      const rAttrs = rComponents.get(key);
      const lHash = lAttrs ? snapshotOf(lAttrs).hash : undefined;
      const rHash = rAttrs ? snapshotOf(rAttrs).hash : undefined;
      if (lHash !== rHash) changed.push(key);
    }
    if (changed.length > 0) modified.push({ path, components: changed.sort() });
  }
  return { added: added.sort(), deleted: deleted.sort(), modified };
}

function planMerge(ws: LayerWorkspace, input: Record<string, unknown>, ctx: ToolContext): MergePlan {
  const into = input.into as string;
  if (!ws.refs.has(into)) {
    throw new ToolExecutionError({
      code: ToolErrorCode.ENTITY_NOT_FOUND,
      message: `Unknown ref '${into}'.`,
      details: { refs: Array.from(ws.refs.keys()) },
    });
  }
  const ours = refLayerFiles(ws, into);
  const candidate = resolveCandidate(ws, input.layer_or_draft as string, ctx, into);
  return planThreeWayMerge({
    ancestor: candidate.baseFiles,
    ours,
    theirs: [...candidate.baseFiles, candidate.candidateFile],
  });
}

function conflictsJson(plan: MergePlan): Array<{ kind: string; path: string; componentKey?: string }> {
  return plan.conflicts.map((c) => ({
    kind: c.kind,
    path: c.path,
    ...(c.componentKey !== undefined ? { componentKey: c.componentKey } : {}),
  }));
}

const diffLayer: Tool = {
  name: 'diff_layer',
  description:
    'Structured diff of a draft or published layer against a ref, layer, or draft ' +
    '(defaults to the candidate\'s own base). Same JSON shape the review UI consumes.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      layer_or_draft: { type: 'string', description: 'Draft id or published layer id.' },
      against: { type: 'string', description: 'Ref name, layer id, or draft id to diff against. Defaults to the candidate\'s base.' },
    },
    required: ['layer_or_draft'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const ws = getLayerWorkspace(ctx.session?.id);
    const candidate = resolveCandidate(ws, input.layer_or_draft as string, ctx);
    const leftFiles = input.against !== undefined
      ? resolveStateFiles(ws, input.against as string, ctx)
      : candidate.baseFiles;
    const diff = diffStates(extractStackState(leftFiles), extractStackState(candidate.stateFiles));
    return okResult(
      `Diff: +${diff.added.length} / -${diff.deleted.length} / ~${diff.modified.length} entities.`,
      { added: diff.added, deleted: diff.deleted, modified: diff.modified },
    );
  },
};

const dryRunMerge: Tool = {
  name: 'dry_run_merge',
  description:
    'Preview merging a draft or layer into a ref: MergePlan conflicts and auto-op count. No side effects.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      layer_or_draft: { type: 'string' },
      into: { type: 'string', description: 'Target ref name.' },
    },
    required: ['layer_or_draft', 'into'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const plan = planMerge(getLayerWorkspace(ctx.session?.id), input, ctx);
    return okResult(
      `Merge preview into '${input.into as string}': ${fmtCount(plan.conflicts.length, 'conflict')}, ${plan.autoOps.length} auto op(s).`,
      { conflicts: conflictsJson(plan), auto_op_count: plan.autoOps.length, would_fail_checks: [] },
    );
  },
};

const listConflicts: Tool = {
  name: 'list_conflicts',
  description: 'Conflict records a merge of the candidate into the ref would produce. No side effects.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      layer_or_draft: { type: 'string' },
      into: { type: 'string', description: 'Target ref name.' },
    },
    required: ['layer_or_draft', 'into'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const plan = planMerge(getLayerWorkspace(ctx.session?.id), input, ctx);
    return okResult(`${fmtCount(plan.conflicts.length, 'conflict')}.`, { conflicts: conflictsJson(plan) });
  },
};

const requestReview: Tool = {
  name: 'request_review',
  description: 'Open a review (the PR object) proposing a published layer for merge into a ref.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      layer_id: { type: 'string' },
      into: { type: 'string', description: 'Target ref name.' },
      reviewers: { type: 'array', items: { type: 'string' } },
    },
    required: ['layer_id', 'into'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const ws = getLayerWorkspace(ctx.session?.id);
    const layerId = input.layer_id as string;
    if (!ws.layers.has(layerId)) {
      throw new ToolExecutionError({
        code: ToolErrorCode.ENTITY_NOT_FOUND,
        message: `Unknown layer '${layerId}'. Publish the draft first.`,
      });
    }
    const into = input.into as string;
    if (!ws.refs.has(into)) {
      throw new ToolExecutionError({
        code: ToolErrorCode.ENTITY_NOT_FOUND,
        message: `Unknown ref '${into}' — a review must target an existing ref.`,
        details: { refs: Array.from(ws.refs.keys()) },
      });
    }
    const review: LayerReview = {
      id: randomUUID(),
      layerId,
      into,
      reviewers: (input.reviewers as string[] | undefined) ?? [],
      status: 'open',
      feedback: [],
      responses: [],
      owner: ctx.session?.principal,
    };
    ws.reviews.set(review.id, review);
    return okResult(`Review ${review.id} opened: ${layerId} → '${review.into}'.`, { review_id: review.id });
  },
};

interface DecisionInput {
  entity: string;
  component_key?: string;
  decision: 'accept' | 'reject';
  comment?: string;
}

const addReviewFeedback: Tool = {
  name: 'add_review_feedback',
  description: 'Record per-entity reviewer decisions (and optionally a status change) on an open review.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      review_id: { type: 'string' },
      decisions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            entity: { type: 'string' },
            component_key: { type: 'string' },
            decision: { type: 'string', enum: ['accept', 'reject'] },
            comment: { type: 'string' },
          },
          required: ['entity', 'decision'],
          additionalProperties: false,
        },
      },
      status: { type: 'string', enum: ['changes-requested', 'approved'] },
    },
    required: ['review_id', 'decisions'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const ws = getLayerWorkspace(ctx.session?.id);
    const review = requireOwnedReview(ws, input.review_id as string, ctx.session?.principal, {
      allowReviewers: true,
    });
    const decisions = input.decisions as DecisionInput[];
    for (const d of decisions) {
      const entry: ReviewDecision = { entity: d.entity, decision: d.decision };
      if (d.component_key !== undefined) entry.componentKey = d.component_key;
      if (d.comment !== undefined) entry.comment = d.comment;
      review.feedback.push(entry);
    }
    if (input.status !== undefined) review.status = input.status as ReviewStatus;
    return okResult(
      `Recorded ${fmtCount(decisions.length, 'decision')} on review ${review.id}; status=${review.status}.`,
      { review_id: review.id, status: review.status, decision_count: review.feedback.length },
    );
  },
};

const getReviewFeedback: Tool = {
  name: 'get_review_feedback',
  description: 'Read a review\'s status and per-entity decisions, structured for the agent to act on.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      review_id: { type: 'string' },
    },
    required: ['review_id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const review = requireReview(getLayerWorkspace(ctx.session?.id), input.review_id as string, ctx.session?.principal);
    return okResult(
      `Review ${review.id}: status=${review.status}, ${fmtCount(review.feedback.length, 'decision')}.`,
      {
        review_id: review.id,
        layer_id: review.layerId,
        into: review.into,
        status: review.status,
        decisions: review.feedback.map((d) => ({
          entity: d.entity,
          ...(d.componentKey !== undefined ? { component_key: d.componentKey } : {}),
          decision: d.decision,
          ...(d.comment !== undefined ? { comment: d.comment } : {}),
        })),
        responses: [...review.responses],
      },
    );
  },
};

const respondToReview: Tool = {
  name: 'respond_to_review',
  description:
    'Open a follow-up draft on the reviewed layer\'s base so the agent can address feedback; ' +
    'the draft is recorded as a response on the review.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      review_id: { type: 'string' },
      intent: { type: 'string', description: 'Intent for the follow-up draft. Defaults to a reference to the review.' },
    },
    required: ['review_id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const ws = getLayerWorkspace(ctx.session?.id);
    const review = requireOwnedReview(ws, input.review_id as string, ctx.session?.principal);
    const layer = ws.layers.get(review.layerId);
    if (!layer) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INTERNAL_ERROR,
        message: `Review ${review.id} references unknown layer ${review.layerId}.`,
      });
    }
    const manifest = getProvenance(layer);
    const base = manifest?.base ?? null;
    const baseFiles = resolveAncestorFiles(ws, base, ws.refs.get(review.into) ?? []);
    const rawClaims = manifest?.scope_claim ?? [];
    const parsed = parseScopeClaims(rawClaims);
    if (!parsed.ok) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Reviewed layer carries unparseable scope claims.`,
        details: { errors: parsed.errors },
      });
    }
    const draft = createDraft(ws, {
      base,
      baseFiles,
      intent: (input.intent as string | undefined) ?? `Address review ${review.id} feedback on ${review.layerId}`,
      claims: parsed.value,
      rawClaims: [...rawClaims],
      session: manifest?.author.session,
      owner: ctx.session?.principal,
    });
    review.responses.push(draft.id);
    return okResult(
      `Follow-up draft ${draft.id} opened for review ${review.id} (same base and scope as ${review.layerId}).`,
      { draft_id: draft.id, review_id: review.id, base, scope: [...rawClaims] },
    );
  },
};

export const layerReviewTools: Tool[] = [
  diffLayer,
  dryRunMerge,
  listConflicts,
  requestReview,
  addReviewFeedback,
  getReviewFeedback,
  respondToReview,
];
