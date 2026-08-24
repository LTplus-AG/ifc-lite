/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detection half of scripts/check-source-text-assertions.mjs (#2434), split out
 * so it can be unit-tested against hand-written sources instead of only against
 * whatever the repo happens to contain today.
 *
 * THE RULE, as the gate's docblock has always stated it: a test that reads
 * `Thing.tsx` and then asserts on THAT STRING. The original detector checked
 * the two halves independently — "this file reads a file somewhere" AND "this
 * file applies a text predicate somewhere" — and never checked they were
 * connected. That is a proxy, and it broke exactly the way proxies break:
 * `packages/data/scripts/generate-ifc-schema.test.ts` reads upstream fixtures
 * only to copy them into a temp dir, runs the real generator as a child
 * process, and asserts solely on `r.stdout` / `r.stderr` — pure behaviour — yet
 * was reported as a source-text assertion.
 *
 * The obvious repair, excluding `.stdout`/`.stderr` receivers, was considered
 * and REJECTED: a file may legitimately assert on file text in one place and
 * wrap a subprocess result in another, and an exclusion keyed on the second
 * would blind the gate to the first with nothing recording the decision.
 *
 * So this module pairs them. A predicate counts only when it is applied to a
 * value that a file read produced. Taint starts at `readFileSync`/`readFile`
 * and propagates through the shapes that actually occur here:
 *
 *   const source = readFileSync(p, 'utf8')          // direct binding
 *   const src = readSource('Thing.tsx')             // read behind a helper
 *   const real = Object.fromEntries(… readFileSync) // read inside a callback
 *   let s = readFileSync(p); s = s.replace(a, b)    // reassignment
 *   mutate(real.platform, …) → function mutate(source, …)  // through a parameter
 *
 * Propagation is deliberately over-eager (one flat name set, no scoping, every
 * call site of a function taints that function's parameters). Over-tainting
 * makes the gate stricter, which is the safe direction for a ratchet;
 * under-tainting would silently drop coverage, which is the direction that
 * turns a gate into decoration.
 *
 * ═══ WHY THIS PARSES INSTEAD OF SCANNING (#3174) ═══
 *
 * Until #3174 this module hand-rolled a lexer for JS, TS and TSX, and its own
 * docblock said the central heuristic was "APPROXIMATE, not sound". Its history
 * was a string of fail-opens that each looked like a small fix: a quote inside
 * a regex literal blanking the rest of the file, a `//` inside a string doing
 * the same, `)` before `/` read as division when it closed an `if` header, a
 * `$` defeating a `\b`. Each was found by someone reading the file, not by the
 * gate, because every one of them made the gate go QUIET.
 *
 * Two more were open when the rewrite landed, and neither could be closed by
 * another pattern:
 *
 *   - A COMMENT INSIDE A WRAPPED ASSERTION killed the marker. `markerLineFor`
 *     walked up over lines a `CONTINUES` regex accepted; an interior comment
 *     strips to blank, which is not a continuation, so the walk stopped and the
 *     marker above the assertion never reached the predicate. The gate then
 *     failed twice — "source-text assertion found" AND "marker that excuses
 *     nothing" — and the remedy it prints in its own error text did not clear
 *     it. Making blank lines transparent was measured and REJECTED: it lets a
 *     marker reach across blank lines to an unrelated predicate, turning a loud
 *     dead marker into a silent exemption. The marker's reach is "the enclosing
 *     statement", which is a range in the tree, not a run of lines that look
 *     unfinished.
 *
 *   - A DEFAULT PARAMETER CONTAINING A CALL hid the callback's parameter.
 *     Callback parameter lists were captured with `[^()]*`, which cannot cross
 *     the nested parens of `(line = pad(1)) =>`, so the parameter was never
 *     tainted and the whole callback body read as clean.
 *
 * Both are the same sentence: the regex cannot see structure the parser has for
 * free. So the scanning layer is gone — `blankStrings`, `stripComments`,
 * `regexLiteralEnd`, `closesAControlHeader`, `CONTINUES`, `markerLineFor`,
 * `statementEnd`, `matchParen`, `receiverStart`, `splitArgs` — and with it every
 * fail-open those functions were patched for. `ts.createSourceFile` decides
 * regex-versus-division, string and template boundaries, comment extents and
 * statement ranges, and it is `createSourceFile` specifically: `ts.createScanner`
 * alone never calls `reScanSlashToken`, so it gets the same class of question
 * wrong that the hand-rolled `regexLiteralEnd` did.
 *
 * Cost, measured on this machine over the 1430 test files the gate walks, three
 * runs each: 0.82s end to end while scanning, 1.51s parsing. Both under two
 * seconds, on a CI job that runs the entire node test suite.
 *
 * VERDICTS CHANGED on the corpus, and only these two — the diff was run file by
 * file, old detector against new, comparing hit, marked and dead-marker lines:
 *
 *   - `packages/data/scripts/generate-ifc-schema.test.ts:164` was flagged and is
 *     not. `expect(r.stderr).toContain(message)` asserts on SUBPROCESS OUTPUT,
 *     which is the exact false positive the pairing rule was built to stop, and
 *     this file is the one named in the paragraph above for it. The scanner read
 *     parameter names out of the raw text between the parens, so
 *     `rename(file: string, from: RegExp, to: string)` registered `string` and
 *     `RegExp` as parameters — both were really in that file's taint set on
 *     `main` — and the index shift they caused walked taint into `message`, a
 *     table field holding a literal error string. `fn.parameters` has no such
 *     slots. The file's two real hits, on a callback parameter that does receive
 *     file contents, are unchanged.
 *
 *   - `apps/viewer/src/components/viewer/toolbar/export-ui-parity.test.tsx`
 *     gained four hits (575, 581, 585, 590). They are genuine: `hookSource`
 *     comes from `readSource('…/useExportCommands.ts')`, `successToasts` from
 *     its `matchAll`, and the four predicates run on elements found in it. The
 *     file is already allowlisted, so the gate's verdict is unchanged.
 *
 * Both directions are pinned in `check-source-text-assertions.test.mjs`, so
 * neither is held together by this paragraph alone.
 *
 * WHAT DID NOT CHANGE is the taint analysis: still one flat name set, no
 * scoping, deliberately over-eager. It is the same rules against a tree instead
 * of against string slices, and `analyze`'s return shape is identical.
 *
 * STILL OPEN, deliberately: `for (const line of lines)` where the split was
 * bound to a name first. Widening the for-of rule to "any iterable carrying
 * file bytes" also taints `for (const file of files)` where the elements are
 * PATHS — measured as 4 new hits in `toolbar-parity.test.ts`. That is a
 * question about what an array HOLDS, which a parser cannot answer either, so
 * parsing does not close it and the rule still takes only the `.split(` it can
 * prove.
 *
 * WHAT COUNTS AS THE PREDICATE'S SUBJECT is both the receiver chain and the
 * arguments, because both spellings occur: `source.includes(x)` and
 * `assert.match(source, /x/)` and `new RegExp(x).exec(source)` are the same
 * assertion. `expect(source).toContain(x)` needs no special case — `expect(…)`
 * is the receiver, so `source` is found by reading it.
 *
 * THE ANCHOR-GUARD ESCAPE HATCH. `assert.ok(source.includes(from), 'mutation
 * anchor not found')` before a `source.replace(from, to)` is, by this rule, a
 * source-text assertion — and by value the opposite of one: it exists so a
 * mutation that silently fails to apply is caught instead of testing nothing.
 * It is NOT structurally carved out. "A predicate immediately preceding a
 * mutation" is another proxy, unreviewable and silent, and this file exists
 * because of what proxies cost. Instead the site marks itself:
 *
 *     // @source-text-assertion-ok mutation anchor guard, not a subject assertion
 *     assert.ok(source.includes(from), `anchor not found: ${from}`);
 *
 * The marker suppresses the predicate on its own line, or anywhere from one
 * line above the ENCLOSING STATEMENT down to the predicate. That range comes
 * from the tree, so a wrapped assertion — with or without comments inside it —
 * is one statement and the marker the gate tells you to write is the marker it
 * accepts. The decision stays a grep-able line in the diff, which a structural
 * carve-out never would be.
 */

import ts from 'typescript';

/**
 * The taint source: a disk read, however the call is qualified. This used to be
 * a regex matched against a blanked view of the text, which is why it had to
 * also decide `fs.readFileSync` and `await fsp.readFile` for itself. The tree
 * answers that, so the two NAMES are the whole rule.
 */
const READ_NAMES = new Set(['readFileSync', 'readFile']);

/**
 * Names a SOURCE file as a literal. Fixture formats (.ifc, .json, .csv, …) are
 * deliberately absent: reading a fixture and asserting on it is a normal test.
 *
 * Applied to string and template-literal CONTENT from the tree, so a `.ts`
 * filename that appears only in prose cannot satisfy it. That used to need a
 * comment-stripping pass, and it was load-bearing rather than tidy: three
 * unrelated tests mention a `.ts` filename in a comment while reading a wasm
 * binary or a JSON manifest, and matching those flagged all three.
 */
const SOURCE_LITERAL = /^[^'"`\n]*\.(ts|tsx|mts|rs|css|scss)$/;

/**
 * Text predicates. `test` and `exec` are here because this repo already writes
 * them that way — `/re/.test(source)` in export-ui-parity.test.tsx and
 * `new RegExp(…).exec(src)` in prepass-class-spans.test.ts, the latter a form
 * the guard was blind to until #2434. Under the pairing rule they need no
 * receiver-name allowlist: the receiver of `/re/.test(x)` is a regex and never
 * tainted, so what decides the case is whether `x` came from a file.
 */
const PREDICATE_METHODS = new Set([
  'includes', 'indexOf', 'match', 'search', 'startsWith', 'endsWith',
  'exec', 'test', 'toContain', 'toMatch',
]);

/** `@source-text-assertion-ok <reason>` — see the docblock. */
const MARKER = /@source-text-assertion-ok\b[ \t]*(\S[^\n]*)?/;

/** Depth-first over every node in the tree. */
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Strip the wrappers that change how an expression is SPELLED and not what it
 * IS: parentheses, `as`, `satisfies`, `!`, and the angle-bracket assertion.
 *
 * Needed wherever a node is inspected STRUCTURALLY — "is this argument a
 * function?", "is it an identifier naming one?". A subtree walk does not care,
 * because it descends through the wrapper anyway; a `ts.isFunctionLike` check
 * on the wrapper answers no and taints nothing.
 *
 * Deliberately NOT applied to a call's CALLEE. `(fn)(source)` must stay in the
 * fail-closed branch, which is where the scanning version put it and where an
 * undecidable callee belongs.
 *
 * Every predicate is called DIRECTLY, with no `?.` guard. The first version
 * wrote `ts.isSatisfiesExpression?.(n) ?? false` out of caution about the API
 * surface, which is a fail-open dressed as defensiveness: a renamed or missing
 * predicate would answer "not a wrapper" and silently stop unwrapping, instead
 * of throwing where someone would see it. `typescript@^6.0.3` exports all five
 * (checked), and if a future version does not, this should break loudly.
 * Reported by CodeRabbit on #3177.
 */
function unwrap(node) {
  let n = node;
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n))
  )
    n = n.expression;
  return n;
}

/**
 * The expressions a callback slot can actually evaluate to, looking through the
 * operators that SELECT between callbacks without being one: `?:`, `&&`, `||`,
 * `??`, the comma operator, and a spread.
 *
 * Only used to resolve a callback passed BY NAME. Function expressions are
 * found by walking the argument instead, which needs no enumeration.
 */
function callbackCandidates(node, out = []) {
  const n = unwrap(node);
  if (!n) return out;
  if (ts.isConditionalExpression(n)) {
    callbackCandidates(n.whenTrue, out);
    callbackCandidates(n.whenFalse, out);
    return out;
  }
  const SELECTORS = new Set([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.CommaToken,
  ]);
  if (ts.isBinaryExpression(n) && SELECTORS.has(n.operatorToken.kind)) {
    callbackCandidates(n.left, out);
    callbackCandidates(n.right, out);
    return out;
  }
  if (ts.isSpreadElement(n)) return callbackCandidates(n.expression, out);
  out.push(n);
  return out;
}

/**
 * The name a callee resolves to, for `f(…)`, `fs.readFileSync(…)` and
 * `a.b.c(…)` alike — the rightmost identifier, which is the one that says what
 * is being called. `null` when the callee is anything else, which is the
 * fail-closed case below.
 */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return null;
}

