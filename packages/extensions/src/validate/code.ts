/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Static-validation AST walker for AI-authored extension code.
 *
 * The repair loop produces code that runs in a sandbox, but we still
 * want to catch the obvious "this can't possibly be safe" patterns
 * before the sandbox ever evaluates it:
 *
 *   - References to `globalThis`, `window`, `process`, `document`
 *   - `eval(...)`, `Function(...)`
 *   - Dynamic `import()` calls with non-literal paths
 *   - Capability strings built from runtime values (string concat /
 *     template literal where any part isn't a literal)
 *
 * Catches roughly the cases listed in `04-ai-authoring.md §6`.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §6.
 */

import * as acorn from 'acorn';
import { MAX_AST_DEPTH, walkBounded } from '../ast/bounded-walk.js';
import type { ValidationError } from '../types.js';

const BANNED_GLOBALS = new Set(['globalThis', 'window', 'process', 'document', 'self']);
const BANNED_CALLS = new Set(['eval', 'Function']);

/** Names of bundle-internal modules dynamic `import()` may reference. */
const DEFAULT_ALLOWED_IMPORTS = new Set<string>();

export interface CodeValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export interface CodeValidationOptions {
  /** Path prefix to attach to error paths (for multi-file reports). */
  pathPrefix?: string;
  /**
   * Set of literal module specifiers that dynamic `import()` is
   * allowed to load. Anything else fails validation.
   */
  allowedDynamicImports?: ReadonlySet<string>;
}

/**
 * Walk a JavaScript source for forbidden patterns. Returns structured
 * errors with stable codes and line/column info for the repair loop.
 */
export function validateCode(source: string, opts: CodeValidationOptions = {}): CodeValidationResult {
  const prefix = opts.pathPrefix ?? '';
  const allowed = opts.allowedDynamicImports ?? DEFAULT_ALLOWED_IMPORTS;
  const errors: ValidationError[] = [];

  let ast: acorn.Node;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (err) {
    const e = err as Error & { loc?: { line: number; column: number } };
    errors.push({
      path: `${prefix}[${e.loc?.line ?? 0}:${e.loc?.column ?? 0}]`,
      code: 'invalid_format',
      message: `Source does not parse: ${e.message}`,
    });
    return { ok: false, errors };
  }

  const { depthExceeded, unwalkableTypes } = walkBounded(ast, (node, type) => {
    switch (type) {
      case 'Identifier': {
        const n = node as unknown as acorn.Identifier;
        if (BANNED_GLOBALS.has(n.name)) {
          // This catches identifier *references*. The walk visits identifiers
          // anywhere they appear, including binding positions — and assignment
          // to `window.foo` would also flag. That's intentionally conservative:
          // we don't want to allow `globalThis.foo = bar` either.
          errors.push({
            path: `${prefix}[${n.loc?.start.line ?? 0}:${n.loc?.start.column ?? 0}]`,
            code: 'invalid_value',
            message: `Banned global identifier: "${n.name}".`,
            hint: 'Use ctx fields instead. The sandbox does not expose host realm globals.',
          });
        }
        break;
      }
      case 'CallExpression': {
        const n = node as unknown as acorn.CallExpression;
        const callee = n.callee;
        if (callee.type === 'Identifier' && BANNED_CALLS.has(callee.name)) {
          errors.push({
            path: `${prefix}[${n.loc?.start.line ?? 0}:${n.loc?.start.column ?? 0}]`,
            code: 'invalid_value',
            message: `Banned call: "${callee.name}(...)" is not allowed in extension code.`,
            hint: 'Inline the logic. Dynamic evaluation is out of scope for v1.',
          });
        }
        break;
      }
      case 'NewExpression': {
        const n = node as unknown as acorn.NewExpression;
        if (n.callee.type === 'Identifier' && n.callee.name === 'Function') {
          errors.push({
            path: `${prefix}[${n.loc?.start.line ?? 0}:${n.loc?.start.column ?? 0}]`,
            code: 'invalid_value',
            message: 'Banned: `new Function(...)`.',
            hint: 'Dynamic function construction is forbidden in extension code.',
          });
        }
        break;
      }
      case 'ImportExpression': {
        const n = node as unknown as acorn.ImportExpression;
        if (n.source.type !== 'Literal' || typeof n.source.value !== 'string') {
          errors.push({
            path: `${prefix}[${n.loc?.start.line ?? 0}:${n.loc?.start.column ?? 0}]`,
            code: 'invalid_value',
            message: 'Dynamic import requires a string literal specifier.',
          });
          break;
        }
        if (!allowed.has(n.source.value)) {
          errors.push({
            path: `${prefix}[${n.loc?.start.line ?? 0}:${n.loc?.start.column ?? 0}]`,
            code: 'invalid_reference',
            message: `Dynamic import of "${n.source.value}" is not allowed.`,
            hint: 'Only specifiers internal to the bundle may be imported dynamically.',
          });
        }
        break;
      }
    }
  });

  // A truncated walk has not proven the source clean — anything below
  // the cut-off is unexamined. Report the depth as its own validation
  // failure rather than returning `ok` on a partial inspection.
  if (depthExceeded) {
    errors.push({
      path: prefix,
      code: 'invalid_value',
      message: `Source is nested more than ${MAX_AST_DEPTH} AST levels deep; it was not fully validated.`,
      hint: 'Flatten the source — extract deeply nested blocks into separate helper functions.',
    });
  }

  // Same rule, different cause: a subtree the walker could not descend
  // is unexamined source. A banned global or an `eval` under it would
  // have gone unseen, so this cannot come back `ok`.
  if (unwalkableTypes.length > 0) {
    errors.push({
      path: prefix,
      code: 'invalid_value',
      message: `Source contains AST node types this validator cannot traverse (${unwalkableTypes.join(', ')}); it was not fully validated.`,
      hint: 'This usually means the parser is newer than the walker it is paired with — report it rather than working around it.',
    });
  }

  return { ok: errors.length === 0, errors };
}
