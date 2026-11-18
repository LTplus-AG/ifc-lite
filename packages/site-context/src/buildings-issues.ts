/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The 3D Tiles reader's issues and truncation as buildings-layer issues, grouped so forty failed tiles are one line. */

import type { RegionReadResult } from '@ifc-lite/tiles3d';
import type { SiteContextIssue } from './types.js';

const SHOWN_URLS = 3;

export function readerIssues(res: Pick<RegionReadResult, 'issues' | 'truncated' | 'truncation'>): SiteContextIssue[] {
  const groups = new Map<string, { severity: SiteContextIssue['severity']; count: number; examples: string[] }>();
  for (const i of res.issues) {
    const severity: SiteContextIssue['severity'] = i.severity === 'warning' ? 'warning' : 'error';
    const kind = i.code ?? (/^HTTP \d+/.exec(i.message)?.[0] ?? (i.severity === 'unsupported' ? 'unsupported' : 'read'));
    const key = `${severity}|${kind}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { severity, count: 0, examples: [] }));
    g.count++;
    if (g.examples.length < SHOWN_URLS) g.examples.push(`${i.url}: ${i.message}`);
  }
  const out: SiteContextIssue[] = [];
  for (const [key, g] of groups) {
    const kind = key.slice(key.indexOf('|') + 1);
    out.push({
      code: `tiles-${kind.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      severity: g.severity,
      message: `${g.count} 3D Tiles reader ${g.severity === 'error' ? 'failures' : 'warnings'} (${kind}): ${g.examples.join('; ')}${g.count > g.examples.length ? '; …' : ''}`,
      count: g.count,
    });
  }
  if (res.truncated) {
    const pending = res.truncation?.pendingUrls ?? [];
    out.push({
      code: 'buildings-read-truncated',
      severity: 'warning',
      message: `the tile read stopped at its ${res.truncation?.reason ?? 'budget'} budget; ${pending.length} tiles or subtrees were not fetched, so buildings may be missing (raise the budget to read them)`,
      count: pending.length,
    });
  }
  return out;
}
