#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: every `new GeometryProcessor(...)` must release its WASM handle
 * deterministically.
 *
 * `AGENTS.md` requires WASM handles to be freed in `try/finally`, but the rule
 * was self-policed, so compliance decayed one call site at a time. The audit in
 * issue #1959 found 12 sites that never disposed on any path -- including the
 * viewer's canonical model-load path, which fires on EVERY IFC load. Fixing
 * those individually does not stop the 13th from landing next week; only a gate
 * does.
 *
 * `GeometryProcessor` implements `[Symbol.dispose]()` (#1563), so the cheapest
 * correct form is `using processor = new GeometryProcessor(...)`.
 *
 * A construction is accepted when any of these holds:
 *
 *   1. `using` / `await using` binding    -- scope exit frees it.
 *   2. `try { ... } finally { p.dispose() }` in the enclosing function.
 *   3. The expression is the whole body of an arrow/function (a factory) --
 *      ownership transfers to the caller, which this gate checks separately at
 *      the call site.
 *   4. The site is in ALLOWLIST below, with a reason.
 *
 * WHAT THIS DOES NOT PROVE (reviewers on #2129 found each of these; they are
 * accepted limits, not oversights):
 *
 *   - The `finally` is not required to DOMINATE the construction. A throw
 *     before the try — engine init, an allocation — can still skip it.
 *   - Receivers are matched by identifier TEXT, with no scope resolution, so a
 *     shadowed or captured binding of the same name can satisfy a check.
 *   - `handedToDisposer` accepts a matching callback anywhere in the enclosing
 *     function; it does not prove that callee actually owns the handle.
 *
 * All three are over-acceptance: the gate can miss a leak, it cannot invent
 * one. That direction is deliberate. A gate that rejects a correct fix gets
 * disabled — this one already tried to reject #2127, which was right and my
 * own fix was not. Closing these properly needs real scope resolution (a
 * `ts.TypeChecker` over a full program) rather than a single-file AST walk,
 * which is a much larger tool than the problem currently justifies.
 *
 * It still catches the shape that actually happened twelve times: a processor
 * constructed, used locally, and never freed on any path.
 *
 * Run via `pnpm check:wasm-disposal` (wired into the CI node-test job).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo', 'e2e']);
const SOURCE_RE = /\.(ts|tsx|mts)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mts)$/;

/** Classes that own a WASM handle and must be disposed. */
const DISPOSABLE_CLASSES = new Set(['GeometryProcessor']);

/**
 * Sites that legitimately never dispose. Keyed by `path:line-independent`
 * identity (path + the variable name) so an unrelated edit that shifts line
 * numbers does not silently move an allowance onto a different construction.
 *
 * Currently EMPTY, deliberately. The obvious candidates — the
 * `create-ifc-lite` scaffolding templates — are not detected at all, because
 * their `new GeometryProcessor()` lives inside a template literal and is
 * string content to the parser, not a `NewExpression`. Allowlisting them would
 * have looked like coverage while proving nothing, so the entries were removed
 * once the AST confirmed they never reach this check. Generated starter code
 * is not linted by this gate; if that ever matters it needs a separate check
 * that parses the emitted template.
 */
const ALLOWLIST = new Map([]);

/**
 * Lower bound on how many source files the walk must reach. Measured on a
 * healthy tree: 2002 non-test `.ts`/`.tsx`/`.mts` files under
 * `apps/` + `packages/`. Set to 1200 — deep headroom, because
 * this number only has to separate "the walk works" from "the walk found
 * nothing", and every way it breaks (a wrong root, an unreadable directory, a
 * cwd change) takes it to zero, never to a plausible-looking fraction.
 */
const SOURCE_FLOOR = 1200;

/**
 * Lower bound on how many disposable-handle constructions the AST detector
 * must still find. Measured on a healthy tree: 27. Set to
 * 18 — a third of headroom, so the ordinary
 * arrival and removal of call sites does not force an edit here, while the
 * failure this guards against (a `ts` API change, a rename in
 * DISPOSABLE_CLASSES, a visitor that stops recursing) still trips: each of
 * those drops the count to zero, not to 17.
 */
const CONSTRUCTION_FLOOR = 18;

