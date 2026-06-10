/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HTTP layer-registry route (10-registry.md): push/pull content-addressed
 * layers by id, a ref database with server-side policy enforcement, and
 * review (PR) objects.
 *
 *   POST /api/v1/layers                    push (id verified server-side)
 *   GET  /api/v1/layers                    list ids
 *   GET  /api/v1/layers/:id                pull
 *   GET  /api/v1/refs                      list refs + policies
 *   PUT  /api/v1/refs/:name                create / move / protect
 *   POST /api/v1/refs/:name/merge          shared merge flow, policies enforced
 *   POST /api/v1/reviews                   open a review (PR object)
 *   GET  /api/v1/reviews[/:id]             read review(s)
 *   POST /api/v1/reviews/:id/feedback      per-entity decisions + status
 *
 * Policy-bearing refs cannot be moved by PUT — only the merge endpoint
 * moves them, which is where required checks and approval rules run.
 * Authentication mirrors the blob route: the websocket `authenticate`
 * hook is adapted into an authorizer, so one token scheme covers sync,
 * blobs, and the registry.
 *
 * v1 visibility: any authenticated principal reads ALL layers and refs
 * (team-scoped registry); per-ref/per-layer visibility is the
 * public/internal/private roadmap work (10 §10.5). Approval is a
 * point-in-time check — the lookup and the merge run synchronously in
 * one request, but an approval withdrawn after a merge completed does
 * not un-merge it.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { getProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { mergeIntoRef } from '@ifc-lite/merge';
import type { MergeInit, RefEntry, RefPolicy, Waiver } from '@ifc-lite/merge';
import type { Principal } from './auth.js';
import {
  LayerPushError,
  type LayerRegistryStore,
  type RegistryReview,
  type RegistryReviewDecision,
  type RegistryReviewStatus,
} from './layer-registry.js';

/** Resolve the acting principal, or null to reject with 401. */
export type RegistryAuthorizeFn = (
  token: string | undefined,
  method: string
) => Promise<Principal | null> | Principal | null;

export interface LayerRegistryRouteOptions {
  registry: LayerRegistryStore;
  /** Reject layer pushes over this size (default 50 MB). */
  maxBytes?: number;
  /** When omitted, traffic is anonymous (dev/tests) — matches the blob route. */
  authorize?: RegistryAuthorizeFn;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const BASE = '/api/v1/';

/**
 * Registry credentials are `Authorization: Bearer` ONLY — no `?token=`
 * fallback. A query-string secret leaks via access logs, reverse proxies,
 * traces, and copied URLs (same reasoning as the /metrics endpoint; the
 * websocket path keeps `?token=` only because browsers cannot set
 * handshake headers, which does not apply to registry API clients).
 */
function extractToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1];
  }
  return undefined;
}

function json(res: http.ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Runtime shape validation for ref policies; undefined = invalid. */
function parseRefPolicy(value: unknown): RefPolicy | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const policy: RefPolicy = {};
  if (raw.requireHumanApproval !== undefined) {
    if (typeof raw.requireHumanApproval !== 'boolean') return undefined;
    policy.requireHumanApproval = raw.requireHumanApproval;
  }
  if (raw.requiredChecks !== undefined) {
    if (!Array.isArray(raw.requiredChecks) || !raw.requiredChecks.every((c) => typeof c === 'string')) {
      return undefined;
    }
    policy.requiredChecks = raw.requiredChecks;
  }
  return policy;
}

/**
 * Handle a registry request. Returns false (untouched response) when the
 * path is not a registry path, true when a response was written.
 */