/** TRUE when the subtree PERFORMS a read, however the call is qualified. */
function performsRead(node) {
  let found = false;
  walk(node, (n) => {
    if (found || !ts.isCallExpression(n)) return;
    const name = calleeName(n.expression);
    if (name && READ_NAMES.has(name)) found = true;
  });
  return found;
}

/**
 * Identifiers in `node` at VALUE position — property names after `.` excluded,
 * so `fs.readFileSync` contributes `fs` and not `readFileSync`, and `a.source`
 * does not contribute `source`.
 *
 * The scanning version did this with a regex that dropped any name preceded by
 * a dot, which cost it two silent bugs around `$` (not a word character, so a
 * leading `\b` never matched). The tree says which identifiers are property
 * names, so neither case can come back.
 */
function valueIdentifiers(node) {
  const names = new Set();
  walk(node, (n) => {
    if (!ts.isIdentifier(n)) return;
    const parent = n.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === n) return;
    if (parent && ts.isQualifiedName(parent) && parent.right === n) return;
    if (parent && ts.isPropertyAssignment(parent) && parent.name === n) return;
    if (parent && ts.isBindingElement(parent) && parent.propertyName === n) return;
    names.add(n.text);
  });
  return names;
}

/** Every identifier a binding name binds, destructuring patterns included. */
function boundNames(name) {
  const out = [];
  if (ts.isIdentifier(name)) return [name.text];
  walk(name, (n) => {
    if (!ts.isBindingElement(n)) return;
    if (ts.isIdentifier(n.name)) out.push(n.name.text);
  });
  return out;
}

