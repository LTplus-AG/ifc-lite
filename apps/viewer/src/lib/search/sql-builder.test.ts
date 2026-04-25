/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the escape helpers exported from `sql-builder.ts`.
 *
 * The legacy `generateSqlFromBuilder` shape (with its un-escaped
 * quoted-identifier alias) has been removed; full emitter coverage
 * now lives in `sql-builder.filter-rules.test.ts`. These tests stay
 * because the escape helpers are still part of the module's public
 * surface and used by downstream callers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { escapeSqlString, escapeLikePattern } from './sql-builder.js';

describe('escapeSqlString', () => {
  it('doubles embedded single quotes', () => {
    assert.strictEqual(escapeSqlString("O'Brien"), "O''Brien");
  });
  it('leaves plain input untouched', () => {
    assert.strictEqual(escapeSqlString('wall'), 'wall');
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _, and \\ so values cannot smuggle wildcards in', () => {
    assert.strictEqual(escapeLikePattern('50%_x'), '50\\%\\_x');
    assert.strictEqual(escapeLikePattern('path\\to'), 'path\\\\to');
  });
});
