/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capability matching.
 *
 * Given a grant set (capabilities the user approved) and a request
 * (capability the extension wants to invoke), decide whether the grant
 * covers the request.
 *
 * Matching rules:
 *   - Scope and action must match exactly.
 *   - If the grant has no target, the request must also have no target.
 *   - If the grant has a target, the request must have a target the
 *     grant's pattern covers.
 *   - The universal wildcard `*` covers any target.
 *   - Segment matching: literal segments must match string-for-string;
 *     segments ending in `*` match any segment with that prefix; a bare
 *     `*` segment matches a single non-empty segment.
 *
 * The matcher is intentionally not symmetric: `model.mutate:Pset_*`
 * grants `model.mutate:Pset_WallCommon.FireRating` but not vice versa.
 *
 * Spec: docs/architecture/ai-customization/02-security.md §3.
 */

import type {
  Capability,
  CapabilityTarget,
  CapabilityTargetSegment,
} from '../types.js';

/**
 * Returns true iff `grant` covers `requested`.
 *
 * The grant is the user-approved capability; the requested is what the
 * extension is invoking. Mismatched scope/action returns false. Target
 * patterns are matched per segment.
 */
export function matchCapability(grant: Capability, requested: Capability): boolean {
  if (grant.scope !== requested.scope) return false;
  if (grant.action !== requested.action) return false;

  if (!grant.target) {
    // Grant has no target: request must also have no target.
    return !requested.target;
  }

  if (grant.target.isUniversalWildcard) return true;

  if (!requested.target) {
    // Requested has no target but the grant does: a target-less request is
    // narrower than any target pattern, so it cannot satisfy a grant that
    // requires a specific target. We treat this as a non-match.
    return false;
  }

  return matchTarget(grant.target, requested.target);
}

/**
 * Returns the first matching grant for the given request, or undefined if
 * no grant covers it.
 */
export function findGrant(
  grants: readonly Capability[],
  requested: Capability,
): Capability | undefined {
  for (const grant of grants) {
    if (matchCapability(grant, requested)) return grant;
  }
  return undefined;
}

/**
 * Convenience: true iff any grant in the set covers the request.
 */
export function hasCapability(
  grants: readonly Capability[],
  requested: Capability,
): boolean {
  return findGrant(grants, requested) !== undefined;
}

function matchTarget(grant: CapabilityTarget, requested: CapabilityTarget): boolean {
  if (grant.isUniversalWildcard) return true;

  const a = grant.segments;
  const b = requested.segments;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!matchSegment(a[i], b[i])) return false;
  }
  return true;
}

function matchSegment(
  grant: CapabilityTargetSegment,
  requested: CapabilityTargetSegment,
): boolean {
  if (grant.kind === 'glob') return true;

  // grant.kind === 'literal'
  if (requested.kind === 'glob') {
    // The requested side cannot be a glob unless we are comparing two
    // patterns. A request from runtime should never be a glob; we treat
    // it as non-matching to avoid privilege confusion.
    return false;
  }

  const grantValue = grant.value;
  const requestedValue = requested.value;
  if (grantValue.endsWith('*')) {
    const prefix = grantValue.slice(0, -1);
    return requestedValue.startsWith(prefix);
  }
  return grantValue === requestedValue;
}
