/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { digestStrings } from '@/lib/bcf-drafts/draft-footer';

/**
 * A short expected-state token for `value`: its JSON length and a 64-bit digest of that JSON (#10794).
 * A read returns it and a write compares it, so the token stays small however large the state grows.
 * It detects concurrent change in our own store; it is not an integrity check against an adversary.
 */
export function stateRevision(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return `${json.length}:${digestStrings([json])}`;
}

/** Input schema for a {@link stateRevision} token. */
export const revisionInput = { type: 'string' as const, maxLength: 64 };

/** Throw `message` when `value` no longer has the revision the caller read. */
export function assertRevision(value: unknown, expected: string, message: string): void {
  if (stateRevision(value) !== expected) throw new Error(message);
}
