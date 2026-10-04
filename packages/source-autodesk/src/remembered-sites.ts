/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PluginContext, SourceProject } from '@ifc-lite/plugin-api';
import { parseAddress } from './refs.js';
const MAX_SITES = 50;
function key(identity: string) { return `sites:v1:${encodeURIComponent(identity)}`; }
export async function rememberedSites(ctx: PluginContext, identity: string): Promise<SourceProject[]> {
  const raw = await ctx.storage.get(key(identity));
  if (!raw) return [];
  try {
    if (raw.length > 256_000) throw new Error('Site bookmark size limit');
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > MAX_SITES) throw new Error('Site bookmark count limit');
    return values.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid bookmark');
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || entry.name.length > 1024 || parseAddress(entry.id).kind !== 'site') throw new Error('Invalid site bookmark');
      return { id: entry.id, name: entry.name, description: 'Forma Site Design · saved site' };
    });
  } catch (error) {
    ctx.log.warn('Saved Autodesk sites could not be read', error instanceof Error ? error.name : 'Invalid bookmark');
    return [];
  }
}
export async function rememberSite(ctx: PluginContext, identity: string, project: SourceProject): Promise<void> {
  const existing = await rememberedSites(ctx, identity);
  const sites = [{ id: project.id, name: project.name }, ...existing.filter((site) => site.id !== project.id)].slice(0, MAX_SITES);
  await ctx.storage.set(key(identity), JSON.stringify(sites));
}
