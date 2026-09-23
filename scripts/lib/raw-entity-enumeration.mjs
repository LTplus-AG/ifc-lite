/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import ts from 'typescript';

function ownerOf(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
      return parent.name?.getText() ?? '<anonymous>';
    }
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      const holder = parent.parent;
      if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) {
        return holder.name.getText();
      }
      return '<anonymous>';
    }
  }
  return '<module>';
}

function enclosingStatement(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isStatement(parent) && !ts.isBlock(parent)) return parent;
  }
  return node;
}

/** A deliberate raw read must say why immediately above its statement. */
function rawReason(source, node) {
  const statement = enclosingStatement(node);
  const ranges = ts.getLeadingCommentRanges(source.text, statement.getFullStart()) ?? [];
  const startLine = source.getLineAndCharacterOfPosition(statement.getStart(source)).line;
  for (const range of ranges) {
    const endLine = source.getLineAndCharacterOfPosition(range.end).line;
    if (endLine !== startLine - 1) continue;
    const comment = source.text.slice(range.pos, range.end);
    const match = comment.match(/@raw-entity-enumeration-ok\s+([^\r\n*]{15,})/);
    if (match) return match[1].trim();
  }
  return null;
}

function kindOf(node) {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const name = node.name.text;
  if ((name === 'byType' || name === 'byId')
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'entityIndex') return `entityIndex.${name}`;
  if (name === 'count'
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'entities') return 'entities.count';
  // `entities.count` without a receiver is also the EntityTable pattern in
  // BulkQueryEngine and csv-match. A non-EntityTable false positive is reviewable.
  if (name === 'count' && ts.isIdentifier(node.expression)
      && node.expression.text === 'entities') return 'entities.count';
  return null;
}

/** Conservative AST census of raw entity-table access in a source file. */
export function scanRawEntityAccess(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`${path}: TypeScript parse failed; raw-access gate cannot inspect it`);
  }
  const hits = [];
  const visit = (node) => {
    const kind = kindOf(node);
    if (kind) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      hits.push({
        key: `${path}|${ownerOf(node)}|${kind}|${node.getText(source).replace(/\s+/g, '')}`,
        line,
        reason: rawReason(source, node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** Each existing site has one slot. A second copy in the same function fails. */
export function excessRawAccess(before, after) {
  const budget = new Map();
  for (const hit of before) {
    if (!hit.reason) budget.set(hit.key, (budget.get(hit.key) ?? 0) + 1);
  }
  const excess = [];
  for (const hit of after) {
    if (hit.reason) continue;
    const left = budget.get(hit.key) ?? 0;
    if (left > 0) budget.set(hit.key, left - 1);
    else excess.push(hit);
  }
  return excess;
}
