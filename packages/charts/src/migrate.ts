/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Version 1 -> 2 dashboard migration (#4946).
 *
 * Version 2 adds `ChartSpec.filter` (a per-chart selector) and drops the
 * `list` scope kind: the per-chart filter supersedes it, and there is no
 * resolver left to run a `list` scope through (`ChartsPanel.tsx` deleted the
 * scaffold in the same change). A version-1 object becomes version 2 by
 * bumping the tag; a persisted `list` scope — which nothing could have
 * produced through the UI, since the scaffold never wired a resolver — falls
 * back to `all` rather than fail the whole dashboard to load.
 *
 * Called before `validateDashboardSpec`, never after: a reader that skips
 * this and hands a raw version-1 object to validation gets refused loudly
 * (`expected version 2`), which is the point — there is exactly one path in.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `raw` as read from storage or a file, promoted to version 2 if it is a
 *  version-1 object; anything else (already version 2, or not a dashboard at
 *  all) passes through untouched for `validateDashboardSpec` to judge. */
export function migrateDashboardSpec(raw: unknown): unknown {
  if (!isRecord(raw) || raw.version !== 1) return raw;
  const scope = isRecord(raw.scope) && raw.scope.kind === 'list' ? { kind: 'all' } : raw.scope;
  return { ...raw, version: 2, scope };
}
