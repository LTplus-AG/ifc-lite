/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure kind/policy registry: the database must not import runtime artifact codecs. */
export const CONTENT_POLICIES = {
  validation: { immutableEvidence: true },
  comparison: { immutableEvidence: true },
  document: { immutableEvidence: false },
  assistant: { immutableEvidence: false },
} as const;
export type ContentKind = keyof typeof CONTENT_POLICIES;
export const CONTENT_KINDS: readonly ContentKind[] = Object.keys(CONTENT_POLICIES) as ContentKind[];
export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === 'string' && Object.hasOwn(CONTENT_POLICIES, value);
}
