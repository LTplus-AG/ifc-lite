/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON-Schema input validator (Draft 2020-12 subset).
 *
 * It implements every keyword in `ENFORCED_KEYWORDS` and nothing else; a test
 * walks every registered tool schema and fails on any other keyword, so a
 * schema can never carry a constraint that is silently not checked.
 *
 * Why not ajv: handlers rely on two behaviours ajv does not have. `default`
 * is filled into the returned value, and a `null` counts as a missing
 * `required` property (every handler reads an absent and a null field alike).
 * The browser bundle also cannot use ajv's code generation under a CSP
 * without `unsafe-eval`. The tests use ajv as an independent oracle instead.
 *
 * `anyOf` and `oneOf` are checked against the *original* input (not `walk`'s
 * default-filled/type-narrowed copy of it); a branch's defaults and error
 * paths are not merged into the result. `oneOf` also rejects an input that
 * matches more than one branch.
 *
 * `$ref` resolves local JSON pointers (`#/$defs/Name`) against the root schema
 * passed to `validateInput`. Keywords next to a `$ref` are applied too, on top
 * of the referenced schema's.
 *
 * A top-level `anyOf` is enforced here but NOT advertised: the Anthropic
 * Messages API rejects a tool `input_schema` carrying `oneOf`/`allOf`/`anyOf`
 * at the root with a 400 that fails the whole request, so every Claude-backed
 * MCP client would lose the entire tool list over one schema.
 * `advertisedInputSchema` strips it from what `tools/list` returns; tools state
 * the constraint in their property descriptions instead (#5192).
 */

import type { JsonSchema } from './protocol/index.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  /** Input with `default` values filled in. */
  value: unknown;
}

/**
 * Keywords `validateInput` enforces, plus the annotation-only ones it may
 * ignore by definition (`description`, `title`, `format`, `examples`, `$schema`,
 * `$id`, `$comment`, `$defs`).
 */
export const ENFORCED_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'enum', 'const', 'default',
  'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minimum', 'exclusiveMinimum', 'maximum',
  'minLength', 'maxLength', 'pattern',
  'anyOf', 'oneOf', '$ref', '$defs',
  'description', 'title', 'format', 'examples', '$schema', '$id', '$comment',
]);

export function validateInput(schema: JsonSchema, input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const value = walk(schema, input, '$', errors, { root: schema, fillDefaults: true });
  return { valid: errors.length === 0, errors, value };
}

/**
 * The schema `tools/list` publishes for a tool: its input schema without the
 * root-level `anyOf` (see the file header). Nested `anyOf` is left alone —
 * only the root is rejected by the Anthropic API.
 */
export function advertisedInputSchema(schema: JsonSchema): JsonSchema {
  if (schema.anyOf === undefined) return schema;
  const { anyOf: _enforcedServerSide, ...advertised } = schema;
  return advertised;
}

interface WalkOptions {
  root: JsonSchema;
  /**
   * Off while an `anyOf`/`oneOf` branch is only being tested: a branch's
   * result is discarded, so a default must not be what lets it pass.
   */
  fillDefaults: boolean;
}

/** `const` failures, so `checkOneOf` can tell a wrong discriminator from a real problem. */
const constMismatches = new WeakSet<ValidationIssue>();

