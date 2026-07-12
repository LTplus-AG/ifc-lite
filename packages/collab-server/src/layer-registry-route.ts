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
import { ANONYMOUS_USER_ID, type Principal } from './auth.js';
import {
  LayerPushError,
  type LayerRegistryStore,
  type RegistryReview,
  type RegistryReviewTopic,
  type RegistryReviewDecision,
} from './layer-registry.js';
import { emitRegistryEvent, type RegistryWebhook } from './registry-webhooks.js';

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
  /** Event consumers (08-review.md §8.7); empty = no emission. */
  webhooks?: readonly RegistryWebhook[];
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

/** Parse JSON, surfacing the failure reason instead of swallowing it. */
function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Map a store-thrown `LayerPushError` onto the HTTP surface: capacity
 * exhaustion is 507, integrity/conflict gates are 409. Every route that
 * writes through the store (push, ref PUT, merge, reviews) must route
 * through this — an unwrapped throw becomes a bare 500.
 */
function handlePushError(res: http.ServerResponse, err: unknown): true | undefined {
  if (err instanceof LayerPushError) {
    return json(res, err.code === 'registry-full' ? 507 : 409, { error: err.message, code: err.code });
  }
  return undefined;
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
  if (raw.autoMerge !== undefined) {
    if (typeof raw.autoMerge !== 'boolean') return undefined;
    policy.autoMerge = raw.autoMerge;
  }
  return policy;
}

/**
 * Auto-merge (10-registry.md §10.4): after a push, conflict-free +
 * all-green candidates merge unattended into every `autoMerge` ref.
 * Fail-closed by construction:
 *  - `requireHumanApproval` refs never auto-merge (an unattended merge
 *    cannot satisfy an approval).
 *  - Baseless candidates never auto-merge (three-way against an empty
 *    ancestor reads every op as "new" — a disjoint layer would land on
 *    every auto-merge ref).
 *  - `conflicts` / `policy-failure` / `unrelated-base` outcomes have no
 *    side effects in the shared flow, and any throw is contained — an
 *    auto-merge can never fail the push that triggered it.
 */
function runAutoMerges(
  registry: LayerRegistryStore,
  pushedId: string,
  webhooks: readonly RegistryWebhook[]
): void {
  let manifest;
  try {
    manifest = getProvenance(registry.loadLayer(pushedId));
  } catch {
    return;
  }
  if (!manifest?.base) return;
  // "All-green" is the whole candidate manifest, not just the ref's
  // required checks: a failing check the policy forgot to require must
  // still keep the merge attended.
  if ((manifest.checks ?? []).some((check) => check.result !== 'pass')) return;
  for (const [name, entry] of Object.entries(registry.listRefs())) {
    const policy = entry.policy;
    if (!policy?.autoMerge || policy.requireHumanApproval) continue;
    if (entry.layers.includes(pushedId)) continue;
    // Idempotency: a candidate that already landed via a three-way merge
    // is represented by its MERGE layer, not its own id — re-merging it
    // would append a duplicate (usually empty) merge layer per re-push.
    const alreadyMerged = entry.layers.some((layerId) => {
      try {
        return getProvenance(registry.loadLayer(layerId))?.merge?.candidate === pushedId;
      } catch {
        return false;
      }
    });
    if (alreadyMerged) continue;
    try {
      const outcome = mergeIntoRef(registry, {
        candidateId: pushedId,
        into: name,
        principal: 'registry-automerge',
      });
      if (outcome.status === 'fast-forward' || outcome.status === 'merged') {
        emitRegistryEvent(webhooks, 'ref.merged', {
          ref: name,
          candidate: pushedId,
          status: outcome.status,
          auto: true,
          ...(outcome.status === 'merged' ? { merge_layer: outcome.mergeLayerId } : {}),
        });
      }
    } catch {
      // Contained by contract (see above).
    }
  }
}

