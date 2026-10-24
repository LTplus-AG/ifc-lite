// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { ts, parse, shape, hash, walk, callName, isSink, projection, SINKS } from './retained-loader-syntax.mjs';

const profiles = JSON.parse(readFileSync(new URL('./retained-loader-profiles.json', import.meta.url), 'utf8'));
const driverHelper = parse('helper.mjs', 'function loadSdkModule(path) { return import(path); }').statements[0];
const literal = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
const unparen = node => { while (node && ts.isParenthesizedExpression(node)) node = node.expression; return node; };
const freshURL = node => node && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL';
const meta = node => ts.isPropertyAccessExpression(node) && node.name.text === 'url' &&
  ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

function approvedProfile(name, tree) {
  const kind = name === 'ifclite_smlib_browser.mjs' ? 'emscripten'
    : name === 'pkg-retained/ifc-lite.js' ? 'wasmBindgen' : name === 'client.mjs' ? 'client' : undefined;
  if (!kind) return undefined;
  const value = kind === 'client' ? shape(tree) : projection(tree, kind);
  return hash(value) === profiles.profiles[kind].sha256 ? profiles.profiles[kind] : undefined;
}

// Proven subset, not name-based data-flow inference: every binding form counts
// toward uniqueness. Only simple block/module consts can supply literal roots.
// Their declarations must precede the reference and their lexical scope must
// contain it. Repeated names (even in disjoint scopes) deliberately fail closed.
// Generated variable flows continue to use the independent audited profiles.
function resolver(tree) {
  const bindings = new Map(), writes = new Set();
  const bind = (name, value = null) => {
    if (ts.isIdentifier(name)) {
      bindings.set(name.text, bindings.has(name.text) ? null : value);
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
    }
  };
  walk(tree, node => {
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent, statement = list.parent, scope = statement?.parent;
      const candidate = ts.isIdentifier(node.name) && ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Const) && ts.isVariableStatement(statement) &&
        (ts.isSourceFile(scope) || ts.isBlock(scope)) && node.initializer;
      bind(node.name, candidate ? { initializer: node.initializer, declaration: node, scope } : null);
    }
    if (ts.isParameter(node)) bind(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) bind(node.name);
    if (ts.isImportClause(node) && node.name) bind(node.name);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(node.name);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) writes.add(node.left.text);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && ts.isIdentifier(node.operand)) writes.add(node.operand.text);
  });
  function visible(binding, reference) {
    if (reference.getStart() < binding.declaration.end) return false;
    for (let parent = reference.parent; parent; parent = parent.parent) if (parent === binding.scope) return true;
    return false;
  }
  function stringValue(node, seen = new Set()) {
    if (!node) throw new Error('Missing asset locator');
    node = unparen(node);
    if (literal(node) !== undefined) return { specifier: literal(node), base: 'context', type: 'string' };
    if (ts.isIdentifier(node) && !seen.has(node.text) && !writes.has(node.text)) {
      const binding = bindings.get(node.text);
      if (binding && visible(binding, node)) {
        return stringValue(binding.initializer, new Set([...seen, node.text]));
      }
    }
    // Extracting href from a fresh URL produces an immutable primitive. A URL
    // object held in any binding, including const/aliases, is never followed.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'href' && freshURL(unparen(node.expression))) {
      return { ...urlValue(unparen(node.expression), seen), type: 'string' };
    }
    if (freshURL(node)) throw new Error('Stored URL object locator is not proven immutable');
    throw new Error(`Unresolved asset locator: ${node.getText().slice(0,100)}`);
  }
  function urlValue(node, seen = new Set()) {
    if (node.arguments?.length !== 2 || !meta(unparen(node.arguments[1]))) throw new Error('Unknown URL base');
    const value = stringValue(node.arguments[0], seen);
    return { specifier: value.specifier, base: 'module', type: 'url' };
  }
  return node => {
    node = unparen(node);
    return freshURL(node) ? urlValue(node) : stringValue(node);
  };
}

