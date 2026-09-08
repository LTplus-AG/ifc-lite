/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite eval <file.ifc> "<expression>"
 *
 * Evaluate a JavaScript expression against the BIM SDK.
 * The `bim` object is available with the full SDK API.
 *
 * When --type is specified, the expression is evaluated per-entity with
 * `ref` bound to each entity reference, enabling patterns like:
 *   ifc-lite eval model.ifc "bim.quantity(ref, 'GrossSideArea')" --type IfcWall --limit 3
 *
 * Examples:
 *   ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"
 *   ifc-lite eval model.ifc "bim.query().byType('IfcDoor').toArray().map(d => d.name)"
 */

import { createHeadlessContext, createStreamingContext } from '../loader.js';
import { printJson, fatal, hasFlag, getFlag, validateViewerPort, validateLimit } from '../output.js';

/** Known flags that take a value argument */
const EVAL_VALUE_FLAGS = new Set(['--type', '--limit', '--viewer']);
/** Known boolean flags (no value) */
const EVAL_BOOLEAN_FLAGS = new Set(['--json']);

export async function evalCommand(args: string[]): Promise<void> {
  const jsonOutput = hasFlag(args, '--json');
  const typeFilter = getFlag(args, '--type');
  const limitStr = getFlag(args, '--limit');
  const viewerPortRaw = getFlag(args, '--viewer');
  const viewerPort = validateViewerPort(viewerPortRaw);

  // Parse positional args, skipping known flags and their values.
  // Known value flags (--type, --limit) and boolean flags (--json) are always
  // skipped regardless of position. After the file path is collected, other
  // dash-prefixed tokens (e.g. "-1") are treated as expression parts.
  const positional: string[] = [];
  let afterFilePath = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      afterFilePath = true;
      continue;
    }
    // Always skip known flags, even after the file path
    if (EVAL_VALUE_FLAGS.has(arg)) {
      i++; // skip flag value
      continue;
    }
    if (EVAL_BOOLEAN_FLAGS.has(arg)) continue;
    // Before the file path, skip any unrecognised flags too
    if (!afterFilePath && arg.startsWith('-')) continue;
    positional.push(arg);
    // After collecting the file path, allow dash-prefixed expression tokens
    if (positional.length === 1) afterFilePath = true;
  }

  if (positional.length < 2) fatal('Usage: ifc-lite eval <file.ifc> "<expression>"');

  const [filePath, ...exprParts] = positional;
  const expression = exprParts.join(' ');

  // Use streaming context if --viewer is specified, so bim.viewer.* calls
  // are forwarded to the running 3D viewer in real time.
  const { bim } = viewerPort
    ? await createStreamingContext(filePath, viewerPort)
    : await createHeadlessContext(filePath);

  // When --type is specified, iterate entities and evaluate per-entity with `ref` in scope
  if (typeFilter) {
    const types = typeFilter.split(',').map(t => {
      const trimmed = t.trim();
      if (trimmed.startsWith('Ifc') || trimmed.startsWith('IFC') || trimmed.startsWith('ifc')) return trimmed;
      return 'Ifc' + trimmed;
    });
    let entities = bim.query().byType(...types).toArray();
    // Validated, not parseInt'd: a non-numeric --limit yields NaN and
    // slice(0, NaN) returns [], so a typo silently evaluated nothing and
    // reported success. Same guard as export --limit.
    const evalLimit = validateLimit(limitStr);
    if (evalLimit !== undefined) entities = entities.slice(0, evalLimit);

    const results: any[] = [];
    const evalFn = buildEvalFunction(expression, ['bim', 'ref', 'entity']);

    for (const entity of entities) {
      try {
        const result = evalFn(bim, entity.ref, entity);
        const resolved = result instanceof Promise ? await result : result;
        results.push({
          Name: entity.name,
          Type: entity.type,
          GlobalId: entity.globalId,
          result: resolved ?? null,
        });
      } catch (err: any) {
        results.push({
          Name: entity.name,
          Type: entity.type,
          GlobalId: entity.globalId,
          error: err.message,
        });
      }
    }

    if (jsonOutput) {
      printJson({ results });
    } else {
      for (const r of results) {
        const val = r.error ? `ERROR: ${r.error}` : formatValue(r.result);
        process.stdout.write(`${r.Name ?? r.GlobalId}: ${val}\n`);
      }
      process.stderr.write(`\n${results.length} entities evaluated\n`);
    }
    return;
  }

  // Standard eval (no --type): evaluate expression once with bim in scope
  const evalFn = buildEvalFunction(expression, ['bim']);

  try {
    const result = evalFn(bim);

    // Handle async results
    const resolved = result instanceof Promise ? await result : result;

    if (jsonOutput) {
      printJson({ result: resolved ?? null });
    } else if (resolved === undefined || resolved === null) {
      process.stdout.write('null\n');
    } else if (typeof resolved === 'object') {
      printJson(resolved);
    } else {
      process.stdout.write(String(resolved) + '\n');
    }
  } catch (err: any) {
    fatal(`Evaluation error: ${err.message}`);
  }
}

/**
 * Build an eval function from an expression string.
 * Handles both single expressions and multi-statement code.
 */
function buildEvalFunction(expression: string, paramNames: string[]): Function {
  const isStatement = /^\s*(const |let |var |for |if |while |return |class |function |try |switch |{)/.test(expression)
    || expression.includes(';');

  let body: string;
  if (isStatement) {
    const statements = expression.split(';').map(s => s.trim()).filter(Boolean);
    const last = statements[statements.length - 1];
    const isLastDeclaration = /^(const |let |var |for |if |while |return |class |function |try |switch |{)/.test(last);
    if (!isLastDeclaration && statements.length > 1) {
      statements[statements.length - 1] = `return (${last})`;
    } else if (isLastDeclaration && /^(const |let |var )\s*(\w+)/.test(last)) {
      const varMatch = last.match(/^(?:const |let |var )\s*(\w+)/);
      if (varMatch) {
        statements.push(`return ${varMatch[1]}`);
      }
    }
    body = `return (async () => { ${statements.join('; ')} })()`;
  } else {
    body = `return (${expression})`;
  }

  return new Function(...paramNames, `
    "use strict";
    ${body};
  `);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
