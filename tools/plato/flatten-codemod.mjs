// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Flattening pass over the scalar-codemodded Plato output (phase 2; phase 1 is
// scalar-codemod.mjs, which invokes this module).
//
// The generated Vec3/Box3 classes are correct but allocation-heavy at the
// adapter boundary: every tuple-API call packs tuples into objects, and the
// functional style recomputes pure subexpressions (GapX two or three times per
// signedGap). Because every generated method body is a single pure expression,
// both problems are mechanically removable: this pass symbolically inlines the
// method bodies down to scalar arithmetic over the tuple inputs (beta
// reduction + scalar replacement of the Vec3/Box3 records), hash-conses the
// resulting expression DAG (so any subexpression is computed once), and emits
// flat tuple-native functions with shared subexpressions hoisted into consts.
//
// Laziness: nodes used once stay inline, so the || spine of the SAT test keeps
// its early-out; nodes used twice or more are hoisted eagerly, which matches
// the old hand-written kernel (it also computed all axes eagerly).
//
// Everything here relies on the generated code being pure expressions; the
// pass throws on anything it does not recognise rather than guessing.

import ts from 'typescript';

const FLAT_MARKER_START = '// ==== Flattened tuple kernels (emitted by flatten-codemod.mjs) ====';

// The tuple-facing API of packages/clash/src/math, mapped onto the generated
// class methods. `self`/`args` describe how the flat parameters bind to the
// method parameters ('vec' = [x,y,z] tuple, 'box' = {min,max}, 'num' = scalar).
const FLAT_TARGETS = [
  { flat: 'sub', cls: 'Vec3', method: 'Sub', params: [['a', 'vec'], ['b', 'vec']], ret: 'vec' },
  { flat: 'add', cls: 'Vec3', method: 'Plus', params: [['a', 'vec'], ['b', 'vec']], ret: 'vec' },
  { flat: 'scale', cls: 'Vec3', method: 'Scale', params: [['a', 'vec'], ['s', 'num']], ret: 'vec' },
  { flat: 'cross', cls: 'Vec3', method: 'Cross', params: [['a', 'vec'], ['b', 'vec']], ret: 'vec' },
  { flat: 'dot', cls: 'Vec3', method: 'Dot', params: [['a', 'vec'], ['b', 'vec']], ret: 'num' },
  { flat: 'lenSq', cls: 'Vec3', method: 'LenSq', params: [['a', 'vec']], ret: 'num' },
  { flat: 'distSq', cls: 'Vec3', method: 'DistSq', params: [['a', 'vec'], ['b', 'vec']], ret: 'num' },
  { flat: 'mid', cls: 'Vec3', method: 'Mid', params: [['a', 'vec'], ['b', 'vec']], ret: 'vec' },
  { flat: 'centroid', cls: 'Vec3', method: 'Centroid', params: [['a', 'vec'], ['b', 'vec'], ['c', 'vec']], ret: 'vec' },
  { flat: 'inflate', cls: 'Box3', method: 'Inflate', params: [['b', 'box'], ['m', 'num']], ret: 'box' },
  { flat: 'center', cls: 'Box3', method: 'Center', params: [['b', 'box']], ret: 'vec' },
  { flat: 'intersects', cls: 'Box3', method: 'Intersects', params: [['a', 'box'], ['b', 'box']], ret: 'bool' },
  { flat: 'signedGap', cls: 'Box3', method: 'SignedGap', params: [['a', 'box'], ['b', 'box']], ret: 'num' },
  { flat: 'overlapBounds', cls: 'Box3', method: 'OverlapBounds', params: [['a', 'box'], ['b', 'box']], ret: 'box' },
  { flat: 'aabbContains', cls: 'Box3', method: 'Contains', params: [['outer', 'box'], ['inner', 'box']], ret: 'bool' },
  { flat: 'boundsOfPoints', cls: 'Vec3', method: 'BoundsOfPoints', params: [['a', 'vec'], ['b', 'vec']], ret: 'box' },
  {
    flat: 'triTriIntersect', cls: 'Vec3', method: 'TriTriIntersectEps',
    params: [['a0', 'vec'], ['a1', 'vec'], ['a2', 'vec'], ['b0', 'vec'], ['b1', 'vec'], ['b2', 'vec'], ['eps', 'num']],
    defaults: { eps: '1e-12' }, ret: 'bool',
  },
];