/** Every name a function's parameter list binds, as one array per parameter. */
function parameterNames(fn) {
  return fn.parameters.map((p) => boundNames(p.name));
}

/**
 * The name a function-like is KNOWN BY at its declaration: its own name, or the
 * variable it is assigned to. Anonymous callbacks have none, and taint reaches
 * their parameters through the receiver rule instead.
 */
function functionName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  // Up THROUGH the wrappers: in `const f = ((x) => …)` the arrow's parent is
  // the parenthesis, not the declaration, so the helper had no name and its
  // call sites tainted nothing.
  let parent = fn.parent;
  while (parent && unwrap(parent) !== parent) parent = parent.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  )
    return parent.left.text;
  return null;
}

/** The expressions a function-like can return, concise arrow bodies included. */
function returnedExpressions(fn) {
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  if (!fn.body) return out;
  walk(fn.body, (n) => {
    // A nested function's `return` belongs to that function, not this one.
    if (ts.isReturnStatement(n) && n.expression && enclosingFunction(n) === fn) out.push(n.expression);
  });
  return out;
}

/** The nearest function-like ancestor of `node`, or `null` at top level. */
function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
  return null;
}

/** The nearest Statement ancestor of `node` — the marker's reach (#3174). */
function enclosingStatement(node) {
  for (let n = node; n; n = n.parent) if (ts.isStatement(n)) return n;
  return node;
}

