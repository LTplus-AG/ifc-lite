/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RegistryError } from './protocol';

export interface RegistryGrant { repositories: string[]; tags?: string[]; actions: ('pull' | 'push')[] }

export function parseGrants(value: unknown): RegistryGrant[] {
  if (!Array.isArray(value) || value.length > 128) throw new RegistryError('Invalid registry permissions.');
  return value.map((rule: unknown) => {
    if (!rule || typeof rule !== 'object' || !('repositories' in rule) || !Array.isArray(rule.repositories) || !rule.repositories.length || rule.repositories.length > 32 ||
      !('actions' in rule) || !Array.isArray(rule.actions) || !rule.actions.length || rule.actions.length > 2 ||
      !rule.actions.every((a: unknown) => a === 'pull' || a === 'push')) throw new RegistryError('Invalid registry permission rule.');
    const repositories: string[] = rule.repositories.map((p: unknown) => {
      if (typeof p !== 'string' || p.length > 255 || !p.split('/').every(c => c === '**' || /^[a-z0-9*][a-z0-9._*-]*$/.test(c) && !c.includes('**'))) throw new RegistryError('Invalid repository selector.');
      return p;
    });
    let tags: string[] | undefined;
    if ('tags' in rule) {
      if (!Array.isArray(rule.tags) || !rule.tags.length || rule.tags.length > 32) throw new RegistryError('Invalid tag selectors.');
      tags = rule.tags.map((t: unknown) => { if (typeof t !== 'string' || !/^[A-Za-z0-9_*][A-Za-z0-9_.*-]{0,127}$/.test(t)) throw new RegistryError('Invalid tag selector.'); return t; });
    }
    const actions = rule.actions.filter((a: unknown): a is 'pull' | 'push' => a === 'pull' || a === 'push');
    return { repositories, tags, actions };
  });
}

export function wildcard(pattern: string, value: string): boolean {
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < value.length) {
    if (pattern[i] === value[j]) { i++; j++; }
    else if (pattern[i] === '*') { star = i++; retry = j; }
    else if (star >= 0) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (pattern[i] === '*') i++;
  return i === pattern.length;
}

export function repositoryMatches(pattern: string, repository: string): boolean {
  if (pattern.endsWith('/**') && repository === pattern.slice(0, -3)) return false;
  const values = repository.split('/'); let row = values.map(() => false); row.unshift(true);
  const parts = pattern.split('/');
  for (const [index, p] of parts.entries()) {
    const next = row.map(() => false);
    if (p === '**') { const descendant = index + 1 === parts.length && parts.length > 1; next[0] = row[0] && !descendant; for (let j = 1; j < row.length; j++) next[j] = (descendant ? row[j - 1] : row[j]) || next[j - 1]; }
    else for (let j = 1; j < row.length; j++) next[j] = row[j - 1] && wildcard(p, values[j - 1]);
    row = next;
  }
  return row[values.length];
}

export function grantAllows(grants: RegistryGrant[], repository: string, action: 'pull' | 'push', tag?: string): boolean {
  return grants.some(g => g.actions.includes(action) && g.repositories.some(p => repositoryMatches(p, repository)) &&
    (tag === undefined || g.tags === undefined || g.tags.some(t => wildcard(t, tag))));
}