const BIN_OPS = new Map([
  [ts.SyntaxKind.PlusToken, '+'],
  [ts.SyntaxKind.MinusToken, '-'],
  [ts.SyntaxKind.AsteriskToken, '*'],
  [ts.SyntaxKind.SlashToken, '/'],
  [ts.SyntaxKind.PercentToken, '%'],
  [ts.SyntaxKind.AsteriskAsteriskToken, '**'],
  [ts.SyntaxKind.LessThanToken, '<'],
  [ts.SyntaxKind.GreaterThanToken, '>'],
  [ts.SyntaxKind.LessThanEqualsToken, '<='],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>='],
  [ts.SyntaxKind.AmpersandAmpersandToken, '&&'],
  [ts.SyntaxKind.BarBarToken, '||'],
]);

/** Hash-consed pure-expression DAG. */
class Dag {
  constructor() {
    this.byKey = new Map();
    this.seq = 0;
  }

  intern(node) {
    const key =
      node.kind === 'leaf' || node.kind === 'num'
        ? `${node.kind}:${node.text}`
        : node.kind === 'bin'
          ? `bin:${node.op}:${node.l.id}:${node.r.id}`
          : node.kind === 'pre'
            ? `pre:${node.op}:${node.x.id}`
            : node.kind === 'call'
              ? `call:${node.fn}:${node.args.map((a) => a.id).join(',')}`
              : `cond:${node.c.id}:${node.t.id}:${node.f.id}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    node.id = this.seq++;
    this.byKey.set(key, node);
    return node;
  }

  leaf(text) { return this.intern({ kind: 'leaf', text }); }
  num(text) { return this.intern({ kind: 'num', text }); }
  bin(op, l, r) { return this.intern({ kind: 'bin', op, l, r }); }
  pre(op, x) { return this.intern({ kind: 'pre', op, x }); }
  call(fn, args) { return this.intern({ kind: 'call', fn, args }); }
  cond(c, t, f) { return this.intern({ kind: 'cond', c, t, f }); }
}

/** A Vec3/Box3 value under scalar replacement: a tagged record of DAG nodes. */
function rec(cls, fields) {
  return { kind: 'rec', cls, fields };
}

/** Collect the single return expression of a pure method/function body. */
function bodyExpression(body, what) {
  if (!body || !ts.isBlock(body) || body.statements.length !== 1) {
    throw new Error(`${what}: expected a single-statement body`);
  }
  const stmt = body.statements[0];
  if (!ts.isReturnStatement(stmt) || !stmt.expression) {
    throw new Error(`${what}: expected a single return statement`);
  }
  return stmt.expression;
}

/** Index every Vec3/Box3 method and Scalars function in the phase-1 output. */
function indexCallables(sourceFile) {
  const methods = new Map(); // 'Vec3.Sub' -> { params: string[], expr }
  const scalars = new Map(); // 'FoldMin' -> { params: string[], expr }
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name && (stmt.name.text === 'Vec3' || stmt.name.text === 'Box3')) {
      for (const member of stmt.members) {
        if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
        const name = `${stmt.name.text}.${member.name.text}`;
        methods.set(name, {
          params: member.parameters.map((p) => p.name.getText(sourceFile)),
          expr: bodyExpression(member.body, name),
        });
      }
    }
    if (
      ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name) && stmt.name.text === 'Scalars' &&
      stmt.body && ts.isModuleBlock(stmt.body)
    ) {
      for (const fn of stmt.body.statements) {
        if (!ts.isFunctionDeclaration(fn) || !fn.name) continue;
        scalars.set(fn.name.text, {
          params: fn.parameters.map((p) => p.name.getText(sourceFile)),
          expr: bodyExpression(fn.body, `Scalars.${fn.name.text}`),
        });
      }
    }
  }
  return { methods, scalars };
}

/**
 * Symbolically evaluate a phase-1 expression AST to a DAG node (scalars) or a
 * record (Vec3/Box3 values). `env` maps parameter names (and 'this') to
 * nodes/records.
 */
function evaluate(node, env, ctx) {
  const { dag, methods, scalars, sourceFile } = ctx;
  const ev = (n, e) => evaluate(n, e, ctx);

  if (ts.isParenthesizedExpression(node)) return ev(node.expression, env);
  if (ts.isNumericLiteral(node)) return dag.num(node.getText(sourceFile));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return dag.leaf('true');
  if (node.kind === ts.SyntaxKind.FalseKeyword) return dag.leaf('false');
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    const self = env.get('this');
    if (!self) throw new Error('this outside a method');
    return self;
  }
  if (ts.isIdentifier(node)) {
    const bound = env.get(node.text);
    if (!bound) throw new Error(`unbound identifier '${node.text}'`);
    return bound;
  }
  if (ts.isBinaryExpression(node)) {
    const op = BIN_OPS.get(node.operatorToken.kind);
    if (!op) throw new Error(`unsupported binary operator: ${node.operatorToken.getText(sourceFile)}`);
    return dag.bin(op, ev(node.left, env), ev(node.right, env));
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const op =
      node.operator === ts.SyntaxKind.MinusToken ? '-' :
      node.operator === ts.SyntaxKind.ExclamationToken ? '!' : null;
    if (!op) throw new Error('unsupported prefix operator');
    return dag.pre(op, ev(node.operand, env));
  }
  if (ts.isConditionalExpression(node)) {
    const c = ev(node.condition, env);
    const t = ev(node.whenTrue, env);
    const f = ev(node.whenFalse, env);
    if (t.kind === 'rec' || f.kind === 'rec') {
      throw new Error('conditional yielding a Vec3/Box3 record is not supported by the flattener');
    }
    return dag.cond(c, t, f);
  }
  if (ts.isNewExpression(node)) {
    const cls = node.expression.getText(sourceFile);
    const args = (node.arguments ?? []).map((a) => ev(a, env));
    if (cls === 'Vec3') return rec('Vec3', { X: args[0], Y: args[1], Z: args[2] });
    if (cls === 'Box3') return rec('Box3', { Min: args[0], Max: args[1] });
    throw new Error(`unsupported constructor: new ${cls}`);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const recv = ev(node.expression, env);
    if (recv.kind !== 'rec') throw new Error(`property access .${node.name.text} on a non-record`);
    const field = recv.fields[node.name.text];
    if (!field) throw new Error(`record ${recv.cls} has no field .${node.name.text}`);
    return field;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) throw new Error('unsupported call shape');
    const name = callee.name.text;
    const owner = callee.expression;
    // Math.sqrt(x) etc.
    if (ts.isIdentifier(owner) && owner.text === 'Math') {
      return dag.call(`Math.${name}`, node.arguments.map((a) => evaluate(a, env, ctx)));
    }
    // Scalars.FoldMin(...)
    if (ts.isIdentifier(owner) && owner.text === 'Scalars') {
      const fn = scalars.get(name);
      if (!fn) throw new Error(`unknown Scalars function '${name}'`);
      const args = node.arguments.map((a) => evaluate(a, env, ctx));
      return evaluate(fn.expr, bindParams(fn.params, args, null), ctx);
    }
    // recv.Method(...) on a Vec3/Box3 record: beta-reduce the method body.
    const recv = evaluate(owner, env, ctx);
    if (recv.kind !== 'rec') throw new Error(`method call .${name} on a non-record`);
    const method = methods.get(`${recv.cls}.${name}`);
    if (!method) throw new Error(`unknown method ${recv.cls}.${name}`);
    const args = node.arguments.map((a) => evaluate(a, env, ctx));
    return evaluate(method.expr, bindParams(method.params, args, recv), ctx);
  }
  throw new Error(`unsupported expression kind: ${ts.SyntaxKind[node.kind]}`);
}

function bindParams(params, args, self) {
  if (params.length !== args.length) {
    throw new Error(`arity mismatch: expected ${params.length} args, got ${args.length}`);
  }
  const env = new Map();
  if (self) env.set('this', self);
  params.forEach((p, i) => env.set(p, args[i]));
  return env;
}

/** Count DAG uses (one per parent edge) from a set of scalar roots. */
function countUses(roots) {
  const uses = new Map();
  const visit = (node) => {
    const seen = uses.get(node.id) ?? 0;
    uses.set(node.id, seen + 1);
    if (seen > 0) return; // children already counted for this node
    if (node.kind === 'bin') { visit(node.l); visit(node.r); }
    else if (node.kind === 'pre') visit(node.x);
    else if (node.kind === 'call') node.args.forEach(visit);
    else if (node.kind === 'cond') { visit(node.c); visit(node.t); visit(node.f); }
  };
  roots.forEach(visit);
  return uses;
}

/** Emit one flat function body: hoisted consts (topo order) + return. */
function emitBody(roots, uses, renderReturn) {
  const names = new Map(); // node.id -> hoisted const name
  const lines = [];
  let n = 0;

  const shouldHoist = (node) =>
    (node.kind === 'bin' || node.kind === 'pre' || node.kind === 'call' || node.kind === 'cond') &&
    (uses.get(node.id) ?? 0) >= 2;

  const render = (node) => {
    const hoisted = names.get(node.id);
    if (hoisted) return hoisted;
    return renderRaw(node);
  };

  const renderRaw = (node) => {
    switch (node.kind) {
      case 'leaf':
      case 'num':
        return node.text;
      case 'bin':
        return `(${render(node.l)} ${node.op} ${render(node.r)})`;
      case 'pre':
        return node.op === '!' ? `!(${render(node.x)})` : `(-${render(node.x)})`;
      case 'call':
        return `${node.fn}(${node.args.map(render).join(', ')})`;
      case 'cond':
        return `(${render(node.c)} ? ${render(node.t)} : ${render(node.f)})`;
      default:
        throw new Error(`cannot render ${node.kind}`);
    }
  };

  // Post-order hoisting: children first so consts appear in dependency order.
  const hoist = (node) => {
    if (names.has(node.id) || node.kind === 'leaf' || node.kind === 'num') return;
    if (node.kind === 'bin') { hoist(node.l); hoist(node.r); }
    else if (node.kind === 'pre') hoist(node.x);
    else if (node.kind === 'call') node.args.forEach(hoist);
    else if (node.kind === 'cond') { hoist(node.c); hoist(node.t); hoist(node.f); }
    if (shouldHoist(node)) {
      const name = `t${n++}`;
      lines.push(`    const ${name} = ${renderRaw(node)};`);
      names.set(node.id, name);
    }
  };
  roots.forEach(hoist);

  lines.push(`    return ${renderReturn(render)};`);
  return lines.join('\n');
}

/** Scalar roots (in deterministic order) of a flat return value. */
function returnRoots(value, ret) {
  if (ret === 'num' || ret === 'bool') return [value];
  if (ret === 'vec') return [value.fields.X, value.fields.Y, value.fields.Z];
  // box
  return [...returnRoots(value.fields.Min, 'vec'), ...returnRoots(value.fields.Max, 'vec')];
}

function renderReturnValue(value, ret, render) {
  if (ret === 'num' || ret === 'bool') return render(value);
  if (ret === 'vec') {
    const f = value.fields;
    return `[${render(f.X)}, ${render(f.Y)}, ${render(f.Z)}]`;
  }
  return `{ min: ${renderReturnValue(value.fields.Min, 'vec', render)}, max: ${renderReturnValue(value.fields.Max, 'vec', render)} }`;
}

const TS_TYPES = { vec: 'FlatVec3', box: 'FlatBox3', num: 'number', bool: 'boolean' };

function flatParamBinding(dag, name, shape) {
  if (shape === 'num') return dag.leaf(name);
  if (shape === 'vec') {
    return rec('Vec3', { X: dag.leaf(`${name}[0]`), Y: dag.leaf(`${name}[1]`), Z: dag.leaf(`${name}[2]`) });
  }
  return rec('Box3', {
    Min: rec('Vec3', { X: dag.leaf(`${name}.min[0]`), Y: dag.leaf(`${name}.min[1]`), Z: dag.leaf(`${name}.min[2]`) }),
    Max: rec('Vec3', { X: dag.leaf(`${name}.max[0]`), Y: dag.leaf(`${name}.max[1]`), Z: dag.leaf(`${name}.max[2]`) }),
  });
}

/**
 * Append the flattened tuple kernels to phase-1 output text. Idempotent: any
 * existing flattened section is stripped and regenerated.
 */
export function appendFlattened(phase1Text, fileName = 'plato.g.ts') {
  // Strip any existing flattened section. The marker comment does not survive
  // a re-run (the phase-1 printer strips comments), so also cut at the first
  // flat statement, which is always the head of the emitted tail section.
  let markerAt = phase1Text.indexOf(FLAT_MARKER_START);
  if (markerAt === -1) markerAt = phase1Text.indexOf('export type FlatVec3 =');
  const base = markerAt === -1 ? phase1Text : phase1Text.slice(0, markerAt).replace(/\s*$/, '\n');

  const sourceFile = ts.createSourceFile(fileName, base, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { methods, scalars } = indexCallables(sourceFile);

  const out = [
    FLAT_MARKER_START,
    '//',
    '// Mechanically inlined from the Vec3/Box3 methods above (pure expression',
    '// bodies: beta reduction + scalar replacement + common-subexpression',
    '// hoisting). Tuple in, tuple out: no per-call object allocation. Nodes',
    '// used once stay inline, so the || spine of the SAT test keeps its',
    '// early-out.',
    '',
    'export type FlatVec3 = readonly [number, number, number];',
    'export interface FlatBox3 { readonly min: FlatVec3; readonly max: FlatVec3; }',
    '',
  ];

  for (const target of FLAT_TARGETS) {
    const dag = new Dag();
    const ctx = { dag, methods, scalars, sourceFile };
    const method = methods.get(`${target.cls}.${target.method}`);
    if (!method) throw new Error(`flatten target ${target.cls}.${target.method} not found`);

    const bindings = target.params.map(([name, shape]) => flatParamBinding(dag, name, shape));
    const value = evaluate(method.expr, bindParams(method.params, bindings.slice(1), bindings[0]), ctx);

    const roots = returnRoots(value, target.ret);
    const uses = countUses(roots);
    const body = emitBody(roots, uses, (render) => renderReturnValue(value, target.ret, render));

    const paramList = target.params
      .map(([name, shape]) => {
        const dflt = target.defaults?.[name];
        return `${name}: ${TS_TYPES[shape]}${dflt ? ` = ${dflt}` : ''}`;
      })
      .join(', ');
    const retType =
      target.ret === 'vec' ? '[number, number, number]' :
      target.ret === 'box' ? '{ min: [number, number, number]; max: [number, number, number] }' :
      TS_TYPES[target.ret];

    out.push(`export function ${target.flat}(${paramList}): ${retType} {`);
    out.push(body);
    out.push('}', '');
  }

  return base + '\n' + out.join('\n');
}
