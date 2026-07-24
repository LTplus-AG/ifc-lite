/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Certificate v0 (docs/vision/spec/node-hash-v0.md §Step 3 / M1
 * "proof-carrying changes", docs/vision/moonshots-tech.md §M1).
 *
 * A certificate ships alongside a model change: the set of DAG node hashes
 * it read, the set it wrote, and a list of machine-checkable claims about
 * what did or didn't change. `verifyCertificate` never trusts the
 * certificate's own numbers — it re-derives every referenced hash from a
 * caller-supplied `resolver` (an async `nodeId -> payload` lookup) via
 * {@link hashResolvedNode} and fails on any mismatch, tampered claim, or
 * trust-root mismatch.
 */

import { hashResolvedNode, type ResolvedNode } from './node-hash.js';

export const CERTIFICATE_VERSION = 'node-hash-v0';

/** A DAG node id paired with its (claimed) canonical hash. */
export interface NodeRef {
  nodeId: string;
  /** A tagged hash string, e.g. `"fnv1a64:0x..."` or `"sha256:..."`. */
  hash: string;
}

/** Async node lookup the verifier uses to recompute hashes from real data.
 *  Returns `undefined` for an id it cannot resolve (verification fails). */
export type NodeResolver = (nodeId: string) => Promise<ResolvedNode | undefined>;

/** A named subtree's hashes must recompute unchanged. */
export interface SubtreeUntouchedClaim {
  type: 'subtree-untouched';
  nodes: readonly NodeRef[];
}

/** Two (possibly distinct) nodes resolve to the identical hash — e.g. "this
 *  door and that door are the same geometry" for dedup/memoization claims. */
export interface HashEqualityClaim {
  type: 'hash-equality';
  a: NodeRef;
  b: NodeRef;
}

/** The registered scalar-metric vocabulary (spec §6 decision Q3 2026-07-24).
 *  `net-volume` and `element-count` read fixed property names (`NetVolume`,
 *  `ElementCount`); `property-numeric` reads the claim's own `property`. */
export type ScalarMetric = 'net-volume' | 'element-count' | 'property-numeric';

const METRIC_PROPERTY_NAME: Record<Exclude<ScalarMetric, 'property-numeric'>, string> = {
  'net-volume': 'NetVolume',
  'element-count': 'ElementCount',
};

/** A registered scalar metric moved from `before` to `after` by exactly
 *  `delta`. Per decision Q3 (2026-07-24) the node bindings are MANDATORY: a
 *  scalar claim that does not bind to DAG nodes is a free-floating assertion,
 *  which is against the spirit of the whole scheme. The verifier checks that
 *  `beforeNodeId`/`afterNodeId` resolve to `property-set` payloads carrying
 *  the metric's property with values matching `before`/`after`. Deltas the
 *  verifier derives itself from geometry diffs are a B1.1/B1.4 concern. */
export interface ScalarDeltaClaim {
  type: 'scalar-delta';
  metric: ScalarMetric;
  /** Required when `metric` is `property-numeric`: the property name read
   *  from the bound property-set payloads. Forbidden otherwise. */
  property?: string;
  before: number;
  after: number;
  delta: number;
  beforeNodeId: string;
  afterNodeId: string;
}

export type Claim = SubtreeUntouchedClaim | HashEqualityClaim | ScalarDeltaClaim;

/** Reserved signature slot (spec §6 decision Q5 2026-07-24): mirrors the
 *  `packages/ifcx` provenance-manifest signature shape (`alg`/`key`/`sig`,
 *  see `canonical.ts`'s "signatures sign the id" rule) so the codebase keeps
 *  one signature idiom. v0 verification IGNORES this field entirely — actual
 *  signing lands with M4 (encrypted multiplayer, Phase 2); key custody is a
 *  human-calendar item. */
export interface CertificateSignature {
  alg: 'ed25519';
  key: string;
  sig: string;
}

/** Certificate v0. `kernelVersion` and `trustRoot` are pinned separately
 *  (spec §4): `kernelVersion` identifies the geometry-kernel build,
 *  `trustRoot` is that kernel's own predicate-sign manifest hash
 *  (`rust/geometry/src/kernel/manifest.rs::indirect_sign_manifest`) — hashes
 *  are only comparable when both match between creation and verification. */
export interface Certificate {
  version: typeof CERTIFICATE_VERSION;
  kernelVersion: string;
  trustRoot: string;
  reads: readonly NodeRef[];
  writes: readonly NodeRef[];
  claims: readonly Claim[];
  /** Reserved, ignored by v0 verification — see {@link CertificateSignature}. */
  signatures?: readonly CertificateSignature[];
}

