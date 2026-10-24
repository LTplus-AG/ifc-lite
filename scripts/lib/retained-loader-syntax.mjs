// SPDX-License-Identifier: MPL-2.0
// Parse only. Supplied modules are never evaluated or linked.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
export const ts = require('typescript'); // Existing root devDependency, pinned by pnpm-lock.
export function parse(name, source) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`Invalid JavaScript in ${name}`);
  return tree;
}
export function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
export function shape(node) {
  if (!node) return null;
  const children = []; ts.forEachChild(node, child => { children.push(shape(child)); });
  return [ts.SyntaxKind[node.kind], ts.isSourceFile(node) ? null : node.text ?? null,
    node.operator ?? null, ts.isVariableDeclarationList(node) ? node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let) : null, children];
}
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function callName(node) {
  const e = node.expression;
  if (e?.kind === ts.SyntaxKind.ImportKeyword) return 'import';
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return '';
}
export const SINKS = new Set(['import', 'fetch', 'URL', 'Worker', 'SharedWorker', 'importScripts', 'XMLHttpRequest']);
export function isSink(node) {
  return (ts.isCallExpression(node) || ts.isNewExpression(node)) && (SINKS.has(callName(node)) || (callName(node) === 'open' && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === 'xhr'));
}
function functionName(node) {
  if (node.name) return node.name.getText();
  const p = node.parent;
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) return p.name.getText();
  if (ts.isBinaryExpression(p)) return p.left.getText();
  return '<anonymous>';
}
function context(node) {
  const names = [];
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) names.unshift(functionName(p));
  return names;
}
function region(node) {
  // Whole helper bodies bind parameters to their known call sites. Keep only
  // locator statements in createWasm: unrelated wasm export names are mangled.
  const functions = [];
  for (let p = node; p; p = p.parent) if (ts.isFunctionLike(p)) functions.unshift(p);
  const helper = functions.find(p => !['Module', 'createWasm'].includes(functionName(p)));
  if (helper) return shape(helper);
  for (let p = node; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return ['signature', functionName(p), p.parameters.map(shape)];
    if (ts.isStatement(p) && !ts.isBlock(p)) return shape(p);
  }
  return shape(node);
}
export const PROTECTED = {
  emscripten: new Set(['_scriptName', 'scriptDirectory', 'wasmBinaryFile', 'findWasmBinary', 'locateFile',
    'readAsync', 'readBinary', 'getBinarySync', 'getWasmBinary', 'instantiateAsync', 'instantiateArrayBuffer', 'asyncLoad']),
  wasmBindgen: new Set(['module_or_path']),
};
// Record every locator sink AND every reference/write/binding of the variables
// that feed the supported generated loader. An extra assignment or sink changes
// this projection even when the original literal-root expression is still there.
export function projection(tree, kind) {
  const rows = new Map();
  walk(tree, node => {
    if (isSink(node) || ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && (PROTECTED[kind].has(node.text) || SINKS.has(node.text)))) {
      const value = [context(node), region(node)];
      rows.set(JSON.stringify(value), value);
    }
  });
  return [...rows].sort(([a], [b]) => a < b ? -1 : 1).map(([, value]) => value);
}