/**
 * Every name that can hold, or return, bytes that came off the disk.
 *
 * One flat set, no scoping, deliberately over-eager — unchanged in shape from
 * the scanning version, because none of its rules were about syntax the regexes
 * got wrong. What changed is where each rule reads its input: a parameter list
 * comes from `fn.parameters` rather than from `[^()]*`, an argument list from
 * `call.arguments` rather than from a comma splitter, a receiver from
 * `callee.expression` rather than from a backwards walk over balanced brackets.
 */
function computeTainted(sourceFile) {
  const tainted = new Set(READ_NAMES);

  const bindings = [];      // { names: string[], init: Node }
  const functions = [];     // { node, name, params: string[][] }
  const calls = [];         // CallExpression
  const forOfs = [];        // ForOfStatement
  const identifierCount = new Set();

  walk(sourceFile, (n) => {
    if (ts.isIdentifier(n)) identifierCount.add(n.text);
    if (ts.isVariableDeclaration(n) && n.initializer)
      bindings.push({ names: boundNames(n.name), init: n.initializer });
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isIdentifier(n.left) || ts.isObjectLiteralExpression(n.left) || ts.isArrayLiteralExpression(n.left))
    )
      bindings.push({ names: [...valueIdentifiers(n.left)], init: n.right });
    // `isFunctionLike` also matches TYPE-level nodes — the `(text: string) =>
    // string` inside a parameter annotation. Their names bind nothing at
    // runtime, so registering them can only ADD names to the set, and this
    // analysis is deliberately over-eager: over-tainting makes the gate
    // stricter, and narrowing it is the direction that goes quiet.
    if (ts.isFunctionLike(n) && n.parameters)
      functions.push({ node: n, name: functionName(n), params: parameterNames(n) });
    if (ts.isCallExpression(n)) calls.push(n);
    if (ts.isForOfStatement(n)) forOfs.push(n);
  });

  // Keyed by name, and a LIST per name: two helpers can share one (a shadowed
  // inner `read`, a method and a free function). Keeping only the last would
  // drop the other's parameters from taint, which is the silent direction.
  const byName = new Map();
  for (const fn of functions) {
    if (!fn.name) continue;
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }

  /**
   * TRUE when `node` yields bytes off the disk — either because it PERFORMS a
   * read, or because it refers to a name already known to hold one. The two
   * arms are why this is not called `refersToTainted`: the first answers a
   * question about the expression itself, not about the `tainted` set.
   */
  const carriesFileBytes = (node) => {
    if (!node) return false;
    if (performsRead(node)) return true;
    for (const name of valueIdentifiers(node)) if (tainted.has(name)) return true;
    return false;
  };

  const taintAll = (namesPerParam) => {
    for (const names of namesPerParam) for (const n of names) tainted.add(n);
  };

  // Every name this loop can add is an identifier that appears in the file, and
  // every productive pass adds at least one, so the count of distinct
  // identifiers bounds the passes. A fixed cap was reachable — bindings
  // declared in reverse order resolve one link per pass — and a
  // `bindings.length + functions.length` cap was worse, because neither term
  // counts for-of names or callback parameters.
  const maxPasses = identifierCount.size + 2;
  for (let pass = 0; pass < maxPasses; pass++) {
    const before = tainted.size;

    for (const b of bindings) if (carriesFileBytes(b.init)) for (const n of b.names) tainted.add(n);

    // A helper that RETURNS file bytes taints its own name, so both
    // `readSource(f).includes(x)` and `const s = readSource(f)` are seen.
    for (const fn of functions) {
      if (!fn.name || tainted.has(fn.name)) continue;
      if (returnedExpressions(fn.node).some(carriesFileBytes)) tainted.add(fn.name);
    }

    for (const call of calls) {
      const args = call.arguments;

      // FAIL CLOSED on flow this analysis cannot follow. When file bytes are
      // handed to a callee it cannot name — `mutators[key](real[key])`, or
      // anything returned by a call — the value lands in a parameter no lexical
      // rule can identify, and the honest answer is "undecidable", not "clean".
      // Undecidable resolves to tainting every parameter in the file, so
      // coverage degrades toward MORE flagging rather than less. Named callees
      // and plain dotted ones are followed or ignored precisely and never reach
      // here. An optional call is still a call: `check?.(source)` is the same
      // shape and used to slip past on two characters.
      if (calleeName(call.expression) === null && args.some(carriesFileBytes)) {
        for (const fn of functions) taintAll(fn.params);
        continue;
      }

      // A tainted argument taints the parameter it lands in.
      const named = byName.get(calleeName(call.expression));
      if (named)
        for (const fn of named)
          args.forEach((arg, idx) => {
            if (idx < fn.params.length && carriesFileBytes(arg))
              for (const n of fn.params[idx]) tainted.add(n);
          });

      // An ITERATION CALLBACK receives the bytes one ELEMENT at a time, so no
      // tainted NAME ever appears inside it. `source.split('\n').some((line) =>
      // line.includes(needle))` reads the file and asserts on its text, and the
      // detector saw a predicate applied to `line`, a parameter it believed was
      // clean. Taint flows from the RECEIVER to the callback's parameters — for
      // `.filter`, `.map`, `.every`, `.forEach`, `.find` and every other method,
      // since nothing here needs to know which one it is.
      //
      // The parameters come from `fn.parameters`, which is what closes gap 3 of
      // #3174: the regex captured a parameter list with `[^()]*` and could not
      // cross the nested parens of `(line = pad(1)) =>`, so that callback's
      // body read as clean in both the arrow and the `function` spelling.
      if (!ts.isPropertyAccessExpression(call.expression)) continue;
      if (!carriesFileBytes(call.expression.expression)) continue;
      for (const rawArg of args) {
        // ANYWHERE inside the argument, not just at its root. The scanning
        // version matched arrows and `function` expressions wherever they sat
        // in the argument TEXT, so testing only the root node was a REGRESSION
        // into the one direction this gate must never move -- measured against
        // main on `((line) => …)`, `… as any`, `… satisfies unknown`,
        // `(function (line) {…})`, `flag ? (line) => … : other`,
        // `cb || ((line) => …)`, `(noop(), (line) => …)`,
        // `...[(line) => …]` and `wrapCb((line) => …)`, all of which main
        // flagged and the root-only test did not. Reported by Codex on #3177.
        walk(rawArg, (n) => {
          if (ts.isFunctionLike(n) && n.parameters) taintAll(parameterNames(n));
        });
        // A HOISTED callback is passed by name, so its parameters are declared
        // somewhere else entirely: `.some(hit)` with `const hit = (line) => …`.
        // Resolved through the operators that SELECT a callback, so
        // `.some(flag ? hit : other)` reaches `hit` -- a hole main had too.
        for (const candidate of callbackCandidates(rawArg))
          if (ts.isIdentifier(candidate))
            for (const fn of byName.get(candidate.text) ?? []) taintAll(fn.params);
      }
    }

    // `for (const line of source.split('\n'))` binds the ELEMENT, and no
    // assignment appears, so a binding rule cannot see it.
    //
    // Deliberately narrow to a SPLIT of tainted text. Tainting on
    // `carriesFileBytes` alone also catches `for (const file of files)` where
    // the elements are PATHS, not contents — measured as 4 false hits in
    // toolbar-parity.test.ts, because a list of paths is tainted too. Nothing
    // in the SYNTAX separates a tainted array of lines from a tainted array of
    // filenames, which is why parsing does not close this and the rule still
    // takes only the `.split(` it can prove. `for (const line of lines)` with
    // the split bound to a name first stays uncovered, on purpose (#3174).
    for (const loop of forOfs) {
      const iterable = loop.expression;
      let splits = false;
      walk(iterable, (n) => {
        if (ts.isCallExpression(n) && calleeName(n.expression) === 'split') splits = true;
      });
      if (!splits || !carriesFileBytes(iterable)) continue;
      if (ts.isVariableDeclarationList(loop.initializer))
        for (const d of loop.initializer.declarations) for (const n of boundNames(d.name)) tainted.add(n);
    }

    if (tainted.size === before) break;
  }
  return tainted;
}