export interface CreateCertificateInput {
  kernelVersion: string;
  trustRoot: string;
  reads: readonly NodeRef[];
  writes: readonly NodeRef[];
  claims: readonly Claim[];
  signatures?: readonly CertificateSignature[];
}

const HASH_TAG_PATTERN = /^(fnv1a64|sha256):/;

function assertTaggedHash(ref: NodeRef, where: string): void {
  if (!HASH_TAG_PATTERN.test(ref.hash)) {
    throw new Error(
      `@ifc-lite/provenance: ${where} node "${ref.nodeId}" has an untagged hash "${ref.hash}" ` +
        `(expected "fnv1a64:..." or "sha256:...")`,
    );
  }
}

/**
 * Build a v0 certificate. Performs only structural validation (every ref's
 * hash is tagged with a known algorithm) — it does not itself recompute
 * anything from a resolver; that's `verifyCertificate`'s job, on purpose, so
 * a certificate can be created "offline" from whatever hashes the caller
 * already has (e.g. produced during the edit itself) and verified later,
 * independently, possibly by a different party.
 */
export function createCertificate(input: CreateCertificateInput): Certificate {
  for (const ref of input.reads) assertTaggedHash(ref, 'read');
  for (const ref of input.writes) assertTaggedHash(ref, 'write');
  for (const claim of input.claims) {
    if (claim.type === 'subtree-untouched') {
      for (const ref of claim.nodes) assertTaggedHash(ref, 'subtree-untouched claim');
    } else if (claim.type === 'hash-equality') {
      assertTaggedHash(claim.a, 'hash-equality claim');
      assertTaggedHash(claim.b, 'hash-equality claim');
    } else {
      // scalar-delta (decision Q3 2026-07-24): registered vocabulary +
      // mandatory node bindings, validated at creation so a malformed claim
      // never travels.
      if (!['net-volume', 'element-count', 'property-numeric'].includes(claim.metric)) {
        throw new Error(
          `@ifc-lite/provenance: scalar-delta metric "${String(claim.metric)}" is not in the ` +
            `registered vocabulary (net-volume, element-count, property-numeric)`,
        );
      }
      if (claim.metric === 'property-numeric' && !claim.property) {
        throw new Error(
          '@ifc-lite/provenance: scalar-delta with metric "property-numeric" requires `property`',
        );
      }
      if (claim.metric !== 'property-numeric' && claim.property !== undefined) {
        throw new Error(
          `@ifc-lite/provenance: scalar-delta metric "${claim.metric}" must not carry \`property\``,
        );
      }
      if (!claim.beforeNodeId || !claim.afterNodeId) {
        throw new Error(
          '@ifc-lite/provenance: scalar-delta claims must bind beforeNodeId and afterNodeId ' +
            '(free-floating scalar assertions are not certifiable — decision Q3)',
        );
      }
    }
  }
  return {
    version: CERTIFICATE_VERSION,
    kernelVersion: input.kernelVersion,
    trustRoot: input.trustRoot,
    reads: input.reads,
    writes: input.writes,
    claims: input.claims,
    ...(input.signatures !== undefined ? { signatures: input.signatures } : {}),
  };
}

export interface VerifyOptions {
  /** If supplied, verification fails immediately when it doesn't match
   *  `certificate.trustRoot` — the caller's "this is the kernel build I
   *  actually trust" pin (spec §4). */
  expectedTrustRoot?: string;
  /** Same idea for `certificate.kernelVersion`. */
  expectedKernelVersion?: string;
}

export interface VerificationOk {
  ok: true;
}

export interface VerificationFailure {
  ok: false;
  reason: string;
  details?: unknown;
}

export type VerificationResult = VerificationOk | VerificationFailure;

function fail(reason: string, details?: unknown): VerificationFailure {
  return { ok: false, reason, details };
}

async function verifyNodeRef(
  ref: NodeRef,
  resolver: NodeResolver,
  where: string,
): Promise<VerificationFailure | undefined> {
  const resolved = await resolver(ref.nodeId);
  if (!resolved) return fail(`unresolvable-node`, { where, nodeId: ref.nodeId });
  const recomputed = await hashResolvedNode(resolved);
  if (recomputed !== ref.hash) {
    return fail('hash-mismatch', { where, nodeId: ref.nodeId, expected: ref.hash, actual: recomputed });
  }
  return undefined;
}

