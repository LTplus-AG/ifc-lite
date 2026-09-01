/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Epsilon-pin check for `verifyCommutationCertificate` (./commutation.ts).
 *
 * `CommutationCertificate.epsilonMm` DOES travel in the certificate (it is
 * part of the audit trail -- "the epsilon the no-conflict check was run
 * at") but nothing binds it: a certificate creator picks its own value and
 * the certificate self-verifies against exactly that value. Re-deriving the
 * expectation from the certificate's own field would make a check a
 * tautology -- the same reasoning that already keeps `spatialRule` and
 * `semantics` OUT of the certificate entirely (see commutation.ts), and that
 * motivated `expectedTrustRoot`/`expectedKernelVersion` in certificate.ts
 * and `expectedClientA`/`expectedClientB` in commutation.ts's own client
 * attribution check.
 *
 * A certificate minted with a looser `epsilonMm` than the real policy value
 * verifies "ok: true" for an op pair the intended policy epsilon would
 * correctly flag as a spatial conflict -- undetectable unless a verifier
 * pins its own expected epsilon here. Split out of commutation.ts to keep
 * that file's module-size budget flat rather than raising it.
 */

import type { CommutationCertificate } from './commutation.js';

// Module augmentation: adds `expectedEpsilonMm` to `CommutationVerifyOptions`
// without spending commutation.ts's own module-size budget on the field.
declare module './commutation.js' {
  interface CommutationVerifyOptions {
    /** Caller-owned policy epsilon (mm), checked against
     *  `certificate.epsilonMm` when supplied -- see this file's module
     *  docstring for why the expectation can't be derived from the
     *  certificate itself. */
    expectedEpsilonMm?: number;
  }
}

/** `undefined` when the pin passes (or none was supplied); otherwise the
 *  `{reason, details}` shape `verifyCommutationCertificate` returns as-is. */
export interface EpsilonPinFailure {
  reason: 'epsilon-mismatch';
  details: { expected: number; actual: number };
}

/**
 * Check `certificate.epsilonMm` against a verifier-supplied expectation.
 * `expectedEpsilonMm: undefined` means the caller stated no policy -- passes
 * unconditionally, same as `expectedTrustRoot`/`expectedClientA` when
 * omitted.
 */
export function checkEpsilonPin(
  expectedEpsilonMm: number | undefined,
  certificate: CommutationCertificate,
): EpsilonPinFailure | undefined {
  if (expectedEpsilonMm === undefined || expectedEpsilonMm === certificate.epsilonMm) return undefined;
  return { reason: 'epsilon-mismatch', details: { expected: expectedEpsilonMm, actual: certificate.epsilonMm } };
}