// A fresh object can go straight to a known sink, or yield its primitive href.
// Everything else (storage, aliases, properties/methods, returns, opaque calls)
// may expose mutable URL state and is outside the ordinary proven subset.
function directURLUse(node) {
  let use = node;
  while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
  const parent = use.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use && parent.name.text === 'href') {
    let field = parent;
    while (ts.isParenthesizedExpression(field.parent)) field = field.parent;
    const next = field.parent;
    return !(ts.isBinaryExpression(next) && next.left === field && next.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      next.operatorToken.kind <= ts.SyntaxKind.LastAssignment) &&
      !ts.isDeleteExpression(next) && !ts.isPrefixUnaryExpression(next) && !ts.isPostfixUnaryExpression(next);
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      ['fetch', 'Worker', 'SharedWorker', 'importScripts'].includes(callName(parent))) {
    return callName(parent) === 'importScripts' ? parent.arguments.includes(use) : parent.arguments?.[0] === use;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === use && parent.name.getText() === 'workerUrl') {
    const options = parent.parent, call = options.parent;
    return ts.isObjectLiteralExpression(options) && ts.isNewExpression(call) &&
      callName(call) === 'SmlibWorkerTransport' && call.arguments?.[0] === options;
  }
  return false;
}

function assetRequest(requests, locator) {
  if (locator.base !== 'module' && !locator.specifier.startsWith('/smlib/')) {
    throw new Error(`Unbound execution-context-relative asset locator: ${locator.specifier}`);
  }
  requests.add(locator.specifier);
}

// Browser module requests differ from fetch/URL paths: "runtime.mjs" and
// ".runtime.mjs" are bare specifiers, not sibling URLs. No import map is used.
function moduleRequest(requests, specifier, form, name) {
  if (typeof specifier !== 'string' || !(specifier.startsWith('./') ||
      specifier.startsWith('../') || specifier.startsWith('/'))) {
    throw new Error(`Bare ${form} import in ${name}: ${specifier}`);
  }
  // Supported absolute roots and forbidden schemes are checked with all edges.
  requests.add(specifier);
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
        moduleRequest(requests, specifier, 'static', name);
      }
      if (helper && ts.isIdentifier(node) && node.text === 'loadSdkModule') {
        if (node === helper.name) return;
        if (!ts.isCallExpression(node.parent) || node.parent.expression !== node || node.parent.arguments.length !== 1 ||
            literal(node.parent.arguments[0]) === undefined) throw new Error(`Unresolved retained import helper call in ${name}`);
        moduleRequest(requests, literal(node.parent.arguments[0]), 'dynamic', name);
      }
      if (ts.isNewExpression(node) && callName(node) === 'SmlibWorkerTransport') {
        const options = node.arguments?.[0];
        if (!options || !ts.isObjectLiteralExpression(options)) throw new Error(`Unknown transport options in ${name}`);
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'workerUrl') throw new Error(`Unknown transport option in ${name}`);
          assetRequest(requests, resolve(property.initializer));
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
        if (profile && name === 'ifclite_smlib_browser.mjs' && ['module', 'node:module'].includes(specifier)) return;
        moduleRequest(requests, specifier, 'dynamic', name); return;
      }
      // The profile includes every sink and every binding/write/reference of
      // the loader's locator variables. Matching a filename alone grants nothing.
      if (profile) return;
      if (kind === 'URL') {
        if (!freshURL(node) || !directURLUse(node)) throw new Error(`Unsupported stored or escaped URL object in ${name}`);
        assetRequest(requests, resolve(node));
        return;
      }
      if (!['URL', 'Worker', 'SharedWorker', 'fetch', 'importScripts'].includes(kind)) throw new Error(`Unknown asset sink ${kind} in ${name}`);
      const args = kind === 'importScripts' ? node.arguments : [node.arguments?.[0]];
      for (const argument of args) assetRequest(requests, resolve(argument));
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
