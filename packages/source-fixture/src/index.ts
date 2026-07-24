/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { createFixtureSourceProvider } from './provider.js';
export type {
  FixtureCapabilityOptions,
  FixtureController,
  FixtureManifestOverrides,
  FixtureProviderOptions,
  FixtureSourceProvider,
} from './provider.js';

export type {
  FixtureContainerSpec,
  FixtureFileSpec,
  FixtureProjectSpec,
  FixtureRevisionSpec,
  FixtureWorldSpec,
} from './data.js';

export { FixtureApiError } from './errors.js';
export type { FixtureMethodName, InjectedFailure } from './failures.js';

export { createFixtureAuth, DEFAULT_FIXTURE_IDENTITY } from './auth.js';
export { createFixtureContext } from './context.js';
export type { FixtureContextOverrides } from './context.js';
export { buildFixtureManifest } from './manifest.js';
export type { FixtureManifestOptions } from './manifest.js';
