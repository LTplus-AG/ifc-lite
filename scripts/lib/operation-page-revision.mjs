/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** A literal cursor must carry its revision alongside it (#10877). Shared pager spreads carry both together. */
export function missingPageRevisions(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const lines = [];
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map(property => property.name)
        .filter(name => name && (ts.isIdentifier(name) || ts.isStringLiteral(name)))
        .map(name => name.text);
      if (names.includes('next_offset') && !names.includes('page_revision')) {
        lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return lines;
}

export function operationPageViolations(root) {
  const dir = join(root, 'apps/viewer/src/lib/agent-tools/operations');
  const violations = [];
  for (const file of readdirSync(dir, { recursive: true })) {
    // Artifact chunks page immutable bytes by a host-owned artifact id. They are a separate MCP transport tool.
    if (/^generated[\/\\]/.test(file) || !/\.tsx?$/.test(file) || /(?:\.test|\.d)\.tsx?$/.test(file) || file === 'artifacts.ts') continue;
    const path = join(dir, file);
    for (const line of missingPageRevisions(file, readFileSync(path, 'utf8'))) violations.push(`${file}:${line}`);
  }
  return violations;
}
