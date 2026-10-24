// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { ts, parse, shape, hash, walk, callName, isSink, projection, SINKS } from './retained-loader-syntax.mjs';

const profiles = JSON.parse(readFileSync(new URL('./retained-loader-profiles.json', import.meta.url), 'utf8'));
const driverHelper = parse('helper.mjs', 'function loadSdkModule(path) { return import(path); }').statements[0];
const literal = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
const meta = node => ts.isPropertyAccessExpression(node) && node.name.text === 'url' &&
  ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

function approvedProfile(name, tree) {
  const kind = name === 'ifclite_smlib_browser.mjs' ? 'emscripten'
    : name === 'pkg-retained/ifc-lite.js' ? 'wasmBindgen' : name === 'client.mjs' ? 'client' : undefined;
  if (!kind) return undefined;
  const value = kind === 'client' ? shape(tree) : projection(tree, kind);
  return hash(value) === profiles.profiles[kind].sha256 ? profiles.profiles[kind] : undefined;
}

// A deliberately small immutable-literal resolver for ordinary module assets.
// Shadowed/reassigned bindings, arbitrary function calls and object properties
// are not inferred. Generated variable flows use the audited syntax profiles.
function resolver(tree) {
  const bindings = new Map(), writes = new Set();
  const bind = (name, value) => {
    if (!ts.isIdentifier(name)) return;
    bindings.set(name.text, bindings.has(name.text) ? null : value);
  };
  walk(tree, node => {
    if (ts.isVariableDeclaration(node)) bind(node.name,
      node.parent.flags & ts.NodeFlags.Const ? node.initializer : null);
    if (ts.isParameter(node)) bind(node.name, null);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) writes.add(node.left.text);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && ts.isIdentifier(node.operand)) writes.add(node.operand.text);
  });
  function resolve(node, seen = new Set()) {
    if (!node) throw new Error('Missing asset locator');
    if (literal(node) !== undefined) return literal(node);
    if (ts.isParenthesizedExpression(node)) return resolve(node.expression, seen);
    if (ts.isIdentifier(node) && !seen.has(node.text) && !writes.has(node.text) && bindings.get(node.text)) {
      return resolve(bindings.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isNewExpression(node) && callName(node) === 'URL' && node.arguments?.length === 2 && meta(node.arguments[1])) {
      return resolve(node.arguments[0], seen);
    }
    throw new Error(`Unresolved asset locator: ${node.getText().slice(0,100)}`);
  }
  return resolve;
}

export function dependencies(assets, driverPaths = []) {
  if (ts.version !== profiles.parser) throw new Error(`Retained syntax profiles require TypeScript ${profiles.parser}; review parser upgrades`);
  const edges = [];
  for (const [name, bytes] of assets) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const tree = parse(name, bytes.toString()), requests = new Set();
    const profile = approvedProfile(name, tree), resolve = resolver(tree);
    if (profile) for (const root of profile.roots) requests.add(root);
    let helper;
    if (driverPaths.includes(name)) {
      helper = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'loadSdkModule');
      if (!helper || hash(shape(helper)) !== hash(shape(driverHelper))) throw new Error(`Unknown retained import helper in ${name}`);
    }
    walk(tree, node => {
      // Only actual module declarations create static edges. Object keys,
      // comments, regex and ordinary string/template values do not.
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = literal(node.moduleSpecifier);
        if (!specifier?.startsWith('.') && !specifier?.startsWith('/')) throw new Error(`Bare static import in ${name}`);
        requests.add(specifier);
      }
      if (helper && ts.isIdentifier(node) && node.text === 'loadSdkModule') {
        if (node === helper.name) return;
        if (!ts.isCallExpression(node.parent) || node.parent.expression !== node || node.parent.arguments.length !== 1 ||
            literal(node.parent.arguments[0]) === undefined) throw new Error(`Unresolved retained import helper call in ${name}`);
        requests.add(literal(node.parent.arguments[0]));
      }
      if (ts.isNewExpression(node) && callName(node) === 'SmlibWorkerTransport') {
        const options = node.arguments?.[0];
        if (!options || !ts.isObjectLiteralExpression(options)) throw new Error(`Unknown transport options in ${name}`);
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'workerUrl') throw new Error(`Unknown transport option in ${name}`);
          requests.add(resolve(property.initializer));
        }
      }
      if (!isSink(node)) {
        // Aliasing/passing entry points would hide their later call sites.
        const entry = ts.isIdentifier(node) ? node.text
          : ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isElementAccessExpression(node) ? literal(node.argumentExpression) : undefined;
        if (SINKS.has(entry) && !profile) {
          const parent = node.parent;
          const callee = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node;
          const memberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
          const guard = ts.isTypeOfExpression(parent) || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword);
          if (!callee && !memberName && !guard) throw new Error(`Escaped asset entry point ${entry} in ${name}`);
        }
        return;
      }
      const kind = callName(node);
      if (kind === 'import') {
        if (helper && node.parent === helper.body.statements[0]) return;
        const specifier = literal(node.arguments[0]);
        if (specifier === undefined) throw new Error(`Unresolved dynamic import in ${name}`);
        if (name === 'ifclite_smlib_browser.mjs' && ['module', 'node:module'].includes(specifier)) return;
        requests.add(specifier); return;
      }
      // The profile includes every sink and every binding/write/reference of
      // the loader's locator variables. Matching a filename alone grants nothing.
      if (profile) return;
      if (kind === 'URL') {
        if (node.arguments?.length !== 2 || !meta(node.arguments[1])) throw new Error(`Unknown URL base in ${name}`);
      }
      if (!['URL', 'Worker', 'SharedWorker', 'fetch', 'importScripts'].includes(kind)) throw new Error(`Unknown asset sink ${kind} in ${name}`);
      const args = kind === 'importScripts' ? node.arguments : [node.arguments?.[0]];
      for (const argument of args) requests.add(resolve(argument));
    });
    for (const specifier of [...requests].sort()) {
      const target = specifier.startsWith('/smlib/') ? specifier.slice(7)
        : posix.normalize(posix.join(posix.dirname(name), specifier));
      if (target.startsWith('../') || specifier.includes(':') || specifier.includes('\\') ||
          (specifier.startsWith('/') && !specifier.startsWith('/smlib/')) || !assets.has(target)) {
        throw new Error(`Missing or external dependency ${name} -> ${specifier}`);
      }
      edges.push({ from: name, specifier, to: target });
    }
  }
  return edges;
}
