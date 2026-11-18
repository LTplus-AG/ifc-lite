/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exhaustiveness for a discriminated union: call it in the branch no member
 * should reach.
 *
 * ```ts
 * switch (run.kind) {
 *   case 'idle': ...; break;
 *   case 'running': ...; break;
 *   default: assertNever(run); // a new kind is a compile error here
 * }
 * ```
 *
 * It throws at runtime too: a value that type-checks as `never` can still
 * arrive from persisted or untyped data, and silently doing nothing with it
 * is the bug this exists to prevent.
 */
export function assertNever(value: never, context = 'Unexpected variant'): never {
  const kind = typeof value === 'object' && value !== null && 'kind' in value ? String((value as { kind: unknown }).kind) : String(value);
  throw new Error(`${context}: ${kind}`);
}
