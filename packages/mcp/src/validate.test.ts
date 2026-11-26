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

describe('validateInput reads own properties only (#9523 review of PR #9905)', () => {
  const schema = {
    type: 'object',
    properties: { toString: { type: 'string' }, constructor: { type: 'string' }, valueOf: { type: 'number' } },
    required: ['constructor'],
  };

  it('does not mistake Object.prototype members for supplied values', () => {
    // `constructor` is inherited by every object, but it was not supplied.
    const missing = validateInput(schema, {});
    expect(missing.valid).toBe(false);
    expect(missing.errors).toEqual([{ path: '$.constructor', message: 'Required property missing' }]);
    // An omitted optional `toString`/`valueOf` is simply absent, not a function of the wrong type.
    expect(validateInput(schema, { constructor: 'x' })).toEqual({ valid: true, errors: [], value: { constructor: 'x' } });
  });

  it('keeps a __proto__ key as data instead of setting the prototype', () => {
    // Built with JSON.parse: in an object literal `__proto__: …` would SET the
    // prototype instead of declaring a key, and the test would prove nothing.
    const schema = JSON.parse(
      '{"type": "object", "properties": {"__proto__": {"type": "object", "default": {"polluted": true}}}}',
    ) as Parameters<typeof validateInput>[0];
    expect(Object.keys(schema.properties ?? {})).toEqual(['__proto__']);
    // The input has no `__proto__` key, so the default is what gets written:
    // a plain `result[key] = value` would hit Object.prototype's setter here.
    const result = validateInput(schema, {});
    const value = result.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

// oneOf / $ref / const / pattern / uniqueItems / additionalProperties schemas
// were silently unchecked before (ids_apply_ops carried 41 KB of them).
describe('validateInput: 2020-12 keywords beyond the original subset', () => {
  const union = {
    type: 'object',
    properties: { op: { $ref: '#/$defs/Op' } },
    $defs: {
      Op: { oneOf: [{ $ref: '#/$defs/Add' }, { $ref: '#/$defs/Remove' }] },
      Add: { type: 'object', properties: { kind: { const: 'add' }, name: { type: 'string', minLength: 1 } }, required: ['kind', 'name'], additionalProperties: false },
      Remove: { type: 'object', properties: { kind: { const: 'remove' }, id: { $ref: '#/$defs/Id' } }, required: ['kind', 'id'], additionalProperties: false },
      Id: { type: 'string', pattern: '^[0-9a-f]{4}$' },
    },
  };

  it('resolves $ref into $defs and accepts the one matching oneOf branch', () => {
    expect(validateInput(union, { op: { kind: 'add', name: 'x' } }).valid).toBe(true);
    expect(validateInput(union, { op: { kind: 'remove', id: 'ab12' } }).valid).toBe(true);
  });

  it('reports only the branch whose discriminator matched', () => {
    const r = validateInput(union, { op: { kind: 'remove', id: 'nope' } });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('$.op.id: Does not match pattern');
    expect(r.errors[0].message).not.toContain('Expected constant');
  });

  it('rejects an input that matches no branch, and one that matches two', () => {
    expect(validateInput(union, { op: { kind: 'explode' } }).valid).toBe(false);
    const both = { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] };
    const r = validateInput({ type: 'object', properties: { v: both } }, { v: 'x' });
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toContain('it matches 2');
  });

  it('compares const and enum structurally', () => {
    const schema = { type: 'object', properties: { v: { const: { a: 1, b: [2] } } } };
    expect(validateInput(schema, { v: { b: [2], a: 1 } }).valid).toBe(true);
    expect(validateInput(schema, { v: { a: 1, b: [3] } }).valid).toBe(false);
  });

  it('rejects duplicate items under uniqueItems', () => {
    const schema = { type: 'object', properties: { ids: { type: 'array', uniqueItems: true } } };
    const r = validateInput(schema, { ids: [1, 2, 1] });
    expect(r.errors).toEqual([{ path: '$.ids[2]', message: 'Duplicate array item' }]);
  });

  it('checks extra keys against an additionalProperties schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } };
    expect(validateInput(schema, { a: 'x', b: 1 }).valid).toBe(true);
    expect(validateInput(schema, { a: 'x', b: 'y' }).errors[0].path).toBe('$.b');
  });

  it('reports a $ref that points nowhere as a schema error instead of skipping the check', () => {
    expect(validateInput({ $ref: '#/$defs/Missing' }, {}).errors[0].message).toMatch(/Unresolvable \$ref/);
  });

  it('reports a $ref cycle as a schema error instead of overflowing the stack', () => {
    const schema = { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } } };
    expect(validateInput(schema, { a: 1 }).errors[0].message).toMatch(/Circular \$ref/);
  });

  it('treats boolean subschemas as accept-all and reject-all', () => {
    const schema = { type: 'object', properties: { yes: true, no: false } } as unknown as Parameters<typeof validateInput>[0];
    expect(validateInput(schema, { yes: 5 }).valid).toBe(true);
    expect(validateInput(schema, { no: 5 }).errors).toEqual([{ path: '$.no', message: 'No value is allowed here' }]);
  });

  it('a const failure deep in a payload does not hide the branch whose discriminator matched', () => {
    const schema = { type: 'object', properties: { op: { oneOf: [
      { type: 'object', properties: { kind: { const: 'a' }, body: { type: 'object', properties: { v: { const: 1 } } } } },
      { type: 'object', properties: { kind: { const: 'b' } } },
    ] } } };
    const r = validateInput(schema, { op: { kind: 'a', body: { v: 2 } } });
    expect(r.errors[0].message).toContain('$.op.body.v');
    expect(r.errors[0].message).not.toContain('$.op.kind');
  });

  it('refuses a constraint next to a $ref instead of half-applying it', () => {
    const schema = { type: 'object', properties: { op: { $ref: '#/$defs/Op', required: ['kind'] } },
      $defs: { Op: { type: 'object', properties: { kind: { const: 'add' } } } } };
    expect(validateInput(schema, { op: {} }).errors[0].message).toMatch(/Keyword 'required' next to \$ref/);
  });

  it('resolves an empty JSON Pointer segment as a key, not as the parent', () => {
    const schema = { type: 'object', properties: { o: { $ref: '#/$defs/' } }, $defs: { '': { type: 'string' } } };
    expect(validateInput(schema, { o: 3 }).valid).toBe(false);
  });

  it('resolves a $ref to a boolean schema, and allows a recursive schema that descends into the input', () => {
    const any = { type: 'object', properties: { x: { $ref: '#/$defs/Any' } }, $defs: { Any: true } };
    expect(validateInput(any as unknown as Parameters<typeof validateInput>[0], { x: 1 }).valid).toBe(true);
    const tree = { $ref: '#/$defs/Node', $defs: { Node: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/Node' } }, n: { type: 'integer' } } } } };
    expect(validateInput(tree, { kids: [{ kids: [{ n: 1 }] }] }).valid).toBe(true);
    expect(validateInput(tree, { kids: [{ kids: [{ n: 'x' }] }] }).errors[0].path).toBe('$.kids[0].kids[0].n');
  });
});

describe('advertisedInputSchema', () => {
  // A bridge tab may now send a root oneOf; the Anthropic API rejects it like a root anyOf (#5192).
  it('strips a root oneOf as well as a root anyOf', () => {
    const advertised = advertisedInputSchema({ type: 'object', oneOf: [{ required: ['a'] }, { required: ['b'] }] });
    expect(advertised).toEqual({ type: 'object' });
  });
});

describe('validateInput: code-review cases for items:false, enum discriminators, $ref defaults', () => {
  it('items: false rejects any item', () => {
    expect(validateInput({ type: 'array', items: false } as unknown as Parameters<typeof validateInput>[0], [1]).valid).toBe(false);
  });

  it('a one-value enum works as a oneOf discriminator', () => {
    const schema = { type: 'object', properties: { c: { oneOf: [
      { type: 'object', properties: { k: { enum: ['a'] }, x: { type: 'string' } }, required: ['k', 'x'] },
      { type: 'object', properties: { k: { enum: ['b'] }, y: { type: 'string' } }, required: ['k', 'y'] },
    ] } } };
    const message = validateInput(schema, { c: { k: 'b', x: 'v' } }).errors[0].message;
    expect(message).toContain('$.c.y: Required property missing');
    expect(message).not.toContain('$.c.k');
  });

  it('decodes percent-escapes in a $ref pointer', () => {
    const schema = { type: 'object', properties: { v: { $ref: '#/$defs/a%20b' } }, $defs: { 'a b': { type: 'string' } } };
    expect(validateInput(schema, { v: 1 }).valid).toBe(false);
    expect(validateInput({ $ref: '#/$defs/%E0' }, {}).errors[0].message).toMatch(/bad percent-escape/);
  });

  it('keeps a default written next to a $ref', () => {
    const schema = { type: 'object', properties: { x: { $ref: '#/$defs/A', default: 5 } }, $defs: { A: { type: 'integer' } } };
    expect(validateInput(schema, {}).value).toEqual({ x: 5 });
  });

  it('walks a default next to a $ref through the target', () => {
    const schema = { type: 'object', properties: { a: { $ref: '#/$defs/A', default: {} } },
      $defs: { A: { type: 'object', properties: { n: { type: 'integer', default: 3 } } } } };
    expect(validateInput(schema, {}).value).toEqual({ a: { n: 3 } });
  });

  it('runs a pattern that only compiles without the u flag (hand-written escapes like \\-)', () => {
    const schema = { type: 'object', properties: { d: { type: 'string', pattern: '^\\d{4}\\-\\d{2}$' } } };
    expect(validateInput(schema, { d: '2026-11' }).valid).toBe(true);
    expect(validateInput(schema, { d: '2026/11' }).valid).toBe(false);
  });

  it('null fails a non-null branch type, so a nullable oneOf picks exactly one branch', () => {
    const schema = { type: 'object', properties: { v: { type: 'object', oneOf: [
      { properties: { x: { type: 'string' } }, required: ['k'] },
      { properties: { x: { type: 'null' } }, required: ['k'] },
    ] } } };
    expect(validateInput(schema, { v: { k: 1, x: null } }).valid).toBe(true);
    // A top-level null still reads as absent.
    expect(validateInput({ type: 'object', properties: { x: { type: 'string' } } }, { x: null }).valid).toBe(true);
  });

  it('refuses an anchor $ref instead of resolving it to the root', () => {
    const r = validateInput({ type: 'object', properties: { a: { $ref: '#A' } } }, { a: 5 });
    expect(r.errors[0].message).toMatch(/Tool schema error: Unsupported \$ref '#A'/);
  });

  it('reports a pattern that compiles in neither mode as a schema error', () => {
    const r = validateInput({ type: 'object', properties: { a: { type: 'string', pattern: '(' } } }, { a: 'x' });
    expect(r.errors[0].message).toMatch(/Tool schema error: pattern "\(" does not compile/);
  });
});

