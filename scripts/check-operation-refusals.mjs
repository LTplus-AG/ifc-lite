#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer operations refuse through `operations/refusals.ts`, never a plain Error (#10871).
 *
 * The executor reports a plain thrown Error as INTERNAL_ERROR, so an operation that rejected the caller's input with
 * `throw new Error('Unknown zone.')` told the agent the viewer broke and gave it no reason to branch on. Every refusal
 * and failure there goes through invalidInput / stale / disabled / unavailable / internal, each with an existing
 * executor error code and a details.reason. This gate parses each production file under the operations directory with
 * the TypeScript compiler and fails on any built-in Error class called or constructed (`Error(`, `new TypeError(`, ...),
 * so comments, strings, regexes and templates need no lexer of their own. Tests and generated contracts are not scanned.
 * It matches the class by name: an alias (`const E = Error; new E()`) is not caught, and a rethrow is allowed.
 *
 * Run: `node scripts/check-operation-refusals.mjs`
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OPERATIONS_DIR = 'apps/viewer/src/lib/agent-tools/operations';
// A built-in Error class, called or constructed. A member call (`x.Error(`) or a longer name such as
// ToolExecutionError, which the refusal helpers build, is not one.
const BUILTIN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError']);

/** The 1-based line of every plain Error called or constructed in `text`, wherever it is thrown or rejected from. */
export function plainErrorLines(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext);
  const lines = [];
  const visit = (node) => {
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && BUILTIN_ERRORS.has(node.expression.text))
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function productionFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'generated') files.push(...productionFiles(path)); continue; }
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

/** Every plain throw under `<base>/<OPERATIONS_DIR>`, and how many files were scanned. */
export function runCheck(base) {
  const dir = join(base, OPERATIONS_DIR);
  if (!existsSync(dir)) throw new Error(`check-operation-refusals: ${OPERATIONS_DIR} does not exist under ${base}`);
  const files = productionFiles(dir), violations = [];
  // A gate that examined nothing must not pass: the directory moving would silently disable it.
  if (files.length === 0) throw new Error(`check-operation-refusals: no operation files found under ${OPERATIONS_DIR}`);
  for (const file of files) {
    for (const line of plainErrorLines(file, readFileSync(file, 'utf8'))) violations.push(`${relative(base, file)}:${line}`);
  }
  return { files: files.length, violations };
}

if (isMainEntry(import.meta.url)) {
  const { files, violations } = runCheck(ROOT);
  if (violations.length > 0) {
    console.error(`\nPlain Error thrown by a viewer operation (#10871):\n\n  ${violations.join('\n  ')}\n
Throw a helper from ${OPERATIONS_DIR}/refusals.ts instead, so the agent gets an executor code and a details.reason:
  invalidInput(reason, message)  the caller's input is wrong (INVALID_INPUT)
  stale(message)                 the inspected state changed (STATE_CHANGED)
  disabled(message)              the host or a grant forbids it (PERMISSION_DENIED)
  unavailable(message)           the viewer is not in a state to run it (UNSUPPORTED_OPERATION)
  internal(message)              the viewer itself failed (INTERNAL_ERROR)\n`);
    process.exit(1);
  }
  console.log(`check-operation-refusals: ${files} operation files, no plain Error throws.`);
}
