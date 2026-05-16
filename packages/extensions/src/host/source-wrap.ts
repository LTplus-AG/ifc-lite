/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source wrapping for extension entry scripts.
 *
 * Convention for v1:
 *
 *   - An entry file is a plain JS source that defines a top-level
 *     function (e.g. `activate`, `deactivate`, or a command handler).
 *   - The function takes a `ctx` parameter.
 *   - The function may be `async`; if it returns a Promise we do not
 *     await it (fire-and-forget). Long-running work happens on command
 *     / trigger fires, not at activation time.
 *
 * We do NOT support `export` statements at module level (QuickJS
 * evalCode is non-module). The CLI scaffold writes plain function
 * declarations; AI-authored extensions follow the same shape. Sources
 * containing `export` are flagged at wrap time so the failure is
 * visible.
 *
 * Wrap shape (output):
 *
 *   ;(() => {
 *     const __ifclite_ctx__ = globalThis.__ifclite_ctx__;
 *     const bim = __ifclite_ctx__.bim;
 *     // <user source verbatim>
 *     if (typeof <entryFnName> === 'function') {
 *       return <entryFnName>(__ifclite_ctx__);
 *     }
 *   })()
 *
 * The `__ifclite_ctx__` global is installed by the runtime before
 * eval. `bim` is also aliased as a local for ergonomic user code that
 * already references it as a global (matching the existing sandbox
 * convention).
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §9.
 */

import * as acorn from 'acorn';
import type { ValidationError, ValidationResult } from '../types.js';

export interface SourceWrapOptions {
  /** Name of the entry function to invoke (e.g. "activate"). */
  entryFnName: string;
  /** Optional source identifier for error reporting. */
  filename?: string;
}

/**
 * Wrap an entry script for sandbox execution. Returns the wrapped JS
 * string or structured errors if the source contains unsupported
 * constructs.
 */
export function wrapEntrySource(
  source: string,
  opts: SourceWrapOptions,
): ValidationResult<string> {
  if (typeof source !== 'string') {
    return fail('', 'type_mismatch', 'Entry source must be a string.');
  }
  if (source.trim().length === 0) {
    return fail('', 'invalid_value', 'Entry source is empty.');
  }

  // Validate identifier so we never interpolate user-supplied unsafe values.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(opts.entryFnName)) {
    return fail(
      '',
      'invalid_value',
      `entryFnName "${opts.entryFnName}" is not a valid identifier.`,
    );
  }

  // Parse to detect unsupported constructs.
  let ast: acorn.Node;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      // We parse as a module so we can DETECT `export` and report it
      // clearly, even though the runtime evaluates as a non-module.
      sourceType: 'module',
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
    });
  } catch (err) {
    const e = err as Error & { loc?: { line: number; column: number } };
    return fail(
      `[${e.loc?.line ?? 0}:${e.loc?.column ?? 0}]`,
      'invalid_format',
      `Entry script does not parse: ${e.message}`,
    );
  }

  const errors = checkBannedConstructs(ast);
  if (errors.length > 0) return { ok: false, errors };

  const wrapped = buildWrap(source, opts.entryFnName);
  return { ok: true, value: wrapped };
}

function buildWrap(userSource: string, entryFn: string): string {
  // Newlines between sections keep source-mapped line numbers usable
  // when looking at error stacks — user source begins at a predictable
  // offset.
  return `;(() => {
const __ifclite_ctx__ = globalThis.__ifclite_ctx__;
const bim = __ifclite_ctx__.bim;
${userSource}
if (typeof ${entryFn} === 'function') {
  return ${entryFn}(__ifclite_ctx__);
}
})()`;
}

interface MaybeNode {
  type: string;
  body?: MaybeNode[];
  source?: { value: unknown };
}

/**
 * Walk the top-level program body looking for constructs we do not
 * support in v1. Returns one ValidationError per offending node.
 */
function checkBannedConstructs(ast: acorn.Node): ValidationError[] {
  const errors: ValidationError[] = [];
  const body = (ast as MaybeNode).body ?? [];
  for (const node of body) {
    if (!node || typeof node !== 'object') continue;
    switch (node.type) {
      case 'ImportDeclaration':
        errors.push({
          path: '',
          code: 'invalid_value',
          message: 'Top-level `import` statements are not supported in extension entry scripts.',
          hint: 'Inline any helpers, or move them into a separate file referenced via entry.commands / entry.triggers.',
        });
        break;
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
        errors.push({
          path: '',
          code: 'invalid_value',
          message: 'Top-level `export` statements are not supported in extension entry scripts.',
          hint: 'Define the entry function as a top-level declaration (e.g. `async function activate(ctx) {…}`) without `export`.',
        });
        break;
    }
  }
  return errors;
}

function fail(
  path: string,
  code: import('../types.js').ValidationErrorCode,
  message: string,
  hint?: string,
): ValidationResult<never> {
  return { ok: false, errors: [{ path, code, message, hint }] };
}
