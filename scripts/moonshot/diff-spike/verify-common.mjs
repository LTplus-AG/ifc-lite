/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 trajectory verification: primitives shared by the v1 (per-step) and
 * v2 (checkpointed) verifiers and by the endpoint section.
 *
 * `fail()` is the single machine-readable failure shape every verification
 * path returns (`{ ok: false, failure: { where, reason, details } }`); the
 * tamper battery matches on `failure.reason`, so new checks must add a new
 * reason string rather than reusing a vague one.
 */

import path from 'node:path';
import { PARAMS, NPARAMS } from './carbon-model.mjs';
import { REPO_ROOT } from './build-ifc.mjs';
import { getKernelIdentity } from './trajectory.mjs';

export const { computeNodeHash, verifyCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

export function norm2(v) {
  return Math.sqrt(v.reduce((a, b) => a + b * b, 0));
}

export function fail(where, reason, details) {
  return { ok: false, failure: { where, reason, details } };
}

/** Shared header checks: chain format version, kernel identity pins, start
 *  parameters finite and inside the box. Returns a failure or null. */
export function checkHeader(chain, expectedVersion) {
  if (chain.version !== expectedVersion) {
    return fail('header', 'unsupported-chain-version', { version: chain.version, expected: expectedVersion });
  }
  const local = getKernelIdentity();
  if (chain.kernelVersion !== local.kernelVersion || chain.trustRoot !== local.trustRoot) {
    return fail('header', 'kernel-identity-mismatch', { chain: { kernelVersion: chain.kernelVersion, trustRoot: chain.trustRoot }, local });
  }
  const x = chain.startParams;
  if (!Array.isArray(x) || x.length !== NPARAMS || x.some((v) => !Number.isFinite(v))) {
    return fail('header', 'bad-start-params', { startParams: x });
  }
  for (let i = 0; i < NPARAMS; i++) {
    if (x[i] < PARAMS[i].lo || x[i] > PARAMS[i].hi) {
      return fail('header', 'start-params-out-of-box', { param: PARAMS[i].name, value: x[i] });
    }
  }
  return null;
}