/**
 * `@source-text-assertion-ok` markers, by the line the marker text sits on.
 *
 * Read from COMMENTS only, never from raw lines: a raw-line scan accepted
 * `const doc = 'write @source-text-assertion-ok fake';` as a genuine marker, so
 * a STRING could excuse a real finding — a silent fail-open in the direction
 * this gate exists to prevent.
 *
 * Every comment is trivia of some token, so walking the token tree reaches all
 * of them, `}` and the end-of-file token included. BOTH sides are needed, not
 * just leading: TypeScript attaches a comment that follows code on the SAME
 * line to the preceding token as TRAILING trivia, so a marker written
 * `assert.ok(…); // @source-text-assertion-ok why` is not leading trivia of
 * anything — reading only leading ranges lost every same-line marker, which is
 * a documented spelling of the escape hatch.
 *
 * This is the whole reason `stripComments` is gone: the parser already knows
 * which `//` is a comment and which is inside a string or a regex literal, and
 * getting that wrong is what once blanked a whole file and left the gate quiet.
 */
function markersByLine(sourceFile, text) {
  const markers = new Map();
  const seen = new Set();
  const record = (range) => {
    if (seen.has(range.pos)) return;
    seen.add(range.pos);
    const body = text.slice(range.pos, range.end);
    const m = MARKER.exec(body);
    if (!m) return;
    const line = sourceFile.getLineAndCharacterOfPosition(range.pos + m.index).line + 1;
    markers.set(line, (m[1] || '').trim());
  };
  const visitToken = (node) => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) record(r);
      for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) record(r);
      return;
    }
    for (const child of children) visitToken(child);
  };
  visitToken(sourceFile);
  return markers;
}