function extractMetric(resolved: ResolvedNode, claim: ScalarDeltaClaim): number | undefined {
  if (resolved.kind !== 'property-set') return undefined;
  const propertyName =
    claim.metric === 'property-numeric'
      ? claim.property
      : METRIC_PROPERTY_NAME[claim.metric];
  if (!propertyName) return undefined;
  const prop = resolved.payload.properties.find((p) => p.name === propertyName);
  return typeof prop?.value === 'number' ? prop.value : undefined;
}

async function verifyClaim(claim: Claim, resolver: NodeResolver): Promise<VerificationFailure | undefined> {
  if (claim.type === 'subtree-untouched') {
    for (const ref of claim.nodes) {
      const failure = await verifyNodeRef(ref, resolver, 'claim:subtree-untouched');
      if (failure) return failure;
    }
    return undefined;
  }

  if (claim.type === 'hash-equality') {
    if (claim.a.hash !== claim.b.hash) {
      return fail('claim-hash-equality-not-equal', { a: claim.a, b: claim.b });
    }
    const failureA = await verifyNodeRef(claim.a, resolver, 'claim:hash-equality:a');
    if (failureA) return failureA;
    const failureB = await verifyNodeRef(claim.b, resolver, 'claim:hash-equality:b');
    if (failureB) return failureB;
    return undefined;
  }

  // scalar-delta
  const expectedDelta = claim.after - claim.before;
  if (Math.abs(expectedDelta - claim.delta) > 1e-9) {
    return fail('claim-scalar-delta-arithmetic', {
      before: claim.before,
      after: claim.after,
      delta: claim.delta,
      expectedDelta,
    });
  }
  // Bindings are mandatory (decision Q3) — no branch for their absence.
  const before = await resolver(claim.beforeNodeId);
  if (!before) return fail('unresolvable-node', { where: 'claim:scalar-delta:before', nodeId: claim.beforeNodeId });
  const beforeValue = extractMetric(before, claim);
  if (beforeValue === undefined || Math.abs(beforeValue - claim.before) > 1e-9) {
    return fail('claim-scalar-delta-before-mismatch', {
      nodeId: claim.beforeNodeId,
      metric: claim.metric,
      expected: claim.before,
      actual: beforeValue,
    });
  }
  const after = await resolver(claim.afterNodeId);
  if (!after) return fail('unresolvable-node', { where: 'claim:scalar-delta:after', nodeId: claim.afterNodeId });
  const afterValue = extractMetric(after, claim);
  if (afterValue === undefined || Math.abs(afterValue - claim.after) > 1e-9) {
    return fail('claim-scalar-delta-after-mismatch', {
      nodeId: claim.afterNodeId,
      metric: claim.metric,
      expected: claim.after,
      actual: afterValue,
    });
  }
  return undefined;
}

/**
 * Verify a certificate against a live `resolver`. Fails on:
 *
 * - a trust-root or kernel-version mismatch against `options` (checked
 *   first, before touching the resolver at all — see spec §4);
 * - any `reads`/`writes` entry whose recomputed hash doesn't match what the
 *   certificate claims (a tampered payload, or a tampered ref);
 * - any claim that doesn't hold against the resolver (a tampered claim, a
 *   tampered payload underneath it, or an internally inconsistent claim).
 *
 * Never throws for a verification failure — throwing is reserved for
 * programmer errors (an unknown node kind, an unavailable WebCrypto). A
 * failed verification is a normal, expected return value.
 */
export async function verifyCertificate(
  certificate: Certificate,
  resolver: NodeResolver,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  if (options.expectedTrustRoot !== undefined && options.expectedTrustRoot !== certificate.trustRoot) {
    return fail('trust-root-mismatch', {
      expected: options.expectedTrustRoot,
      actual: certificate.trustRoot,
    });
  }
  if (
    options.expectedKernelVersion !== undefined &&
    options.expectedKernelVersion !== certificate.kernelVersion
  ) {
    return fail('kernel-version-mismatch', {
      expected: options.expectedKernelVersion,
      actual: certificate.kernelVersion,
    });
  }

  for (const ref of certificate.reads) {
    const failure = await verifyNodeRef(ref, resolver, 'reads');
    if (failure) return failure;
  }
  for (const ref of certificate.writes) {
    const failure = await verifyNodeRef(ref, resolver, 'writes');
    if (failure) return failure;
  }
  for (const claim of certificate.claims) {
    const failure = await verifyClaim(claim, resolver);
    if (failure) return failure;
  }

  return { ok: true };
}