function walk(schema: JsonSchema | boolean, input: unknown, path: string, errors: ValidationIssue[], opts: WalkOptions): unknown {
  // Boolean subschemas (2020-12): `true` accepts anything, `false` nothing.
  if (schema === true) return input;
  if (schema === false) {
    if (input !== undefined) errors.push({ path, message: 'No value is allowed here' });
    return input;
  }
  if (typeof schema.$ref === 'string') schema = resolveRef(schema, opts.root);
  if (opts.fillDefaults && input === undefined && schema.default !== undefined) {
    input = clone(schema.default);
  }
  if (input === undefined || input === null) return input;

  if (schema.enum && !schema.enum.some((v) => sameValue(v, input))) {
    errors.push({ path, message: `Expected one of ${JSON.stringify(schema.enum)}; got ${JSON.stringify(input)}` });
  }
  if (schema.const !== undefined && !sameValue(schema.const, input)) {
    const issue = { path, message: `Expected constant ${JSON.stringify(schema.const)}; got ${JSON.stringify(input)}` };
    constMismatches.add(issue);
    errors.push(issue);
  }

  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (types.length > 0 && !types.some((t) => matchesType(t, input))) {
    errors.push({ path, message: `Expected type ${types.join('|')}; got ${typeof input}` });
    return input;
  }

  // Checked against the ORIGINAL input, not the default-filled/narrowed copy
  // this function otherwise builds — a branch only has to describe a shape
  // that matches, e.g. `{ required: ['global_id'] }` with no `properties` of
  // its own. Any ONE matching branch is enough.
  if (schema.anyOf && schema.anyOf.length > 0) {
    const branchErrors = tryBranches(schema.anyOf, input, path, opts);
    if (!branchErrors.some((b) => b.length === 0)) {
      // Name what each branch wanted, so the caller can fix the call without
      // reading the schema: `$.global_id: Required property missing` or ...
      const wanted = branchErrors.map(describeIssues).join(' OR ');
      errors.push({ path, message: `Expected input at '${path}' to satisfy at least one anyOf branch: ${wanted}` });
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    checkOneOf(schema.oneOf as JsonSchema[], input, path, errors, opts);
  }

  if (matchesType('object', input)) {
    const obj = input as Record<string, unknown>;
    const result: Record<string, unknown> = { ...obj };
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        const childPath = `${path}.${key}`;
        // Own properties only: a schema property named `toString` or
        // `constructor` must not read the value inherited from Object.prototype.
        const value = walk(sub, own(obj, key), childPath, errors, opts);
        // defineProperty, not `result[key] =`: a `__proto__` key must stay data.
        if (value !== undefined) defineData(result, key, value);
      }
    }
    if (schema.required) {
      for (const key of schema.required) {
        // `null` counts as missing: every handler reads an absent and a null
        // field alike, so `{ global_id: null }` must not satisfy a required id.
        const present = own(result, key);
        if (present === undefined || present === null) {
          errors.push({ path: `${path}.${key}`, message: 'Required property missing' });
        }
      }
    }
    const extra = schema.additionalProperties;
    if (extra === false || (typeof extra === 'object' && extra !== null)) {
      for (const key of Object.keys(obj)) {
        if (own(schema.properties ?? {}, key) !== undefined) continue;
        if (extra === false) errors.push({ path: `${path}.${key}`, message: 'Unexpected property' });
        else defineData(result, key, walk(extra, obj[key], `${path}.${key}`, errors, opts));
      }
    }
    return result;
  }

  if (matchesType('array', input)) {
    const arr = input as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push({ path, message: `Array shorter than ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
      errors.push({ path, message: `Array longer than ${schema.maxItems} item(s)` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      arr.forEach((item, i) => {
        const key = stableKey(item);
        if (seen.has(key)) errors.push({ path: `${path}[${i}]`, message: 'Duplicate array item' });
        seen.add(key);
      });
    }
    if (schema.items) {
      return arr.map((item, i) => walk(schema.items as JsonSchema, item, `${path}[${i}]`, errors, opts));
    }
    return arr;
  }

  if (typeof input === 'number') {
    if (schema.minimum !== undefined && input < schema.minimum) {
      errors.push({ path, message: `Must be >= ${schema.minimum}` });
    }
    if (schema.exclusiveMinimum !== undefined && input <= schema.exclusiveMinimum) {
      errors.push({ path, message: `Must be > ${schema.exclusiveMinimum}` });
    }
    if (schema.maximum !== undefined && input > schema.maximum) {
      errors.push({ path, message: `Must be <= ${schema.maximum}` });
    }
  }
  if (typeof input === 'string') {
    if (schema.minLength !== undefined && input.length < schema.minLength) {
      errors.push({ path, message: `String shorter than ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && input.length > schema.maxLength) {
      errors.push({ path, message: `String longer than ${schema.maxLength}` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(input)) {
      errors.push({ path, message: `Does not match pattern ${schema.pattern}` });
    }
  }

  return input;
}

function tryBranches(branches: JsonSchema[], input: unknown, path: string, opts: WalkOptions): ValidationIssue[][] {
  return branches.map((sub) => {
    const subErrors: ValidationIssue[] = [];
    walk(sub, input, path, subErrors, { ...opts, fillDefaults: false });
    return subErrors;
  });
}

/**
 * Exactly one branch must match. When none does, report the closest branch:
 * for a discriminated union (`{ kind: { const: 'x' } }` per branch) that is the
 * one whose discriminator matched, so the caller sees the real problem rather
 * than thirty "wrong kind" messages.
 */
function checkOneOf(branches: JsonSchema[], input: unknown, path: string, errors: ValidationIssue[], opts: WalkOptions): void {
  const branchErrors = tryBranches(branches, input, path, opts);
  const matched = branchErrors.filter((b) => b.length === 0).length;
  if (matched === 1) return;
  if (matched > 1) {
    errors.push({ path, message: `Expected input at '${path}' to match exactly one oneOf branch; it matches ${matched}` });
    return;
  }
  // A wrong discriminator is a const failure on a direct child (`$.op.kind`), not one deep in a payload.
  const isChild = (p: string) => p.startsWith(`${path}.`) && !/[.[]/.test(p.slice(path.length + 1));
  const discriminated = branchErrors.filter((b) => !b.some((e) => constMismatches.has(e) && isChild(e.path)));
  const candidates = discriminated.length > 0 ? discriminated : branchErrors;
  const fewest = Math.min(...candidates.map((b) => b.length));
  const closest = candidates.filter((b) => b.length === fewest).slice(0, 3);
  const more = candidates.length > closest.length ? ` (closest ${closest.length} of ${branches.length} branches shown)` : '';
  errors.push({ path, message: `Expected input at '${path}' to match one oneOf branch: ${closest.map(describeIssues).join(' OR ')}${more}` });
}

function describeIssues(issues: ValidationIssue[]): string {
  return issues.map((e) => `${e.path}: ${e.message}`).join('; ');
}

/** Resolve a local `$ref` (`#/a/b`) against the root; sibling keywords override the target's. */
function resolveRef(schema: JsonSchema, root: JsonSchema, seen = new Set<string>()): JsonSchema {
  const ref = schema.$ref as string;
  if (!ref.startsWith('#')) throw new Error(`Unsupported non-local $ref '${ref}'`);
  if (seen.has(ref)) throw new Error(`Circular $ref '${ref}'`);
  seen.add(ref);
  let target: unknown = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    target = target !== null && typeof target === 'object' ? own(target as Record<string, unknown>, key) : undefined;
  }
  if (target === undefined || target === null || typeof target !== 'object') {
    throw new Error(`Unresolvable $ref '${ref}'`);
  }
  const { $ref: _resolved, ...siblings } = schema;
  const resolved = { ...(target as JsonSchema), ...siblings };
  return typeof resolved.$ref === 'string' ? resolveRef(resolved, root, seen) : resolved;
}

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function defineData(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return stableKey(a) === stableKey(b);
}

/** JSON text with object keys sorted, so `{a,b}` and `{b,a}` compare equal. */
function stableKey(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
    : x));
}

const TYPE_CHECKS: Readonly<Record<string, (v: unknown) => boolean>> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  null: (v) => v === null,
};

/**
 * The `type` names `matchesType` enforces, derived from the same table. Any
 * other name matches every value, so the bridge refuses a tab schema that uses
 * one (`checkSchemaShape`).
 */
export const SUPPORTED_SCHEMA_TYPES: ReadonlySet<string> = new Set(Object.keys(TYPE_CHECKS));

function matchesType(t: string, v: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(TYPE_CHECKS, t) ? TYPE_CHECKS[t](v) : true;
}

function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}
