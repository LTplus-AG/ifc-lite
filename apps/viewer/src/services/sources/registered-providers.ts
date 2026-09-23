/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DaluxBuildProvider } from '@ifc-lite/source-dalux';
import { DropboxProvider } from '@ifc-lite/source-dropbox';
import { MsGraphProvider } from '@ifc-lite/source-msgraph';
import type { FileSourceProviderFactory } from './source-host';

/**
 * Every built-in file-source provider the viewer registers, in one place.
 * Both `SourceHostProvider` (which registers each one at app start, before
 * any host-supplied provider) and `source-host.test.ts` (which asserts each
 * one's manifest satisfies `PLUGIN_API_VERSION`, the regression guard for a
 * host/provider version drifting apart) read from this list — so the test can
 * never drift from what the running app actually does.
 *
 * Host-supplied providers are NOT added here: a host application that builds
 * the viewer from source passes its own factories to `mountViewer` (see
 * `bootstrap.tsx`). They are outside this test's reach by design, so their
 * version compatibility is enforced where every provider's is, at
 * `SourceHost.register()` (#5228).
 *
 * `@ifc-lite/source-dropbox` requires a `clientId` preference (a Dropbox app
 * key), and `@ifc-lite/source-msgraph` requires a `clientId` preference (an
 * Azure AD app registration), to actually sign in. See each package's README
 * for what to register. Registering them here with no client id configured is
 * still correct: the provider shows up with a sign-in affordance that fails
 * with a clear "not configured" message until the deployment sets one, rather
 * than the provider silently not existing.
 */
export const BUILT_IN_PROVIDER_FACTORIES: readonly FileSourceProviderFactory[] = [
  () => new DaluxBuildProvider(),
  () => new DropboxProvider(),
  () => new MsGraphProvider(),
];
