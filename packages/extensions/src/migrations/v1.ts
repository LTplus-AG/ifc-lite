/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Migration scaffold for v1. Currently a no-op identity function — v1 is
 * the current schema. When v2 ships, a real migration replaces this and
 * the chain in `migrations/index.ts` gets a new entry.
 *
 * The function exists so we can exercise the chain wiring end-to-end with
 * a unit test even before there is a real migration to perform.
 */

import type { ValidationResult } from '../types.js';

export function migrateV1(
  input: Record<string, unknown>,
): ValidationResult<Record<string, unknown>> {
  return { ok: true, value: input };
}