/** TRUE when any string or template literal in the tree names a source file. */
function namesASourceFile(sourceFile) {
  let found = false;
  walk(sourceFile, (n) => {
    if (found) return;
    if (ts.isStringLiteralLike(n)) {
      if (SOURCE_LITERAL.test(n.text)) found = true;
      return;
    }
    // A template with substitutions has no single `.text`; each literal span is
    // its own chance to end in an extension (`` `${dir}/Thing.tsx` ``).
    if (ts.isTemplateExpression(n)) {
      if (SOURCE_LITERAL.test(n.head.text)) found = true;
      for (const span of n.templateSpans) if (SOURCE_LITERAL.test(span.literal.text)) found = true;
    }
  });
  return found;
}

/**
 * @param {string} original Raw file text (comments intact — markers live there).
 * @param {string} [fileName] Used only to pick the TS-vs-TSX grammar.
 * @returns {{ flagged: boolean, hits: Array<{line: number, text: string}>,
 *             marked: Array<{line: number, reason: string}>,
 *             unusedMarkers: number[] }}
 */
export function analyze(original, fileName = 'source.tsx') {
  // `createSourceFile`, NOT `createScanner`. TypeScript resolves regex versus
  // division in the PARSER, by calling `reScanSlashToken` when the grammar says
  // a regex is allowed; the scanner on its own never makes that call and gets
  // the same class of question wrong that the hand-rolled lexer did.
  const sourceFile = ts.createSourceFile(
    fileName,
    original,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const markers = markersByLine(sourceFile, original);
  const rawLines = original.split('\n');
  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  // `performsRead` over the whole file is the same question as "does this
  // file read anything at all", so it is the same function.
  if (!performsRead(sourceFile) || !namesASourceFile(sourceFile)) {
    return { flagged: false, hits: [], marked: [], unusedMarkers: [...markers.keys()] };
  }

  const tainted = computeTainted(sourceFile);
  const hits = [];
  const marked = [];
  const usedMarkers = new Set();

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return;
    if (!PREDICATE_METHODS.has(callee.name.text)) return;

    // The subject is the receiver AND the arguments, because both spellings
    // occur: `source.includes(x)` and `assert.match(source, /x/)`.
    const subject = [callee.expression, ...node.arguments];
    if (!subject.some((s) => [...valueIdentifiers(s)].some((n) => tainted.has(n)))) return;

    const line = lineOf(callee.name.getStart(sourceFile));

    // A marker excuses the predicate on its own line, or on any line from one
    // above the ENCLOSING STATEMENT down to the predicate.
    //
    // The scanning version walked up over lines a regex called continuations,
    // and a COMMENT INSIDE the assertion stopped the walk dead — so the marker
    // the gate prints as the remedy did not reach the predicate, and was then
    // reported as excusing nothing. CI failed twice and the printed fix did not
    // work. The statement's own range has no such hole, and unlike "treat blank
    // lines as continuations" it cannot reach across a gap to an unrelated
    // predicate: a different statement is a different range.
    const first = lineOf(enclosingStatement(node).getStart(sourceFile));
    let markerLine = null;
    for (let candidate = line; candidate >= first - 1; candidate--)
      if (markers.has(candidate)) { markerLine = candidate; break; }

    if (markerLine !== null && markers.get(markerLine)) {
      usedMarkers.add(markerLine);
      marked.push({ line, reason: markers.get(markerLine) });
      return;
    }
    hits.push({ line, text: rawLines[line - 1]?.trim() ?? '' });
  });

  hits.sort((a, b) => a.line - b.line);
  marked.sort((a, b) => a.line - b.line);

  return {
    flagged: hits.length > 0,
    hits,
    marked,
    unusedMarkers: [...markers.keys()].filter((l) => !usedMarkers.has(l)).sort((a, b) => a - b),
  };
}
