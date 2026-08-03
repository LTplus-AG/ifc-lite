/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FileSourceProvider } from '@ifc-lite/plugin-api';
import { DaluxBuildProvider } from '@ifc-lite/source-dalux';

/**
 * Every file-source provider the viewer actually registers, in one place.
 * Both `SourceHostProvider` (which registers each one at app start) and
 * `source-host.test.ts` (which asserts each one's manifest satisfies
 * `PLUGIN_API_VERSION`, the regression guard for a host/provider version
 * drifting apart) read from this list — so the test can never drift from
 * what the running app actually does.
 *
 * `@ifc-lite/source-msgraph` (SharePoint/OneDrive) follows in its own PR.
 */
export function createRegisteredProviders(): FileSourceProvider[] {
  return [new DaluxBuildProvider()];
}
