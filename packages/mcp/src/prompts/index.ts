/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PromptRegistry } from './types.js';
import { allPrompts } from './templates.js';

export { PromptRegistry } from './types.js';
export type { Prompt } from './types.js';
export { allPrompts } from './templates.js';

export function buildDefaultPromptRegistry(): PromptRegistry {
  const registry = new PromptRegistry();
  registry.registerAll(allPrompts);
  return registry;
}