/**
 * Fails closed on a directory it cannot read. The old `catch { return out; }`
 * turned a missing scan root, a typo'd path and a permissions error alike into
 * "no source files here", which let the whole gate print its success line
 * having opened nothing at all (#3194). The two cases are distinguished
 * because they call for different fixes: a MISSING directory means SCAN_DIRS
 * or the working directory is wrong; an UNREADABLE one is an environment
 * fault. Neither is a clean scan.
 */
function findSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const why =
      err?.code === 'ENOENT'
        ? `does not exist — SCAN_DIRS in this gate, or the tree it was pointed at, is wrong`
        : `could not be read (${err?.code ?? err?.message})`;
    console.error(
      `\n\u274c check-wasm-disposal: ${relative(ROOT, dir) || dir} ${why}.\n` +
        `Refusing a vacuous pass: a directory this gate cannot open is a broken scan, not a clean one.\n`,
    );
    process.exit(1);
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    // A dangling symlink is not a source file, but it is also not a reason to
    // die with a raw stack trace -- a stale build artifact or a bad checkout
    // leaves them around. Anything OTHER than "the target is gone" is a broken
    // scan and stays loud, matching how this walk treats an unreadable dir.
    let st;
    try {
      st = statSync(full);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (st.isDirectory()) findSourceFiles(full, out);
    else if (SOURCE_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
  return out;
}

/** The nearest enclosing function-like node, or the source file. */
function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isSourceFile(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * `using x = ...` / `await using x = ...`
 *
 * Test the `Using` BIT only. `NodeFlags.AwaitUsing` is `Using | Const` (6), so
 * `flags & AwaitUsing` is non-zero for every ordinary `const` (2) — an
 * `|| (flags & AwaitUsing)` clause here silently accepts the entire codebase
 * and the gate reports success while checking nothing. `AwaitUsing` already
 * contains the `Using` bit, so this single test covers both forms.
 */
function isUsingBinding(decl) {
  const list = decl.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return false;
  return (list.flags & ts.NodeFlags.Using) === ts.NodeFlags.Using;
}

/** Does any `finally` block inside `scope` call `<name>.dispose()`? */
function disposedInFinally(scope, name) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isTryStatement(node) && node.finallyBlock) {
      const scan = (n) => {
        if (found) return;
        if (ts.isCallExpression(n)) {
          const target = n.expression;
          // p.dispose()  |  p?.dispose()
          if (
            (ts.isPropertyAccessExpression(target) || ts.isPropertyAccessChain?.(target)) &&
            target.name?.text === 'dispose'
          ) {
            const receiver = target.expression;
            if (ts.isIdentifier(receiver) && receiver.text === name) found = true;
            // p?.dispose() where receiver is a NonNullExpression etc.
            if (
              !found &&
              receiver &&
              ts.isIdentifier(receiver.expression ?? {}) &&
              receiver.expression.text === name
            ) {
              found = true;
            }
          }
        }
        ts.forEachChild(n, scan);
      };
      scan(node.finallyBlock);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/**
 * Is the handle handed to something that owns its disposal?
 *
 *     geometryHandle = createGeometryProcessorDisposer(() => processor.dispose());
 *
 * A lexical `finally` is not always correct. In `useIfcLoader` the processor is
 * shared with the data-model parser via `getApi()`, so freeing it at the end of
 * the geometry block would free a handle the parser is still reading — the
 * disposal has to wait for whichever consumer finishes last (#2127). That is a
 * real disposal, expressed through an indirection this gate must not punish:
 * a check that fails the *correct* fix is the thing that gets checks disabled.
 *
 * Accepted shape: `name.dispose()` inside a function passed as an argument to a
 * call. Deliberately narrower than "mentions dispose anywhere" — a bare
 * `p.dispose()` on the success path only would still be flagged.
 */
function handedToDisposer(scope, name) {
  let found = false;
  const disposesName = (node) => {
    let hit = false;
    const scan = (n) => {
      if (hit) return;
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'dispose' &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === name
      ) {
        hit = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(node);
    return hit;
  };
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments) {
        if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && disposesName(arg)) {
          found = true;
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/**
 * Does `name` escape the scope that constructed it?
 *
 * A processor that is returned, or stored on an object/field, is owned by
 * whoever receives it — `packages/cli/src/commands/export.ts` returns
 * `{ bytes, gp }`, and `demesh-session.ts` assigns `this.gp` so `destroy()`
 * can free it. Neither is a leak, and neither is decidable from the
 * constructing scope alone.
 *
 * This gate deliberately proves a narrow thing: a processor that stays local
 * and is never freed. Flagging escapes as well would produce exactly the
 * false positives that get a check disabled — and issue #1959's own audit
 * lists both of the above under "correct, for the record".
 */
function escapesScope(scope, name) {
  let escapes = false;
  /**
   * Is `target` declared inside this same scope? If so, assigning to it is a
   * local alias with the same lifetime, not an escape — `let alias; alias = p;`
   * keeps the handle exactly as local as it was, and accepting it would let a
   * leak through (greptile, #2129 review). Only assignment to a binding from an
   * OUTER scope — a module-level cache like `clash.ts`'s `sharedProcessor` —
   * actually moves ownership.
   */
  const declaredLocally = (target) => {
    let found = false;
    const scan = (n, depth = 0) => {
      if (found) return;
      // Do NOT descend into nested function scopes. A callback parameter that
      // happens to share the name — `[1].forEach((sharedProcessor) => …)` —
      // is a different binding, and treating it as a local declaration marks a
      // genuine module-level ownership transfer as a leak. That is a FALSE
      // POSITIVE, the direction that gets a gate switched off, so it matters
      // more than the over-acceptance cases this function also guards
      // (CodeRabbit, #2129 review).
      if (
        depth > 0 &&
        (ts.isFunctionDeclaration(n) ||
          ts.isFunctionExpression(n) ||
          ts.isArrowFunction(n) ||
          ts.isMethodDeclaration(n))
      ) {
        return;
      }
      // VariableDeclaration covers `let alias`; ParameterDeclaration covers
      // `function f(alias)`; BindingElement covers a destructured parameter or
      // declaration. A parameter is every bit as local as a `let` — checking
      // only VariableDeclaration let `function f(alias) { const p = new
      // GeometryProcessor(); alias = p; }` through as "ownership transfer",
      // accepting an undisposed handle.
      if (
        (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
        ts.isIdentifier(n.name) &&
        n.name.text === target
      ) {
        found = true;
      }
      ts.forEachChild(n, (c) => scan(c, depth + 1));
    };
    // Parameters hang off the function node itself, not its body, so scan the
    // whole scope node rather than descending into the body first.
    scan(scope, 0);
    return found;
  };
  const mentionsName = (node) => {
    let hit = false;
    const scan = (n) => {
      if (hit) return;
      if (ts.isIdentifier(n) && n.text === name) hit = true;
      ts.forEachChild(n, scan);
    };
    scan(node);
    return hit;
  };
  const visit = (node) => {
    if (escapes) return;
    if (ts.isReturnStatement(node) && node.expression && mentionsName(node.expression)) {
      escapes = true;
    }
    // this.gp = gp  |  obj.field = gp  |  sharedProcessor = gp
    //
    // The last form is a module-level cache (`packages/cli/src/commands/clash.ts`
    // keeps one processor for the CLI process). Assigning to any binding other
    // than itself moves ownership out of this scope.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.right) &&
      node.right.text === name &&
      (ts.isPropertyAccessExpression(node.left) ||
        (ts.isIdentifier(node.left) &&
          node.left.text !== name &&
          !declaredLocally(node.left.text)))
    ) {
      escapes = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return escapes;
}

/** The construction is the entire body of a function -> the caller owns it. */
function isFactoryBody(newExpr) {
  const p = newExpr.parent;
  if (!p) return false;
  if (ts.isArrowFunction(p) && p.body === newExpr) return true;
  if (ts.isReturnStatement(p)) {
    const fn = enclosingFunction(p);
    // A bare `return new GeometryProcessor()` hands ownership out.
    return fn !== null && !ts.isSourceFile(fn);
  }
  return false;
}

const violations = [];
const accepted = { using: 0, finally: 0, factory: 0, allowlisted: 0, escapes: 0, disposer: 0 };
let scanned = 0;
let walked = 0;

for (const scanDir of SCAN_DIRS) {
  const sources = findSourceFiles(join(ROOT, scanDir));
  walked += sources.length;
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    if (![...DISPOSABLE_CLASSES].some((c) => text.includes(`new ${c}`))) continue;
    scanned++;
    const rel = relative(ROOT, file);
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

    const visit = (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        DISPOSABLE_CLASSES.has(node.expression.text)
      ) {
        const line = src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const decl = ts.isVariableDeclaration(node.parent) ? node.parent : null;
        const name = decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
        const key = name ? `${rel}:${name}` : null;

        const scope = enclosingFunction(node) ?? src;
        if (isFactoryBody(node)) accepted.factory++;
        else if (decl && isUsingBinding(decl)) accepted.using++;
        else if (key && ALLOWLIST.has(key)) accepted.allowlisted++;
        else if (name && disposedInFinally(scope, name)) accepted.finally++;
        else if (name && handedToDisposer(scope, name)) accepted.disposer++;
        else if (name && escapesScope(scope, name)) accepted.escapes++;
        else {
          violations.push({
            file: rel,
            line,
            name: name ?? '<unbound>',
            cls: node.expression.text,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
}

const total =
  violations.length + accepted.using + accepted.finally + accepted.factory + accepted.allowlisted + accepted.escapes + accepted.disposer;

// Anti-vacuity, checked BEFORE the violation report so a broken scan can never
// be reported as either a pass or a (differently wrong) small failure. Two
// independent floors, because this gate has two ways to go blind and each one
// leaves the other's number looking healthy: the WALK can stop finding source
// files, or the walk can succeed while the AST detector stops recognising
// constructions.
if (walked < SOURCE_FLOOR) {
  console.error(
    `\n\u274c check-wasm-disposal: only ${walked} source file(s) walked under ${SCAN_DIRS.join(', ')}, floor is ${SOURCE_FLOOR}.\n` +
      `Refusing a vacuous pass: the file walk found almost nothing, so this gate has proved nothing about\n` +
      `WASM-handle disposal. Check the scan roots and the working directory before touching SOURCE_FLOOR.\n`,
  );
  process.exit(1);
}
if (total < CONSTRUCTION_FLOOR) {
  console.error(
    `\n\u274c check-wasm-disposal: only ${total} \`new ${[...DISPOSABLE_CLASSES].join('`/`new ')}\` construction(s) found, floor is ${CONSTRUCTION_FLOOR}.\n` +
      `Refusing a vacuous pass: the walk saw ${walked} file(s), so the files are there and it is the detector\n` +
      `that stopped matching. If the constructions were genuinely removed, lower CONSTRUCTION_FLOOR in the\n` +
      `same commit — that keeps "this PR reduced the gate's reach" a reviewable line in the diff.\n`,
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `❌ ${violations.length} WASM-handle construction(s) with no deterministic release:\n`,
  );
  for (const v of violations) {
    console.error(`   ${v.file}:${v.line}  new ${v.cls}()  -> \`${v.name}\` is never freed`);
  }
  console.error(`
Every \`new GeometryProcessor(...)\` must free its WASM handle on ALL paths.
Cheapest fix (GeometryProcessor implements [Symbol.dispose], #1563):

    using processor = new GeometryProcessor(...);

or, where the lifetime is not lexical:

    const processor = new GeometryProcessor(...);
    try { ... } finally { processor.dispose(); }

If a site legitimately outlives its scope (a page-lifetime singleton), add it to
ALLOWLIST in scripts/check-wasm-disposal.mjs with the reason. See issue #1959.`);
  process.exit(1);
}

console.log(
  `✅ All ${total} WASM-handle construction(s) release deterministically ` +
    `(${accepted.using} using, ${accepted.finally} try/finally, ${accepted.factory} factory, ` +
    `${accepted.disposer} disposer-owned, ${accepted.escapes} ownership-transferred, ${accepted.allowlisted} allowlisted) ` +
    `across ${scanned} file(s) with a construction, out of ${walked} source file(s) walked.`,
);
