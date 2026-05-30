/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolRegistry } from './types.js';
import { discoveryTools } from './discovery.js';
import { queryTools } from './query.js';
import { geometryTools } from './geometry.js';
import { clashTools } from './clash.js';
import { validationTools } from './validation.js';
import { mutationTools } from './mutate.js';
import { bcfTools } from './bcf.js';
import { bsddTools } from './bsdd.js';
import { diffTools } from './diff.js';
import { exportTools } from './export.js';
import { viewerTools } from './viewer.js';

export { ToolRegistry } from './types.js';
export type { Tool } from './types.js';

export {
  discoveryTools,
  queryTools,
  geometryTools,
  clashTools,
  validationTools,
  mutationTools,
  bcfTools,
  bsddTools,
  diffTools,
  exportTools,
  viewerTools,
};

/**
 * Build a ToolRegistry pre-loaded with every tool ifc-lite-mcp ships in v0.1.
 * Callers can pass through to `MCPServerOptions.tools`, or filter by category
 * for narrower deployments (e.g. read-only public mirror).
 */
export function buildDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(discoveryTools);
  registry.registerAll(queryTools);
  registry.registerAll(geometryTools);
  registry.registerAll(clashTools);
  registry.registerAll(validationTools);
  registry.registerAll(mutationTools);
  registry.registerAll(bcfTools);
  registry.registerAll(bsddTools);
  registry.registerAll(diffTools);
  registry.registerAll(exportTools);
  registry.registerAll(viewerTools);
  return registry;
}
