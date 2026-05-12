/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ResourceRegistry } from './types.js';
import { defaultResourceProviders } from './providers.js';

export { ResourceRegistry } from './types.js';
export type { ResourceProvider } from './types.js';
export { defaultResourceProviders } from './providers.js';

export function buildDefaultResourceRegistry(): ResourceRegistry {
  const registry = new ResourceRegistry();
  registry.registerAll(defaultResourceProviders());
  return registry;
}
