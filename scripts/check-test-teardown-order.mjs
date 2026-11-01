#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GATE: a test's teardown may not remove a directory before it releases what
 * is still using it.
 *
 * THE FLAKE. `apps/viewer/src/lib/retained/retained-engine.test.ts` failed
 * viewer shard 12 in eight merge-queue runs (2026-10-31/11-01, #8481 to
 * #8506). Its `fixture(t)` helper registered `t.after(() => rm(root))`, then
 * the test registered `t.after(() => server.close())`. `node:test` runs after
 * hooks in REGISTRATION order, so the directory went first while the Vite dev
 * server was still writing `.vite`: `ENOTEMPTY`. A hook that throws also skips
 * every later hook, so `server.close()` never ran and the open server held the
 * file until its 120 s timeout. Fixed by #8494; this gate keeps the shape out.
 *
 * Vitest runs after hooks in reverse, which is why the order looks natural and
 * is wrong only under `node:test`. A hand-rolled disposer list drained front
 * to back is first-in-first-out under either runner.
 *
 * WHAT IS FLAGGED (lexically, through the TypeScript parser):
 *  R1  In a file that imports `node:test`, an after hook (`t.after`,
 *      `t.afterEach`, `after`, `afterEach`) whose callback calls `rm`,
 *      `rmSync`, `rmdir` or `rmdirSync`, followed in the same function by
 *      another hook of the same kind on the same receiver.
 *  R2  The same removal hook registered inside a named helper on its
 *      context parameter (`fixture(t)`), where a caller registers another
 *      hook on that context after calling the helper.
 *  R3  In any test file, a teardown loop that drains a disposer array front
 *      to back (`for (const d of list.splice(0)) await d()`) when a removal
 *      was pushed into that list before another disposer: earlier in the
 *      same `push`, earlier in the same function, or by a helper whose
 *      caller pushes afterwards.
 *
 * THE FIX it asks for: release first, remove last, in one hook
 * (`t.after(async () => { try { await close(); } finally { await rm(dir); } })`),
 * or drain the list in reverse. Registration order is the contract here, so
 * there is no allowlist; every hit on the tree at introduction was fixed.
 *
 * STATED HOLES. A removal hidden behind another helper (`cleanup(dir)`), a
 * context passed under a different name than the receiver, and a disposer
 * list built by spreading are not followed. The gate names a shape, not every
 * spelling of it.
 *
 * Run: `node scripts/check-test-teardown-order.mjs` (CI node-tests job and
 * scripts/pre-handoff.mjs).
 *
 * EXIT  0 clean   1 a violation, or a scan too small to trust
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_FILE = /\.test\.(ts|tsx|mts|cts|mjs|js|cjs)$/;
/** A broken file listing must not report a clean tree. */
export const FILE_FLOOR = 3000;
/** Removal hooks and pushes seen across the tree; a broken detector sees none. */
export const REMOVAL_FLOOR = 40;

const REMOVE = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync']);
const HOOKS = new Set(['after', 'afterEach']);
const TEARDOWN = new Set(['after', 'afterEach', 'afterAll']);

const calleeName = (c) => (ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '');

/** Does `node` call a filesystem removal anywhere inside it? */
export function removes(node) {
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isCallExpression(n) && REMOVE.has(calleeName(n.expression))) { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return node.getSourceFile();
}

function functionName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}

/** `t.after(cb)` -> { receiver: 't', kind: 'after' }; bare `after(cb)` -> receiver ''. */
function hookOf(call) {
  const c = call.expression;
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && HOOKS.has(c.name.text)) {
    return { receiver: c.expression.text, kind: c.name.text };
  }
  if (ts.isIdentifier(c) && HOOKS.has(c.text)) return { receiver: '', kind: c.text };
  return null;
}

function insideTeardown(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && TEARDOWN.has(calleeName(p.expression))) return true;
  }
  return false;
}

/** The array a teardown loop drains front to back, or null. */
function drainedArray(loop) {
  if (!ts.isForOfStatement(loop) || !insideTeardown(loop)) return null;
  const decl = loop.initializer;
  const name = ts.isVariableDeclarationList(decl) && decl.declarations.length === 1
    && ts.isIdentifier(decl.declarations[0].name) ? decl.declarations[0].name.text : null;
  if (!name) return null;
  let called = false;
  const visit = (n) => {
    if (called) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) { called = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(loop.statement);
  if (!called) return null;
  let e = loop.expression;
  // `list.splice(0)` drains in order; `.reverse()` / `.toReversed()` does not.
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    if (e.expression.name.text !== 'splice') return null;
    e = e.expression.expression;
  }
  return ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? e.getText() : null;
}

