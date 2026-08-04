/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scope gating is the only thing standing between a read-only or
 * model-narrowed token and the full tool surface, and until now every test in
 * the package built its context with `fullScope()` or `readOnlyScope()` —
 * neither of which sets `modelIds`. The per-model allowlist could therefore be
 * deleted outright (`modelAllowed` → `return true`) and the suite stayed green,
 * as could the `admin` escalation arm of `scopeAllows`, because no fixture ever
 * held a scope that needed it.
 */

import { describe, expect, it } from 'vitest';
import {
  FULL_ACCESS,
  READ_ONLY,
  fullScope,
  modelAllowed,
  readOnlyScope,
  scopeAllows,
  type AuthScope,
} from './scope.js';

describe('scopeAllows', () => {
  it('permits a tool that declares no scope', () => {
    expect(scopeAllows({ scopes: [] }, undefined)).toBe(true);
  });

  it('permits exactly the scopes the token holds', () => {
    const s = readOnlyScope();
    expect(scopeAllows(s, 'read')).toBe(true);
    expect(scopeAllows(s, 'validate')).toBe(true);
    expect(scopeAllows(s, 'export')).toBe(true);
    expect(scopeAllows(s, 'mutate')).toBe(false);
    expect(scopeAllows(s, 'admin')).toBe(false);
  });

  it('lets `admin` stand in for a scope the token does not list', () => {
    // The escalation arm, which no `fullScope()` fixture can reach: a token
    // holding *only* `admin` short-circuits on the first `includes` for every
    // one of the five scopes, so `|| includes('admin')` never runs. An operator
    // minting an admin-only token would find every read tool denied.
    const adminOnly: AuthScope = { scopes: ['admin'] };
    for (const required of ['read', 'validate', 'mutate', 'export'] as const) {
      expect(scopeAllows(adminOnly, required), required).toBe(true);
    }
  });

  it('does not let a non-admin scope stand in for another', () => {
    // Counter-example to the test above: escalation is `admin`-only, not
    // "holding any scope implies the rest".
    expect(scopeAllows({ scopes: ['export'] }, 'mutate')).toBe(false);
  });
});

describe('modelAllowed', () => {
  it('permits every model when no allowlist is configured', () => {
    expect(modelAllowed({ scopes: ['read'] }, 'anything')).toBe(true);
    expect(modelAllowed({ scopes: ['read'], modelIds: [] }, 'anything')).toBe(true);
  });

  it('permits only the listed models when an allowlist is configured', () => {
    const narrowed: AuthScope = { scopes: ['read'], modelIds: ['alpha', 'beta'] };
    expect(modelAllowed(narrowed, 'alpha')).toBe(true);
    expect(modelAllowed(narrowed, 'beta')).toBe(true);
    expect(modelAllowed(narrowed, 'gamma')).toBe(false);
  });

  it('is not defeated by `admin` — the allowlist is orthogonal to scopes', () => {
    expect(modelAllowed({ scopes: ['admin'], modelIds: ['alpha'] }, 'gamma')).toBe(false);
  });
});

describe('scope constructors', () => {
  it('hand back copies, so a caller mutating one does not widen the next', () => {
    const a = fullScope();
    a.scopes = ['read'];
    expect(fullScope().scopes).toEqual(FULL_ACCESS.scopes);

    const b = readOnlyScope();
    b.modelIds = ['only-this-one'];
    expect(readOnlyScope().modelIds).toBeUndefined();
    expect(READ_ONLY.scopes).not.toContain('mutate');
  });

  it('read-only really is read-only', () => {
    expect(scopeAllows(readOnlyScope(), 'mutate')).toBe(false);
    expect(scopeAllows(fullScope(), 'mutate')).toBe(true);
  });
});
