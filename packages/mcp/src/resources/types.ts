/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ResourceContents, ResourceDefinition } from '../protocol/index.js';
import type { ToolContext } from '../context.js';

/**
 * A ResourceProvider can either:
 *   - enumerate concrete resources (`list()`) — useful for static resources
 *   - resolve URIs by pattern (`match()` + `read()`) — for dynamic ones
 *     (e.g. `ifc-lite://model/{id}/entity/{globalId}`)
 *
 * Most providers do both: they enumerate the "manifest" resources and serve
 * any URI that matches their patterns.
 */
export interface ResourceProvider {
  /** Stable name for diagnostics. */
  name: string;
  /** Static resources advertised in `resources/list`. */
  list(ctx: ToolContext): Promise<ResourceDefinition[]> | ResourceDefinition[];
  /** True iff this provider can read the given URI. */
  match(uri: string): boolean;
  /** Read the resource. Throws when uri doesn't match. */
  read(uri: string, ctx: ToolContext): Promise<ResourceContents[]> | ResourceContents[];
}

export class ResourceRegistry {
  private providers: ResourceProvider[] = [];

  register(provider: ResourceProvider): void {
    this.providers.push(provider);
  }

  registerAll(providers: ResourceProvider[]): void {
    for (const p of providers) this.register(p);
  }

  async list(ctx: ToolContext): Promise<ResourceDefinition[]> {
    const all: ResourceDefinition[] = [];
    for (const p of this.providers) {
      const items = await p.list(ctx);
      for (const item of items) all.push(item);
    }
    return all;
  }

  matchProvider(uri: string): ResourceProvider | null {
    for (const p of this.providers) {
      if (p.match(uri)) return p;
    }
    return null;
  }
}
