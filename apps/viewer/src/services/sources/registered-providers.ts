/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FileSourceProvider } from '@ifc-lite/plugin-api';

/**
 * Every file-source provider the viewer actually registers, in one place.
 * Both `SourceHostProvider` (which registers each one at app start) and
 * `source-host.test.ts` (which asserts each one's manifest satisfies
 * `PLUGIN_API_VERSION`, the regression guard for a host/provider version
 * drifting apart) read from this list — so the test can never drift from
 * what the running app actually does.
 *
 * Deliberately EMPTY in this change: it lands the contract, the host and the
 * UI, and the first providers follow in their own reviewable PRs
 * (`@ifc-lite/source-dalux`, then `@ifc-lite/source-msgraph`). The Sources
 * panel renders its empty state until one is added, and the conformance kit
 * in `@ifc-lite/source-fixture` exercises the host against a fixture provider
 * meanwhile, so the host is covered without shipping a real integration.
 */
export function createRegisteredProviders(): FileSourceProvider[] {
  return [];
}
