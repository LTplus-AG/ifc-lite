/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { rewriteSqlError, __internal } from './sql-error-rewriter.js';

describe('rewriteSqlError', () => {
  it('rewrites "Referenced column X not found" with a hint', () => {
    const r = rewriteSqlError(
      'Binder Error: Referenced column "ifctype" not found in FROM clause!',
    );
    assert.ok(r.title.includes('ifctype'));
    assert.ok(r.hint);
    // Normaliser maps "ifctype" → "type"
    assert.strictEqual(r.suggestion, 'type');
  });

  it('rewrites "Referenced column GlobalId not found" with a snake_case hint', () => {
    const r = rewriteSqlError(
      'Binder Error: Referenced column "GlobalId" not found in FROM clause!',
    );
    assert.strictEqual(r.suggestion, 'global_id');
    assert.ok(r.hint);
  });

  it('rewrites unknown-column when the name does not match a known alias', () => {
    const r = rewriteSqlError(
      'Binder Error: Referenced column "widgets" not found in FROM clause!',
    );
    assert.ok(r.title.includes('widgets'));
    // No suggestion when the name doesn't normalise to anything known.
    assert.strictEqual(r.suggestion, undefined);
    assert.ok(r.hint); // still surfaces a generic "check the schema browser" hint
  });

  it('rewrites "Table with name X does not exist" and proposes a plural match', () => {
    const r = rewriteSqlError(
      'Catalog Error: Table with name "entitie" does not exist!',
    );
    assert.ok(r.title.includes('entitie'));
    assert.strictEqual(r.suggestion, 'entities');
  });

  it('rewrites Parser / Syntax errors to a single readable title', () => {
    const r = rewriteSqlError(
      'Parser Error: syntax error at or near "FROMM"',
    );
    assert.ok(r.title.toLowerCase().includes('syntax'));
    assert.ok(r.hint);
  });

  it('rewrites Conversion Error with a typing hint', () => {
    const r = rewriteSqlError(
      'Conversion Error: Could not convert string \'1\' to BOOLEAN',
    );
    assert.ok(r.title.toLowerCase().includes('conversion'));
    assert.ok(r.hint);
  });

  it('rewrites "not initialized" as a warming-up message', () => {
    const r = rewriteSqlError('DuckDB not initialized. Call init() first.');
    assert.ok(r.title.toLowerCase().includes('warming'));
  });

  it('rewrites "Failed to initialize DuckDB" with install instructions', () => {
    const r = rewriteSqlError('Failed to initialize DuckDB: Cannot find module');
    assert.ok(r.title.toLowerCase().includes('not available'));
    assert.ok(r.hint && r.hint.includes('pnpm add'));
  });

  it('falls back to trimmed raw message for unknown errors', () => {
    const raw = 'Some totally unrelated DuckDB error';
    const r = rewriteSqlError(raw);
    assert.strictEqual(r.title, raw);
    assert.strictEqual(r.hint, undefined);
    assert.strictEqual(r.raw, raw);
  });

  it('truncates very long fallback titles to ~140 chars', () => {
    const raw = 'x'.repeat(300);
    const r = rewriteSqlError(raw);
    assert.ok(r.title.length <= 140);
    assert.strictEqual(r.raw, raw); // full text preserved for copy
  });

  it('accepts Error instances and non-string inputs', () => {
    const e = rewriteSqlError(new Error('Parser Error: whatever'));
    assert.ok(e.title.toLowerCase().includes('syntax'));

    const n = rewriteSqlError(42);
    assert.ok(n.raw.includes('42'));
  });

  describe('__internal', () => {
    it('normaliseColumnHint covers ifctype, globalid, expressid, pset', () => {
      assert.strictEqual(__internal.normaliseColumnHint('IfcType'), 'type');
      assert.strictEqual(__internal.normaliseColumnHint('globalId'), 'global_id');
      assert.strictEqual(__internal.normaliseColumnHint('expressid'), 'express_id');
      assert.strictEqual(__internal.normaliseColumnHint('Pset'), 'pset_name');
      assert.strictEqual(__internal.normaliseColumnHint('nonsense'), null);
    });

    it('suggestTable matches plural / substring variants', () => {
      assert.strictEqual(__internal.suggestTable('entitie'), 'entities');
      assert.strictEqual(__internal.suggestTable('wall'), 'walls');
      assert.strictEqual(__internal.suggestTable('nope'), null);
    });
  });
});
