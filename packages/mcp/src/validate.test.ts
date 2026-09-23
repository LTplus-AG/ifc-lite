/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { advertisedInputSchema, validateInput } from './validate.js';

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

  // #5192: `anyOf` is documented and declared on `JsonSchema` but `walk()`
  // never read it, so a schema using it to express "one of these two
  // identity fields" silently validated everything.
  describe('anyOf', () => {
    const identitySchema = {
      type: 'object' as const,
      properties: {
        global_id: { type: 'string' as const },
        express_id: { type: 'integer' as const },
      },
      anyOf: [{ required: ['global_id'] }, { required: ['express_id'] }],
    };

    it('rejects input matching no anyOf branch', () => {
      const r = validateInput(identitySchema, {});
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('$');
      expect(r.errors[0].message).toBe(
        "Expected input at '$' to satisfy at least one anyOf branch: " +
          '$.global_id: Required property missing OR $.express_id: Required property missing',
      );
    });

    it('accepts input matching exactly one anyOf branch', () => {
      expect(validateInput(identitySchema, { global_id: 'g1' }).valid).toBe(true);
      expect(validateInput(identitySchema, { express_id: 42 }).valid).toBe(true);
    });

    // What distinguishes `anyOf` from `oneOf`: matching MULTIPLE branches is
    // still valid. `oneOf` is deliberately not implemented (see validate.ts
    // header), so this also pins that an over-eager "exactly one" check
    // never crept in.
    it('accepts input matching more than one anyOf branch', () => {
      const r = validateInput(identitySchema, { global_id: 'g1', express_id: 42 });
      expect(r.valid).toBe(true);
    });

    it('names the failing path in the error message so a caller can act on it', () => {
      const nested = {
        type: 'object' as const,
        properties: {
          target: {
            type: 'object' as const,
            properties: { global_id: { type: 'string' as const }, express_id: { type: 'integer' as const } },
            anyOf: [{ required: ['global_id'] }, { required: ['express_id'] }],
          },
        },
      };
      const r = validateInput(nested, { target: {} });
      expect(r.valid).toBe(false);
      expect(r.errors[0].path).toBe('$.target');
    });

    // A null id reads as absent in every handler, so it must not satisfy the
    // branch that requires it (review of #5192).
    it('does not let a null value satisfy a required branch', () => {
      expect(validateInput(identitySchema, { global_id: null }).valid).toBe(false);
      expect(validateInput(identitySchema, { global_id: null, express_id: 7 }).valid).toBe(true);
    });

    // A branch's result is discarded, so a default must not be what makes it
    // match (review of #5192).
    it('does not let a branch default satisfy anyOf', () => {
      const schema = {
        type: 'object' as const,
        properties: { a: { type: 'string' as const } },
        anyOf: [{ properties: { a: { type: 'string' as const, default: 'x' } }, required: ['a'] }],
      };
      expect(validateInput(schema, {}).valid).toBe(false);
      expect(validateInput(schema, { a: 'y' }).valid).toBe(true);
    });

    // The Anthropic Messages API 400s a tool whose input_schema has a root
    // anyOf/oneOf/allOf, so tools/list must not publish it (#5192).
    it('advertisedInputSchema drops only the root anyOf', () => {
      const advertised = advertisedInputSchema(identitySchema);
      expect(advertised).not.toHaveProperty('anyOf');
      expect(advertised.properties).toEqual(identitySchema.properties);
      expect(identitySchema.anyOf).toHaveLength(2); // the enforced schema is untouched
      const plain = { type: 'object' as const, properties: {} };
      expect(advertisedInputSchema(plain)).toBe(plain);
    });
  });
});