/** Runtime shape validation for review decisions; undefined = invalid. */
function parseReviewDecision(value: unknown): RegistryReviewDecision | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.entity !== 'string' || (raw.decision !== 'accept' && raw.decision !== 'reject')) {
    return undefined;
  }
  const decision: RegistryReviewDecision = { entity: raw.entity, decision: raw.decision };
  if (raw.componentKey !== undefined) {
    if (typeof raw.componentKey !== 'string') return undefined;
    decision.componentKey = raw.componentKey;
  }
  if (raw.comment !== undefined) {
    if (typeof raw.comment !== 'string') return undefined;
    decision.comment = raw.comment;
  }
  return decision;
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
  const rawSegments = url.pathname.slice(BASE.length).split('/').filter(Boolean);
  const [head] = rawSegments;
  if (head !== 'layers' && head !== 'refs' && head !== 'reviews' && head !== 'reports') return false;
  let segments: string[];
  try {
    segments = rawSegments.map(decodeURIComponent);
  } catch (err) {
    // Malformed percent-escapes are a client error, not a server fault.
    return json(res, 400, {
      error: `malformed percent-encoding in path: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const method = req.method ?? 'GET';
  let principal: Principal | null = null;
  if (opts.authorize) {
    principal = await opts.authorize(extractToken(req), method);
    if (!principal) return json(res, 401, { error: 'unauthorized' });
  }
  const registry = opts.registry;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const webhooks = opts.webhooks ?? [];

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
      const parsed = parseJson(text);
      if (parsed.error !== undefined) return json(res, 400, { error: `invalid JSON body: ${parsed.error}` });
      const file = parsed.value as IfcxFile | undefined;
      if (!file || typeof file.header !== 'object' || !Array.isArray(file.data)) {
        return json(res, 400, { error: 'body must be an IFCX layer document' });
      }
      // Bind the manifest author to the push credential: provenance is
      // otherwise self-asserted, and a spoofed author.principal defeats
      // both the no-self-approval guard and requireHumanApproval (the
      // approver "differs" from a name the real author invented). A
      // manifest-less push would dodge the binding entirely — and later
      // dodge the self-approval separation (no author to compare) — so
      // authenticated pushes must carry provenance. Only enforceable when
      // the deployment authenticates real identities; the anonymous dev
      // sentinel is not a credential to bind against.
      if (principal && principal.userId !== ANONYMOUS_USER_ID) {
        const manifest = getProvenance(file);
        if (!manifest) {
          return json(res, 400, {
            error: 'authenticated pushes must carry a provenance manifest (author identity is bound to the credential)',
          });
        }
        if (manifest.author.principal !== principal.userId) {
          return json(res, 403, {
            error: `manifest author.principal "${manifest.author.principal}" must match the authenticated principal "${principal.userId}"`,
          });
        }
      }
      try {
        const id = registry.push(file);
        emitRegistryEvent(webhooks, 'layer.pushed', { id });
        runAutoMerges(registry, id, webhooks);
        return json(res, 201, { id });
      } catch (err) {
        const handled = handlePushError(res, err);
        if (handled) return handled;
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

  // ----- reports (check evidence, 08-review.md §8.4) ------------------------
  // The IDS spec/report files whose digests provenance `checks` entries
  // carry. Content-addressed under the digest the manifest already names,
  // digest-verified on write, immutable. Evidence is text (IDS XML, report
  // JSON), so the utf-8 body path is safe.
  if (head === 'reports') {
    if (segments.length !== 2) {
      return json(res, method === 'GET' || method === 'PUT' ? 404 : 405, {
        error: `reports are addressed by digest: ${method} /api/v1/reports/<blake3:hex>`,
      });
    }
    const digest = segments[1].startsWith('blake3:') ? segments[1] : `blake3:${segments[1]}`;
    if (method === 'GET') {
      if (!registry.getReport) return json(res, 501, { error: 'this registry store does not persist check evidence' });
      const bytes = registry.getReport(digest);
      if (bytes === undefined) return json(res, 404, { error: `no report ${digest}` });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'x-report-digest': digest,
      });
      res.end(Buffer.from(bytes));
      return true;
    }
    if (method === 'PUT') {
      if (!registry.putReport) return json(res, 501, { error: 'this registry store does not persist check evidence' });
      const text = await readBody(req, maxBytes);
      if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
      try {
        return json(res, 201, { digest: registry.putReport(digest, Buffer.from(text, 'utf-8')) });
      } catch (err) {
        const handled = handlePushError(res, err);
        if (handled) return handled;
        throw err;
      }
    }
    return json(res, 405, { error: `unsupported ${method} on reports` });
  }

  // ----- refs --------------------------------------------------------------
  if (head === 'refs') {
    if (method === 'GET' && segments.length === 1) {
      return json(res, 200, { refs: registry.listRefs() });
    }
    if (method === 'PUT' && segments.length === 2) {
      const text = await readBody(req, maxBytes);
      if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
      const parsed = parseJson(text);
      if (parsed.error !== undefined) return json(res, 400, { error: `invalid JSON body: ${parsed.error}` });
      const body = parsed.value as { layers?: unknown; policy?: unknown } | undefined;
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
      // A protected ref's policy is immutable through this API in v1:
      // letting any write principal PUT `{ "policy": {} }` would strip
      // requireHumanApproval/requiredChecks and neuter the merge gate.
      // (Idempotent re-PUT of the identical policy is allowed.)
      if (
        existing?.policy &&
        policy !== undefined &&
        JSON.stringify(existing.policy) !== JSON.stringify(policy)
      ) {
        return json(res, 409, {
          error: `ref ${name} is policy-protected; its policy cannot be changed via PUT`,
        });
      }
      const entry: RefEntry = {
        layers,
        ...(policy ? { policy } : existing?.policy ? { policy: existing.policy } : {}),
      };
      try {
        registry.setRef(name, entry);
      } catch (err) {
        const handled = handlePushError(res, err);
        if (handled) return handled;
        throw err;
      }
      if (body?.layers !== undefined) {
        emitRegistryEvent(webhooks, 'ref.moved', { ref: name, layers: entry.layers });
      }
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
      const parsed = parseJson(text);
      if (parsed.error !== undefined) return json(res, 400, { error: `invalid JSON body: ${parsed.error}` });
      const body = parsed.value as
        | {
            candidate?: string;
            preview?: boolean;
            resolve?: 'ours' | 'theirs';
            resolutions?: unknown[];
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
      // Per-conflict resolutions from the review UI: strictly-shaped
      // ours/theirs decisions, or edit-in-place with the replacement
      // attributes (08-review.md §8.3). The engine re-validates edited
      // targets (componentKey-scoped, non-relation) when applying.
      if (body.resolutions !== undefined) {
        if (!Array.isArray(body.resolutions)) {
          return json(res, 400, { error: 'resolutions must be an array of { path, component_key?, choice }' });
        }
        const parsedResolutions: NonNullable<MergeInit['resolutions']> = [];
        for (const item of body.resolutions) {
          if (typeof item !== 'object' || item === null) {
            return json(res, 400, { error: 'each resolution must be { path, component_key?, choice: "ours" | "theirs" | "edited" }' });
          }
          const raw = item as Record<string, unknown>;
          const choice = raw.choice;
          if (typeof raw.path !== 'string' || (choice !== 'ours' && choice !== 'theirs' && choice !== 'edited')) {
            return json(res, 400, { error: 'each resolution must be { path, component_key?, choice: "ours" | "theirs" | "edited" }' });
          }
          if (raw.component_key !== undefined && typeof raw.component_key !== 'string') {
            return json(res, 400, { error: 'component_key must be a string when present' });
          }
          if (choice === 'edited') {
            if (
              typeof raw.component_key !== 'string' ||
              typeof raw.attributes !== 'object' ||
              raw.attributes === null ||
              Array.isArray(raw.attributes)
            ) {
              return json(res, 400, {
                error: 'an edited resolution must be { path, component_key, choice: "edited", attributes: { ... } }',
              });
            }
          }
          parsedResolutions.push({
            path: raw.path,
            choice,
            ...(raw.component_key !== undefined ? { componentKey: raw.component_key as string } : {}),
            ...(choice === 'edited'
              ? { attributes: raw.attributes as Record<string, unknown> }
              : {}),
          });
        }
        init.resolutions = parsedResolutions;
      }
      if (Array.isArray(body.waivers)) init.waivers = body.waivers;
      if (body.allow_unrelated) init.allowUnrelated = true;
      if (principal) init.principal = principal.userId;
      // `requireHumanApproval` derives from server-verified state — an
      // approved review object for this (candidate, ref), recorded by the
      // feedback endpoint with the approver's authenticated identity. A
      // caller-asserted approved_by body field would let any write-capable
      // agent bypass the branch protection (unlike the CLI, where the
      // local store's operator IS the approver). Only the LATEST review
      // for the pair is authoritative: a stale approval must not outlive
      // a newer review that was reopened or marked changes-requested.
      const latestReview = registry
        .listReviews()
        .filter((r) => r.layerId === body.candidate && r.into === segments[1])
        .reduce<RegistryReview | undefined>(
          (acc, r) => (acc === undefined || r.openedAt >= acc.openedAt ? r : acc),
          undefined
        );
      if (latestReview?.status === 'approved' && latestReview.approvedBy !== undefined) {
        init.approvedBy = latestReview.approvedBy;
      }
      // The shared flow's requireHumanApproval only fires for
      // `author.kind === 'agent'`, but the kind is self-asserted — an
      // agent that claims to be human would skip the gate. The registry
      // cannot attest species, so for protected refs it requires an
      // approval for EVERY candidate, from a principal other than the
      // (push-credential-bound) author. Previews stay read-only.
      const targetRef = registry.getRef(segments[1]);
      if (targetRef?.policy?.requireHumanApproval && !body.preview) {
        if (init.approvedBy === undefined) {
          return json(res, 403, {
            status: 'policy-failure',
            reason: `ref ${segments[1]} requires an approved review for every merge candidate`,
          });
        }
        const candidateAuthor = getProvenance(registry.loadLayer(body.candidate))?.author.principal;
        if (candidateAuthor === undefined) {
          // Unknown authorship means approver-vs-author separation cannot
          // be verified — fail closed rather than let a de-facto author
          // approve their own manifest-stripped layer.
          return json(res, 403, {
            status: 'policy-failure',
            reason: `candidate ${body.candidate} carries no provenance author; requireHumanApproval refs need attributable candidates`,
          });
        }
        if (init.approvedBy === candidateAuthor) {
          return json(res, 403, {
            status: 'policy-failure',
            reason: `approval by the layer author ${candidateAuthor} does not satisfy requireHumanApproval`,
          });
        }
      }

      let outcome: ReturnType<typeof mergeIntoRef>;
      try {
        outcome = mergeIntoRef(registry, init);
      } catch (err) {
        const handled = handlePushError(res, err);
        if (handled) return handled;
        // The engine refuses malformed edited resolutions (entity-level
        // conflict, relation pseudo-component): a client error, not 500.
        if (err instanceof Error && err.message.includes('edited resolution')) {
          return json(res, 400, { error: err.message });
        }
        throw err;
      }
      switch (outcome.status) {
        case 'fast-forward':
          emitRegistryEvent(webhooks, 'ref.merged', {
            ref: segments[1],
            candidate: body.candidate,
            status: outcome.status,
            auto: false,
          });
          return json(res, 200, { status: outcome.status, layers: outcome.refLayers });
        case 'merged':
          emitRegistryEvent(webhooks, 'ref.merged', {
            ref: segments[1],
            candidate: body.candidate,
            status: outcome.status,
            auto: false,
            merge_layer: outcome.mergeLayerId,
          });
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
    const parsed = parseJson(text);
    if (parsed.error !== undefined) return json(res, 400, { error: `invalid JSON body: ${parsed.error}` });
    const body = parsed.value as
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
    try {
      registry.putReview(review);
    } catch (err) {
      const handled = handlePushError(res, err);
      if (handled) return handled;
      throw err;
    }
    emitRegistryEvent(webhooks, 'review.opened', { id: review.id, layer_id: review.layerId, into: review.into });
    return json(res, 201, { id: review.id });
  }
  // Review comments as BCF topics bound to (review, entity, componentKey?)
  // per 08-review.md §8.6. Reads are open to any authenticated principal
  // (agents consume them via get_review_feedback); writes follow the same
  // named-reviewers gate as decisions.
  if (segments.length === 3 && segments[2] === 'topics') {
    const review = registry.getReview(segments[1]);
    if (!review) return json(res, 404, { error: `no review ${segments[1]}` });
    if (method === 'GET') {
      return json(res, 200, { topics: review.topics ?? [] });
    }
    if (method === 'POST') {
      const actor = principal?.userId ?? 'anonymous';
      if (review.reviewers.length > 0 && !review.reviewers.includes(actor)) {
        return json(res, 403, { error: `only the named reviewers may act on review ${review.id}` });
      }
      const text = await readBody(req, maxBytes);
      if (text === null) return json(res, 413, { error: `body exceeds ${maxBytes} bytes` });
      const parsed = parseJson(text);
      if (parsed.error !== undefined) return json(res, 400, { error: `invalid JSON body: ${parsed.error}` });
      const body = parsed.value as
        | { title?: unknown; description?: unknown; entity?: unknown; component_key?: unknown; viewpoint?: unknown }
        | undefined;
      if (!body || typeof body.title !== 'string' || body.title.trim().length === 0 || typeof body.entity !== 'string') {
        return json(res, 400, { error: 'body must include { title: string, entity: string }' });
      }
      if (body.description !== undefined && typeof body.description !== 'string') {
        return json(res, 400, { error: 'description must be a string when present' });
      }
      if (body.component_key !== undefined && typeof body.component_key !== 'string') {
        return json(res, 400, { error: 'component_key must be a string when present' });
      }
      if (
        body.viewpoint !== undefined &&
        (typeof body.viewpoint !== 'object' || body.viewpoint === null || Array.isArray(body.viewpoint))
      ) {
        return json(res, 400, { error: 'viewpoint must be an object when present' });
      }
      const topic: RegistryReviewTopic = {
        guid: crypto.randomUUID(),
        title: body.title.trim(),
        entity: body.entity,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.component_key !== undefined ? { componentKey: body.component_key } : {}),
        ...(principal ? { author: principal.userId } : {}),
        createdAt: new Date().toISOString(),
        ...(body.viewpoint !== undefined ? { viewpoint: body.viewpoint as Record<string, unknown> } : {}),
      };
      review.topics = [...(review.topics ?? []), topic];
      try {
        registry.putReview(review);
      } catch (err) {
        const handled = handlePushError(res, err);
        if (handled) return handled;
        throw err;
      }
      emitRegistryEvent(webhooks, 'review.commented', { id: review.id, guid: topic.guid, entity: topic.entity });
      return json(res, 201, { guid: topic.guid, topic_count: review.topics.length });
    }
    return json(res, 405, { error: `unsupported ${method} on review topics` });
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
    const parsed = parseJson(text);
    if (parsed.error !== undefined) return json(res, 400, { error: `invalid JSON body: ${parsed.error}` });
    const body = parsed.value as { decisions?: unknown[]; status?: unknown } | undefined;
    if (!body || !Array.isArray(body.decisions)) {
      return json(res, 400, { error: 'body must include { decisions: [...] }' });
    }
    // Stored reviews are a contract for downstream tooling: reject unknown
    // decision shapes and status values instead of persisting them verbatim.
    const decisions: RegistryReviewDecision[] = [];
    for (const item of body.decisions) {
      const decision = parseReviewDecision(item);
      if (!decision) {
        return json(res, 400, {
          error:
            'each decision must be { entity: string, decision: "accept" | "reject", componentKey?: string, comment?: string }',
        });
      }
      decisions.push(decision);
    }
    if (body.status !== undefined && body.status !== 'approved' && body.status !== 'changes-requested') {
      return json(res, 400, { error: 'status must be "approved" or "changes-requested"' });
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
    review.feedback.push(...decisions);
    if (body.status === 'approved' || body.status === 'changes-requested') {
      review.status = body.status;
      // Approval identity is server-recorded, never caller-asserted: the
      // merge endpoint reads it back for requireHumanApproval policies.
      if (body.status === 'approved') review.approvedBy = actor;
      else delete review.approvedBy;
    }
    registry.putReview(review);
    emitRegistryEvent(webhooks, 'review.updated', {
      id: review.id,
      status: review.status,
      decision_count: review.feedback.length,
    });
    return json(res, 200, { id: review.id, status: review.status, decision_count: review.feedback.length });
  }
  return json(res, 405, { error: `unsupported ${method} on reviews` });
}
