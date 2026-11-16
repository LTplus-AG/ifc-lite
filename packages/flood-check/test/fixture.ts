/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fetched fixtures (`tests/models/manifest.json`), never a silent skip. A
 * fixture that is absent fails the test file when `IFC_LITE_REQUIRE_FIXTURES`
 * is "1" (the CI job that fetches and verifies every fixture sets it, as the
 * export package's fixture policy does); otherwise the tests that need it skip
 * with a warning naming the command that fetches it.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The same parse as the export package (#6692): only "1" requires, only unset, "" or "0" allow a skip. */
export function requireFixtures(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`IFC_LITE_REQUIRE_FIXTURES=${JSON.stringify(value)} is not recognised (use "1" or "0"); refusing to silently disable fixture coverage`);
}

/** A fixture by its path under `tests/models/`: where it is, and whether the tests needing it may run. */
export function fixture(relative: string, env: string | undefined = process.env.IFC_LITE_REQUIRE_FIXTURES): { path: string; present: boolean } {
  const path = fileURLToPath(new URL(`../../../tests/models/${relative}`, import.meta.url));
  const present = existsSync(path);
  if (!present) {
    const fetch = `node scripts/fixtures/fetch-fixtures.mjs ${relative}   (or: pnpm fixtures)`;
    if (requireFixtures(env)) throw new Error(`fixture tests/models/${relative} is missing and IFC_LITE_REQUIRE_FIXTURES=1; fetch it with: ${fetch}`);
    console.warn(`\n⚠ SKIPPING the tests that need tests/models/${relative}: the fixture is not fetched. Fetch it with: ${fetch}\n`);
  }
  return { path, present };
}
