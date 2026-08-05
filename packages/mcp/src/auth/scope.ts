/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scope-based tool gating.
 *
 * Every tool declares the scope a caller needs (`read`, `validate`, `mutate`,
 * `export`, `admin`). At `tools/list` time we filter the advertised set so a
 * read-only token never even sees the mutation tools — the LLM can't try to
 * call something it isn't allowed to use.
 */

import type { ToolScope } from '../protocol/index.js';

export interface AuthScope {
  scopes: ToolScope[];
  /** Optional model_id allowlist. Empty / undefined = all models. */
  modelIds?: string[];
  /** Audit metadata (user_id, session_id) — copied into log entries. */
  user?: string;
  session?: string;
}

export const FULL_ACCESS: AuthScope = {
  scopes: ['read', 'validate', 'mutate', 'export', 'admin'],
};

export const READ_ONLY: AuthScope = {
  scopes: ['read', 'validate', 'export'],
};

export function scopeAllows(scope: AuthScope, required?: ToolScope): boolean {
  if (!required) return true;
  return scope.scopes.includes(required) || scope.scopes.includes('admin');
}

export function modelAllowed(scope: AuthScope, modelId: string): boolean {
  if (!scope.modelIds || scope.modelIds.length === 0) return true;
  return scope.modelIds.includes(modelId);
}

/* The `scopes` array is copied too, not just the wrapper object: a spread
 * alone hands every caller the SAME array instance as the exported constant,
 * so `readOnlyScope().scopes.push('mutate')` widens `READ_ONLY` itself and
 * every token minted afterwards in the process gets the extra scope. */
export function readOnlyScope(): AuthScope {
  return { ...READ_ONLY, scopes: [...READ_ONLY.scopes] };
}

export function fullScope(): AuthScope {
  return { ...FULL_ACCESS, scopes: [...FULL_ACCESS.scopes] };
}