export async function handleLayerRegistryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: LayerRegistryRouteOptions
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(BASE)) return false;
  const segments = url.pathname.slice(BASE.length).split('/').filter(Boolean).map(decodeURIComponent);
  const [head] = segments;
  if (head !== 'layers' && head !== 'refs' && head !== 'reviews') return false;

  const method = req.method ?? 'GET';
  let principal: Principal | null = null;
  if (opts.authorize) {
    principal = await opts.authorize(extractToken(req), method);
    if (!principal) return json(res, 401, { error: 'unauthorized' });
  }
  const registry = opts.registry;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // ----- layers ------------------------------------------------------------
  if (head === 'layers') {
    if (method === 'GET' && segments.length === 1) {
      return json(res, 200, { layers: registry.listLayers() });
    }
    if (method === 'GET' && segments.length === 2) {
      const id = segments[1].startsWith('blake3:') ? segments[1] : `blake3:${segments[1]}`;
      if (!registry.hasLayer(id)) return json(res, 404, { error: `no layer ${id}` });
      return json(res, 200, registry.loadLayer(id));
    }
    if (method === 'POST' && segments.length === 1) {
      const text = await readBody(req, maxBytes);
      if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
      const file = parseJson(text) as IfcxFile | undefined;
      if (!file || typeof file.header !== 'object' || !Array.isArray(file.data)) {
        return json(res, 400, { error: 'body must be an IFCX layer document' });
      }
      try {
        return json(res, 201, { id: registry.push(file) });
      } catch (err) {
        if (err instanceof LayerPushError) return json(res, 409, { error: err.message, code: err.code });
        // Content that cannot be canonicalized (non-finite numbers, exotic
        // value types) is a client error, not a server fault.
        if (err instanceof Error && err.message.includes('canonicalizable')) {
          return json(res, 400, { error: err.message });
        }
        throw err;
      }
    }
    return json(res, 405, { error: `unsupported ${method} on layers` });
  }

  // ----- refs --------------------------------------------------------------
  if (head === 'refs') {
    if (method === 'GET' && segments.length === 1) {
      return json(res, 200, { refs: registry.listRefs() });
    }
    if (method === 'PUT' && segments.length === 2) {
      const text = await readBody(req, maxBytes);
      if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
      const body = parseJson(text ?? '') as { layers?: unknown; policy?: unknown } | undefined;
      if (
        !body ||
        (body.layers !== undefined &&
          !(Array.isArray(body.layers) && body.layers.every((id) => typeof id === 'string')))
      ) {
        return json(res, 400, { error: 'body must be { layers?: string[], policy?: RefPolicy }' });
      }
      const policy = body.policy === undefined ? undefined : parseRefPolicy(body.policy);
      if (body.policy !== undefined && policy === undefined) {
        return json(res, 400, {
          error: 'policy must be { requireHumanApproval?: boolean, requiredChecks?: string[] }',
        });
      }
      const name = segments[1];
      const existing = registry.getRef(name);
      const layers = (body.layers as string[] | undefined) ?? existing?.layers ?? [];
      const missing = layers.filter((id) => !registry.hasLayer(id));
      if (missing.length > 0) return json(res, 422, { error: `unknown layer(s): ${missing.join(', ')}` });
      // Policy-protected refs only move through the merge endpoint — that
      // is where required checks and approval rules are enforced.
      const layersChanged =
        existing !== undefined && JSON.stringify(existing.layers) !== JSON.stringify(layers);
      if (existing?.policy && layersChanged) {
        return json(res, 409, {
          error: `ref ${name} is policy-protected; move it via POST ${BASE}refs/${name}/merge`,
        });
      }
      const entry: RefEntry = {
        layers,
        ...(policy ? { policy } : existing?.policy ? { policy: existing.policy } : {}),
      };
      registry.setRef(name, entry);
      return json(res, existing ? 200 : 201, { ref: name, ...entry });
    }
    if (method === 'GET' && segments.length === 2) {
      const entry = registry.getRef(segments[1]);
      if (!entry) return json(res, 404, { error: `no ref ${segments[1]}` });
      return json(res, 200, { ref: segments[1], ...entry });
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'merge') {
      const text = await readBody(req, maxBytes);
      if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
      const body = parseJson(text ?? '') as
        | {
            candidate?: string;
            preview?: boolean;
            resolve?: 'ours' | 'theirs';
            waivers?: Waiver[];
            allow_unrelated?: boolean;
          }
        | undefined;
      if (!body?.candidate) return json(res, 400, { error: 'body must include { candidate: <layer id> }' });
      if (!registry.getRef(segments[1])) return json(res, 404, { error: `no ref ${segments[1]}` });
      if (!registry.hasLayer(body.candidate)) return json(res, 404, { error: `no layer ${body.candidate}` });

      const init: MergeInit = { candidateId: body.candidate, into: segments[1] };
      if (body.preview) init.preview = true;
      if (body.resolve === 'ours' || body.resolve === 'theirs') init.resolve = body.resolve;
      if (Array.isArray(body.waivers)) init.waivers = body.waivers;
      if (body.allow_unrelated) init.allowUnrelated = true;
      if (principal) init.principal = principal.userId;
      // `requireHumanApproval` derives from server-verified state — an
      // approved review object for this (candidate, ref), recorded by the
      // feedback endpoint with the approver's authenticated identity. A
      // caller-asserted approved_by body field would let any write-capable
      // agent bypass the branch protection (unlike the CLI, where the
      // local store's operator IS the approver).
      const approval = registry
        .listReviews()
        .find((r) => r.layerId === body.candidate && r.into === segments[1] && r.status === 'approved');
      if (approval?.approvedBy !== undefined) init.approvedBy = approval.approvedBy;

      const outcome = mergeIntoRef(registry, init);
      switch (outcome.status) {
        case 'fast-forward':
          return json(res, 200, { status: outcome.status, layers: outcome.refLayers });
        case 'merged':
          return json(res, 200, {
            status: outcome.status,
            merge_layer: outcome.mergeLayerId,
            layers: outcome.refLayers,
            ancestor_matched: outcome.ancestorMatched,
          });
        case 'preview':
          return json(res, 200, { status: outcome.status, plan: outcome.plan });
        case 'conflicts':
          return json(res, 409, { status: outcome.status, conflicts: outcome.conflicts });
        case 'policy-failure':
          return json(res, 403, { status: outcome.status, reason: outcome.reason });
        case 'unrelated-base':
          return json(res, 422, { status: outcome.status, declared_base: outcome.declaredBase });
      }
    }
    return json(res, 405, { error: `unsupported ${method} on refs` });
  }

  // ----- reviews -----------------------------------------------------------
  if (method === 'GET' && segments.length === 1) {
    return json(res, 200, { reviews: registry.listReviews() });
  }
  if (method === 'GET' && segments.length === 2) {
    const review = registry.getReview(segments[1]);
    if (!review) return json(res, 404, { error: `no review ${segments[1]}` });
    return json(res, 200, review);
  }
  if (method === 'POST' && segments.length === 1) {
    const text = await readBody(req, maxBytes);
    if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
    const body = parseJson(text ?? '') as
      | { layer_id?: string; into?: string; reviewers?: string[] }
      | undefined;
    if (!body?.layer_id || !body.into) {
      return json(res, 400, { error: 'body must include { layer_id, into }' });
    }
    if (!registry.hasLayer(body.layer_id)) return json(res, 404, { error: `no layer ${body.layer_id}` });
    if (!registry.getRef(body.into)) return json(res, 404, { error: `no ref ${body.into}` });
    const review: RegistryReview = {
      id: crypto.randomUUID(),
      layerId: body.layer_id,
      into: body.into,
      reviewers: Array.isArray(body.reviewers) ? body.reviewers : [],
      status: 'open',
      feedback: [],
      ...(principal ? { openedBy: principal.userId } : {}),
      openedAt: new Date().toISOString(),
    };
    registry.putReview(review);
    return json(res, 201, { id: review.id });
  }
  if (method === 'POST' && segments.length === 3 && segments[2] === 'feedback') {
    const review = registry.getReview(segments[1]);
    if (!review) return json(res, 404, { error: `no review ${segments[1]}` });
    // When the review names reviewers, only they may act on it.
    const actor = principal?.userId ?? 'anonymous';
    if (review.reviewers.length > 0 && !review.reviewers.includes(actor)) {
      return json(res, 403, { error: `only the named reviewers may act on review ${review.id}` });
    }
    const text = await readBody(req, maxBytes);
    if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
    const body = parseJson(text ?? '') as
      | { decisions?: RegistryReviewDecision[]; status?: RegistryReviewStatus }
      | undefined;
    if (!body || !Array.isArray(body.decisions)) {
      return json(res, 400, { error: 'body must include { decisions: [...] }' });
    }
    if (body.status === 'approved') {
      // No self-approval: the layer's manifest author cannot satisfy the
      // approval its own merge needs. (Human-vs-agent identity of the
      // approver is the auth provider's responsibility — the registry
      // enforces attributability and separation, not species.)
      const layer = registry.hasLayer(review.layerId) ? registry.loadLayer(review.layerId) : undefined;
      const author = layer ? getProvenance(layer)?.author.principal : undefined;
      if (author !== undefined && author === actor) {
        return json(res, 403, { error: `layer author ${author} cannot approve their own review` });
      }
    }
    review.feedback.push(...body.decisions);
    if (body.status === 'approved' || body.status === 'changes-requested') {
      review.status = body.status;
      // Approval identity is server-recorded, never caller-asserted: the
      // merge endpoint reads it back for requireHumanApproval policies.
      if (body.status === 'approved') review.approvedBy = actor;
      else delete review.approvedBy;
    }
    registry.putReview(review);
    return json(res, 200, { id: review.id, status: review.status, decision_count: review.feedback.length });
  }
  return json(res, 405, { error: `unsupported ${method} on reviews` });
}
