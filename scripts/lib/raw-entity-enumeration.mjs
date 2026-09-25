/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import ts from 'typescript';

/** Map a changed destination to its merge-base source path (or null if new). */
export function changedPathBaselines(nameStatus) {
  const paths = new Map();
  for (const line of nameStatus.split('\n')) {
    if (!line) continue;
    const [status, source, destination] = line.split('\t');
    if (status.startsWith('R')) paths.set(destination, source);
    else if (status === 'A') paths.set(source, null);
    else paths.set(source, source);
  }
  return paths;
}

function siblingOrdinal(node) {
  const name = node.name?.getText() ?? '';
  let ordinal = 0;
  ts.forEachChild(node.parent, (sibling) => {
    if (sibling === node) return true;
    if (sibling.kind === node.kind && (sibling.name?.getText() ?? '') === name) ordinal++;
    return undefined;
  });
  return ordinal;
}

function callbackSite(call) {
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
      return `${call.expression.getText()}@${parent.name.getText()}`;
    }
    if (ts.isExpressionStatement(parent) || ts.isReturnStatement(parent)) {
      return `${call.expression.getText()}@${ts.SyntaxKind[parent.kind]}#${siblingOrdinal(parent)}`;
    }
    if (ts.isFunctionLike(parent)) break;
  }
  return `${call.expression.getText()}#${siblingOrdinal(call)}`;
}

function ownerOf(node) {
  const owners = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
      owners.push(`${parent.name?.getText() ?? '<anonymous>'}#${siblingOrdinal(parent)}`);
    }
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isModuleDeclaration(parent)) {
      owners.push(`${parent.name?.getText() ?? '<anonymous>'}#${siblingOrdinal(parent)}`);
    }
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      const holder = parent.parent;
      if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) {
        owners.push(holder.name.getText());
      } else if (ts.isCallExpression(holder)) {
        owners.push(`${callbackSite(holder)}:arg${holder.arguments.indexOf(parent)}`);
      } else {
        owners.push('<anonymous>');
      }
    }
  }
  return owners.length > 0 ? owners.reverse().join('>') : '<module>';
}

/** A read moved to another statement is a new site even inside one function. */
function statementPath(node) {
  const statements = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) break;
    if (ts.isStatement(parent) && !ts.isBlock(parent)) {
      statements.push(`${ts.SyntaxKind[parent.kind]}#${siblingOrdinal(parent)}`);
    }
  }
  return statements.reverse().join('>');
}

function enclosingStatement(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isStatement(parent) && !ts.isBlock(parent)) return parent;
  }
  return node;
}

/** Child positions inside one statement distinguish moves between call args. */
function expressionPath(node) {
  const statement = enclosingStatement(node);
  const positions = [];
  for (let child = node; child !== statement && child.parent; child = child.parent) {
    let position = 0;
    ts.forEachChild(child.parent, (sibling) => {
      if (sibling === child) return true;
      position++;
      return undefined;
    });
    positions.push(position);
  }
  return positions.reverse().join('.');
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
  if (['byStorey', 'byBuilding', 'bySite', 'bySpace', 'elementToStorey'].includes(name)
      && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'spatialHierarchy')
        || (ts.isIdentifier(node.expression) && node.expression.text === 'spatialHierarchy'))) {
    return `spatialHierarchy.${name}`;
  }
  if ((name === 'byType' || name === 'byId')
      && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'entityIndex')
        || (ts.isIdentifier(node.expression) && node.expression.text === 'entityIndex'))) return `entityIndex.${name}`;
  if (name === 'getByType'
      && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'entities')
        || (ts.isIdentifier(node.expression) && node.expression.text === 'entities'))) return 'entities.getByType';
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
        key: `${path}|${ownerOf(node)}@${statementPath(node)}:${expressionPath(node)}|${kind}|${node.getText(source).replace(/\s+/g, '')}`,
        kind,
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
export function excessRawAccess(before, after, reviewed = false) {
  const budget = new Map();
  for (const hit of before) {
    // #5249 spatial containment is newly scanned. Preserve its existing
    // sites during the migration, even in files reviewed for entity tables.
    // A new spatial read still has no old slot and fails the ratchet.
    const spatial = hit.kind?.startsWith('spatialHierarchy.');
    if ((!reviewed || spatial) && !hit.reason) {
      budget.set(hit.key, (budget.get(hit.key) ?? 0) + 1);
    }
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