/** Every violation in one file: `{ path, line, rule, message }`; `removals` counts what was seen. */
export function scanSource(path, src) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[mc]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const nodeTest = sf.statements.some((s) => ts.isImportDeclaration(s)
    && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === 'node:test');
  const hooks = [];
  const calls = [];
  const drains = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      calls.push(n);
      const hook = nodeTest ? hookOf(n) : null;
      if (hook && n.arguments.length) hooks.push({ ...hook, node: n, fn: enclosingFunction(n), removes: removes(n.arguments[0]) });
    }
    const drained = drainedArray(n);
    if (drained) drains.push({ node: n, array: drained });
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const after = (a, b) => a.getStart(sf) > b.getStart(sf);
  const violations = [];
  const flag = (n, rule, message) => violations.push({ path, line: line(n), rule, message });
  let removals = 0;

  for (const h of hooks.filter((x) => x.removes)) {
    removals++;
    const label = `${h.receiver ? `${h.receiver}.` : ''}${h.kind}`;
    const later = hooks.find((o) => o !== h && o.fn === h.fn && o.receiver === h.receiver
      && o.kind === h.kind && after(o.node, h.node));
    if (later) {
      flag(h.node, 'R1', `${label} removes a path but runs before the ${label} registered at line ${line(later.node)}`);
      continue;
    }
    const index = h.receiver && ts.isFunctionLike(h.fn) ? h.fn.parameters.findIndex((p) => p.name.getText(sf) === h.receiver) : -1;
    const name = index >= 0 ? functionName(h.fn) : null;
    if (!name) continue;
    for (const c of calls) {
      const arg = c.arguments[index];
      if (calleeName(c.expression) !== name || !arg || !ts.isIdentifier(arg)) continue;
      const caller = enclosingFunction(c);
      const late = hooks.find((o) => o.fn === caller && o.receiver === arg.text && o.kind === h.kind && after(o.node, c));
      if (late) {
        flag(h.node, 'R2', `${name}() registers a removing ${label}, and its caller at line ${line(c)} `
          + `registers another at line ${line(late.node)} that runs after the removal`);
      }
    }
  }

  for (const d of drains) {
    const pushes = calls.filter((c) => ts.isPropertyAccessExpression(c.expression)
      && c.expression.name.text === 'push' && c.expression.expression.getText(sf) === d.array);
    for (const p of pushes) {
      const at = p.arguments.findIndex((a) => removes(a));
      if (at < 0) continue;
      removals++;
      const where = `${d.array} is drained first-in-first-out at line ${line(d.node)}`;
      if (at < p.arguments.length - 1) { flag(p, 'R3', `a removal is pushed before another disposer; ${where}`); continue; }
      const fn = enclosingFunction(p);
      const later = pushes.find((o) => o !== p && enclosingFunction(o) === fn && after(o, p));
      if (later) { flag(p, 'R3', `a removal is pushed before the disposer at line ${line(later)}; ${where}`); continue; }
      const name = ts.isFunctionLike(fn) ? functionName(fn) : null;
      if (!name) continue;
      for (const c of calls) {
        if (calleeName(c.expression) !== name) continue;
        const caller = enclosingFunction(c);
        const late = pushes.find((o) => enclosingFunction(o) === caller && after(o, c));
        if (late) flag(p, 'R3', `${name}() pushes a removal, and its caller at line ${line(c)} pushes a disposer at line ${line(late)}; ${where}`);
      }
    }
  }
  return { violations, removals };
}

export function listTestFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr || r.error?.message}`);
  return r.stdout.split('\0').filter((p) => TEST_FILE.test(p));
}

export function runCheck(root, { files = listTestFiles(root), read = (p) => readFileSync(join(root, p), 'utf8'),
  fileFloor = FILE_FLOOR, removalFloor = REMOVAL_FLOOR } = {}) {
  const errors = [];
  if (files.length < fileFloor) errors.push(`refusing a suspiciously small scan: ${files.length} test files (floor ${fileFloor})`);
  const violations = [];
  let removals = 0;
  for (const path of files) {
    const r = scanSource(path, read(path));
    violations.push(...r.violations);
    removals += r.removals;
  }
  if (removals < removalFloor) errors.push(`saw only ${removals} teardown removals (floor ${removalFloor}); is the scanner broken?`);
  return { errors, violations, scanned: files.length, removals };
}

function main() {
  const { errors, violations, scanned, removals } = runCheck(ROOT);
  for (const e of errors) console.error(`error: ${e}`);
  for (const v of violations) console.error(`${v.path}:${v.line}: ${v.rule}: ${v.message}`);
  if (violations.length) {
    console.error('\nnode:test runs after hooks in registration order and a failing hook skips the rest, so a\n'
      + 'directory removed first can fail with ENOTEMPTY and leave its server open (viewer shard 12,\n'
      + '#8494). Release first and remove last in one hook, or drain the disposer list in reverse.');
  }
  if (errors.length || violations.length) { process.exitCode = 1; return; }
  console.log(`test teardown order gate passed (${scanned} test files, ${removals} teardown removals)`);
}

if (isMainEntry(import.meta.url)) main();
