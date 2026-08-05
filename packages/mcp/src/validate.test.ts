/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validateInput } from './validate.js';

describe('validateInput', () => {
  it('fills defaults', () => {
    const r = validateInput({
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 100 },
      },
    }, {});
    expect(r.valid).toBe(true);
    expect((r.value as { limit: number }).limit).toBe(100);
  });

  it('flags missing required fields', () => {
    const r = validateInput({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }, {});
    expect(r.valid).toBe(false);
    expect(r.errors[0].path).toBe('$.name');
  });

  it('rejects out-of-range numbers', () => {
    const r = validateInput({ type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 10 } } }, { n: 99 });
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/<= 10/);
  });

  it('honours enum values', () => {
    const r = validateInput({ type: 'object', properties: { s: { type: 'string', enum: ['a', 'b'] } } }, { s: 'c' });
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/Expected one of/);
  });

  it('walks nested objects', () => {
    const r = validateInput({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { v: { type: 'integer', default: 7 } } },
      },
    }, { nested: {} });
    expect((r.value as { nested: { v: number } }).nested.v).toBe(7);
  });

  it('walks array items', () => {
    const r = validateInput({
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer', minimum: 0 } } },
    }, { ids: [1, -2, 3] });
    expect(r.valid).toBe(false);
    expect(r.errors[0].path).toBe('$.ids[1]');
  });

  // Kills a mutation of `schema.additionalProperties === false` to `=== true`
  // (or a dropped check). Every hand-authored MCP tool schema sets
  // `additionalProperties: false` to reject unrecognised fields from the
  // LLM caller; without this test that guard had zero assertions and the
  // whole suite stayed green even with the check disabled.
  it('rejects unexpected properties when additionalProperties is false', () => {
    const r = validateInput({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    }, { name: 'a', extra: 'nope' });
    expect(r.valid).toBe(false);
    expect(r.errors[0].path).toBe('$.extra');
    expect(r.errors[0].message).toMatch(/Unexpected property/);
  });

  it('allows unexpected properties when additionalProperties is not false', () => {
    const r = validateInput({
      type: 'object',
      properties: { name: { type: 'string' } },
    }, { name: 'a', extra: 'ok' });
    expect(r.valid).toBe(true);
  });

  // Kills a mutation of `input.length < schema.minLength` to `<=` (previously
  // untested): a string exactly at the minimum length must still be valid.
  // No existing test exercised this boundary, so an off-by-one that rejects
  // the exact-minimum case stayed green.
  it('accepts a string exactly at minLength and rejects one below it', () => {
    const schema = { type: 'object' as const, properties: { s: { type: 'string' as const, minLength: 3 } } };
    expect(validateInput(schema, { s: 'abc' }).valid).toBe(true);
    const r = validateInput(schema, { s: 'ab' });
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/shorter than 3/);
  });

  // Kills a mutation of `input.length > schema.maxLength` to `>=` (previously
  // untested): a string exactly at the maximum length must still be valid.
  it('accepts a string exactly at maxLength and rejects one above it', () => {
    const schema = { type: 'object' as const, properties: { s: { type: 'string' as const, maxLength: 3 } } };
    expect(validateInput(schema, { s: 'abc' }).valid).toBe(true);
    const r = validateInput(schema, { s: 'abcd' });
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/longer than 3/);
  });
});
