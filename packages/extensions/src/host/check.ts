/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-method capability check.
 *
 * The sandbox permission flag is the outer ring (whole-namespace
 * on/off). This is the inner ring: for any `bim.<ns>.<method>` invocation,
 * derive the capability the call requires (via the inference catalogue)
 * and verify the granted set covers it.
 *
 * Used by the activation runtime when wrapping the SDK before exposing
 * it to extension code. A call that fails the check throws
 * `CapabilityDeniedError` so the extension fails fast and visibly
 * (rather than silently succeeding against an over-permissive sandbox
 * flag).
 *
 * Spec: docs/architecture/ai-customization/02-security.md §3.3
 * (no ambient authority).
 */

import { matchCapability } from '../capability/match.js';
import { parseCapability } from '../capability/parse.js';
import type { Capability } from '../types.js';
import { lookupNamespaceMethod } from '../inference/catalogue.js';

export class CapabilityDeniedError extends Error {
  readonly call: string;
  readonly requiredCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];

  constructor(
    call: string,
    requiredCapabilities: readonly string[],
    grantedCapabilities: readonly string[],
  ) {
    super(
      `Capability denied for ${call}. ` +
      `Requires one of: ${requiredCapabilities.join(', ') || '(unknown)'}. ` +
      `Granted: ${grantedCapabilities.join(', ') || '(none)'}.`,
    );
    this.name = 'CapabilityDeniedError';
    this.call = call;
    this.requiredCapabilities = requiredCapabilities;
    this.grantedCapabilities = grantedCapabilities;
  }
}

/**
 * Check that `grants` covers the capability required to call
 * `bim.<namespace>.<method>`. Returns `{ ok: true }` on pass or an
 * error value on fail.
 */
export function checkMethodCall(
  namespace: string,
  method: string,
  grants: readonly Capability[],
): { ok: true } | { ok: false; required: readonly string[] } {
  const required = lookupNamespaceMethod(namespace, method);
  if (required.length === 0) {
    // No capability required for this method (e.g. lens.presets).
    return { ok: true };
  }

  // The method is satisfied iff the grant set covers AT LEAST ONE of
  // the required capabilities. (Methods rarely require more than one;
  // when they do, any one of them suffices.)
  for (const reqRaw of required) {
    const parsed = parseCapability(reqRaw);
    if (!parsed.ok) continue;
    for (const grant of grants) {
      if (matchCapability(grant, parsed.value)) return { ok: true };
    }
  }
  return { ok: false, required };
}

/**
 * Throw if a method call would be denied. Convenience for bridge
 * wrappers — most callers want fail-fast not a Result.
 */
export function assertMethodCall(
  namespace: string,
  method: string,
  grants: readonly Capability[],
): void {
  const result = checkMethodCall(namespace, method, grants);
  if (result.ok) return;
  throw new CapabilityDeniedError(
    `bim.${namespace}.${method}`,
    result.required,
    grants.map((g) => g.raw),
  );
}
