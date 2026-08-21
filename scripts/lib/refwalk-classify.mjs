/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure classification step for the refwalk gate (issue #2944). The gate that
 * consumes it is `scripts/check-refwalk-guards.mjs`, whose header carries the
 * measured coverage and the LIMITATIONS block; nothing here decides pass or
 * fail. Given the text of ONE Rust source file, decides which of its
 * functions are "reference-following recursive walks" that call
 * `decode_by_id` / `resolve_ref` / `resolve_ref_list`, as opposed to
 * ordinary bounded iteration over a fixed list that happens to call the
 * same decode functions.
 *
 * The distinguishing signal used here is NOT "is there a loop" (the naive
 * shape from issue #2944's Option 1, which flags every `for` loop around a
 * decode call — including bounded ones) but "is the enclosing function part
 * of a local call cycle" — i.e. self-recursion or mutual recursion among
 * functions defined in the same file. A `for edge in edges { decode_by_id
 * (edge) }` loop over a list bound before the loop never calls itself, so it
 * is not part of any cycle in the local call graph and is not flagged. A
 * walk that re-enters itself (directly, or via a sibling `_inner`/`_guarded`
 * helper) to chase an attribute reference IS part of a cycle, and is
 * flagged regardless of whether it happens to also contain a `for`.
 *
 * This is a purely lexical, single-file, name-based approximation — it does
 * not resolve types, does not follow calls across files, and can be fooled
 * by shadowing or by a same-named function in an unrelated impl block. Read
 * `scripts/check-refwalk-guards.mjs`'s LIMITATIONS block before assuming any
 * coverage from it -- in particular it cannot see a recursion cycle that
 * spans two files, which is why #2870's Boolean <-> CSG cycle is missed.
 *
 * The gate calls `extractFunctions` and `findWalkCandidates` only.
 * `classifyFile`, `findRecursiveFunctions` and `findChaseLoopFunctions` are
 * the measurement API the feasibility study was built on, kept because their
 * tests are what pin the shared internals (`callSitePresent`'s cross-struct
 * name-collision rule, `chaseLoopBodyMatches`' fixed point) that
 * `findWalkCandidates` sits on top of. Editing one of them does not change
 * what CI enforces.
 */

const DECODE_CALL_RE = /\b(decode_by_id|resolve_ref_list|resolve_ref)\s*\(/;

// A plain (non-`let`) reassignment `IDENT = <rhs up to first top-level ';'>`.
// The `(let\s+(?:mut\s+)?)?` capture lets us tell apart a fresh per-iteration
// binding (`let x = ...`, ordinary bounded iteration) from a mutation of a
// cursor variable declared BEFORE the loop (`x = ...`, the chase-loop shape)
// -- the same distinction as `for edge_ref in edges { let oriented_edge =
// decoder.decode_by_id(...); }` (bounded, edge_loop.rs) vs `current =
// decoder.resolve_ref(...);` (chase, probe.rs).
const REASSIGN_RE = /(let\s+(?:mut\s+)?)?\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?);/g;

// Heuristics for "this loop is guarded" reporting only -- NOT part of the
// flag/no-flag decision (see chaseLoopFunctions' docstring for why guarded
// chase loops are still flagged, same policy as findRecursiveFunctions).
const GUARD_RE = /\bvisited\b[\s\S]{0,60}?\.insert\(|\.insert\(\s*[\w.]*\bid\b\s*\)|\bdepth\s*(>=|>|<=|<)|0\s*\.\.\s*[A-Z_][A-Z0-9_]*|\bMAX_[A-Z0-9_]*\b/;

// Matches `fn name(` or `fn name<...>(` at any indentation, capturing the
// name. Does not require `pub`/`pub(crate)` etc. prefixes to be absent.
const FN_HEADER_RE = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;

/**
 * Split `text` into top-level function definitions by brace-matching from
 * each `fn name(` header to the closing `}` of its body. Skips function
 * signatures with no body (trait declarations ending in `;`). Nested
 * functions are included in the outer function's body text (and are also
 * separately extracted as their own top-level entries when scanning
 * continues past them), which is conservative for this classifier: a
 * decode call physically inside an outer function's braces is attributed to
 * that outer function even if it lexically belongs to a nested closure.
 *
 * @param {string} text
 * @returns {Array<{ name: string, body: string, sig: string, start: number }>}
 */
export function extractFunctions(text) {
  const fns = [];
  FN_HEADER_RE.lastIndex = 0;
  let m;
  while ((m = FN_HEADER_RE.exec(text))) {
    const name = m[1];
    // Find the matching closing paren of the parameter list first, so a
    // `-> Result<T>` return type's angle brackets don't confuse brace
    // matching before the body even starts.
    let i = FN_HEADER_RE.lastIndex - 1; // index of the '(' just matched
    let depth = 1;
    i++;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    // Skip forward to the first `{` or `;` (return type / where-clause may
    // sit between the params and the body), ignoring anything inside `[...]`.
    // The bracket tracking is load-bearing, not defensive: an array return
    // type `-> Option<[f32; 4]>` contains a `;`, and stopping on it read all
    // three functions of `rust/processing/src/style/surface.rs` as bodyless
    // trait declarations, so the file classified as having zero functions.
    // Found by this classifier's own gate (scripts/check-refwalk-guards.mjs),
    // which fails when a file containing `fn` parses to none, rather than
    // reporting the file clean.
    let bracket = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '[') bracket++;
      else if (c === ']') bracket--;
      else if (bracket === 0 && (c === '{' || c === ';')) break;
      i++;
    }
    if (text[i] !== '{') continue; // declaration only, no body
    const bodyStart = i;
    depth = 1;
    i++;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    const body = text.slice(bodyStart, i);
    // `sig` is the header text from the `fn` keyword up to the body's `{`,
    // kept because the guard scan must see `visited: &mut OperandPath` /
    // `depth: u32` PARAMETERS, not just statements in the body.
    const sig = text.slice(m.index, bodyStart);
    fns.push({ name, body, sig, start: m.index });
  }
  return fns;
}

/**
 * Build a local call graph (function name -> set of local function names it
 * calls) restricted to the function names actually defined in this file, and
 * find which of those functions sit on a cycle (self-loop or a longer
 * mutual-recursion cycle) via DFS.
 *
 * @param {Array<{ name: string, body: string }>} fns
 * @returns {Set<string>} names of functions that are part of a local
 *   recursion cycle
 */
export function findRecursiveFunctions(fns) {
  const names = new Set(fns.map((f) => f.name));
  /** @type {Map<string, Set<string>>} */
  const graph = new Map();
  for (const fn of fns) {
    const callees = new Set();
    for (const other of names) {
      if (callSitePresent(fn.body, other)) callees.add(other);
    }
    graph.set(fn.name, callees);
  }

  const recursive = new Set();
  // Self-loops are immediate.
  for (const [name, callees] of graph) {
    if (callees.has(name)) recursive.add(name);
  }
  // Longer cycles: for each node, DFS from each of its callees looking for a
  // path back to the node itself.
  for (const start of graph.keys()) {
    if (recursive.has(start)) continue;
    const seen = new Set();
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === start) {
        recursive.add(start);
        break;
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of graph.get(cur) ?? []) stack.push(next);
    }
  }
  return recursive;
}

/**
 * Build name -> set-of-local-callees for every function in `fns`, restricted
 * to names actually defined in this file (same restriction
 * findRecursiveFunctions uses, kept separate so callers needing only the
 * graph don't pay for cycle detection).
 *
 * @param {Array<{ name: string, body: string }>} fns
 * @returns {Map<string, Set<string>>}
 */
function buildCallGraph(fns) {
  const names = new Set(fns.map((f) => f.name));
  const graph = new Map();
  for (const fn of fns) {
    const callees = new Set();
    for (const other of names) {
      if (callSitePresent(fn.body, other)) callees.add(other);
    }
    graph.set(fn.name, callees);
  }
  return graph;
}

/**
 * True when `body` contains a call to local function `name` reachable
 * WITHOUT going through an unrelated field/receiver -- i.e. a bare call
 * `name(...)`, `self.name(...)`, or `Self::name(...)`, but NOT
 * `self.some_other_field.name(...)`.
 *
 * This is the fix for the false-positive class found while measuring this
 * classifier against rust/geometry/src: `fn process(&self, ...)` methods on
 * several distinct processor structs (`ExtrusionProcessor`,
 * `SectionedProcessor`, `RevolvedProcessor`, ...) each dispatch to an
 * UNRELATED `ProfileProcessor` via `self.profile_processor.process(...)`.
 * A same-file, name-only match reads that as `process` calling itself,
 * because both methods share the name `process`. Requiring the call to be
 * bare or hang directly off `self`/`Self` (no intervening field) rejects
 * that shape while still matching genuine self-recursion
 * (`self.process_with_depth(...)`) and genuine associated-function
 * recursion (`Self::curve_points_guarded(...)`).
 *
 * Still lexical, not type-aware: `self.name(...)` where `name` merely SHARES
 * a name with a trait method some OTHER local function also happens to
 * define would still be misread as self-recursion. Not observed in
 * practice over rust/geometry/src -- see the feasibility report -- but
 * worth naming as a residual gap.
 *
 * @param {string} body
 * @param {string} name
 * @returns {boolean}
 */
function callSitePresent(body, name) {
  const n = escapeRe(name);
  const re = new RegExp(`(?:(?<![.\\w])${n}|(?<!\\w)self\\.${n}|(?<!\\w)Self::${n})\\s*\\(`);
  return re.test(body);
}

/**
 * Extract the bodies of top-level `for`/`while`/`loop` constructs in `text`
 * (typically one function's body), by brace-matching from each loop
 * keyword's opening `{` to its closing `}`. A loop nested inside another
 * loop is extracted both as part of the outer loop's body text AND as its
 * own separate entry -- harmless here since chase-loop detection only cares
 * whether the SHAPE occurs somewhere in the text, not which entry it was
 * found via.
 *
 * The opening `{` is located by scanning forward from the keyword, tracking
 * `()`/`[]` nesting depth so a `for x in v.iter().filter(|y| ...)` condition
 * doesn't stop early on a bracket, but NOT tracking `{}` depth in the
 * condition -- a `while let Some(Foo { field }) = ...` destructuring
 * pattern would defeat that. Not observed in rust/geometry/src's chase-loop
 * or bounded-loop call sites; worth naming as a residual gap.
 *
 * @param {string} text
 * @returns {string[]} loop body texts (braces excluded)
 */
export function extractLoopBodies(text) {
  const bodies = [];
  const re = /\b(for|while|loop)\b/g;
  while (re.exec(text)) {
    let i = re.lastIndex;
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === '{' && depth <= 0) break;
      i++;
    }
    if (text[i] !== '{') continue;
    const bodyStart = i + 1;
    let braceDepth = 1;
    i++;
    while (i < text.length && braceDepth > 0) {
      if (text[i] === '{') braceDepth++;
      else if (text[i] === '}') braceDepth--;
      i++;
    }
    bodies.push(text.slice(bodyStart, i - 1));
  }
  return bodies;
}

/**
 * The "chase loop" signal (the gap named in issue #2944's follow-up): a
 * `for`/`while`/`loop` whose body reassigns an EXISTING variable (no `let`)
 * from `decode_by_id`/`resolve_ref`/`resolve_ref_list`, where that same
 * variable also appears elsewhere in the loop body as the receiver of a
 * `.get(`/`.get_ref(` attribute access -- i.e. the next id chased comes from
 * an attribute OF the thing the loop just decoded, not from a list bound
 * before the loop started.
 *
 * True positive shape (probe.rs's `extract_extrusion_direction_recursive`,
 * despite its `_recursive` name):
 *   for _depth in 0..MAX_EXTRUSION_EXTRACT_DEPTH {
 *       let source_attr = current.get(0)?;               // current.get(
 *       let source = decoder.resolve_ref(source_attr)...; // current = decoder...(
 *       ...
 *       current = decoder.resolve_ref(source_attr).ok()??;
 *   }
 *
 * Rejected shape (edge_loop.rs's bounded iteration over a pre-bound list):
 *   for edge_ref in edges {
 *       let edge_id = edge_ref.as_entity_ref().unwrap();
 *       let oriented_edge = decoder.decode_by_id(edge_id).unwrap();  // `let`, not reassignment
 *   }
 * The `let` there creates a FRESH binding each iteration; the loop variable
 * `edge_ref` itself is never reassigned. Requiring the decode-driven
 * assignment to be a plain (non-`let`) mutation of a pre-existing variable
 * is what rejects this shape.
 *
 * The decode call feeding the cursor reassignment is often not in the SAME
 * statement -- `processors/boolean/mod.rs`'s `collect_polygonal_chain` does
 * `let Ok(Some(first)) = decoder.resolve_ref(first_attr) else { break };`
 * then, as a separate statement, `current = first;`. To catch that, this
 * builds a small transitive "decoded" set: any `let PATTERN = RHS;` (or
 * `let PATTERN = RHS else { ... };`) binding whose RHS either directly
 * contains a decode call, OR references a variable already in the set, adds
 * every identifier in PATTERN to the set (fixed-point iteration, so a
 * 3-deep chain like `items` <- decode call, `first` <- `items.next()`,
 * `current` <- `first` all resolve). A bare (non-`let`) reassignment
 * `X = RHS;` is then flagged as the chase step when RHS either directly
 * contains a decode call or references a decoded-set variable, AND `X`
 * separately appears in the loop body as `X.get(...)`/`X.get_ref(...)`.
 *
 * This is deliberately lexical/co-occurrence based -- it does not verify
 * that the SPECIFIC id passed to the decode call was produced by the
 * SPECIFIC `.get(...)` access on the same variable earlier in the body,
 * only that both happen somewhere in the same loop. Not observed to
 * misfire over rust/geometry/src (see the feasibility report), but a loop
 * that reassigns a cursor from a decode call for one reason while
 * separately, coincidentally, reading a `.get(...)` attribute off the same
 * variable name for an unrelated reason would be a false positive under
 * this rule.
 *
 * Guardedness (a `visited` set, a depth counter comparison, or a bounded
 * `0..MAX_*` / `0..CONST` range) is measured and reported separately
 * (`guarded` field) but does NOT gate whether a function is flagged --
 * same policy `findRecursiveFunctions` already uses for guarded recursive
 * walks (`sample_curve_polyline_guarded` is flagged in this file's tests
 * despite carrying both a depth AND a visited guard). A "flag" here means
 * "candidate reference-following walk, worth an allowlist entry / review",
 * not "confirmed unguarded bug" -- the maintainer's literal Option 1
 * wording ("without a visited or depth binding in scope") is answered by
 * the `guarded` field, not by suppressing the flag.
 *
 * @param {Array<{ name: string, body: string }>} fns
 * @returns {Map<string, { guarded: boolean }>} map of flagged function name
 *   to whether a guard was detected somewhere in its chase loop
 */
export function findChaseLoopFunctions(fns) {
  const result = new Map();
  for (const fn of fns) {
    const loopBodies = extractLoopBodies(fn.body);
    for (const loopBody of loopBodies) {
      if (!chaseLoopBodyMatches(loopBody)) continue;
      const existing = result.get(fn.name);
      const guarded = GUARD_RE.test(loopBody) || Boolean(existing?.guarded);
      result.set(fn.name, { guarded });
    }
  }
  return result;
}

// `let PATTERN = RHS;` and `let PATTERN = RHS else { ... };` -- the
// non-greedy RHS capture stops at the first top-level `;`, which for the
// `let-else` form lands right after the `else { ... }` block's closing
// brace as long as that block has no internal `;` (true for every chase
// call site measured: `else { break }` / `else { return false }`, no
// explicit statement semicolon before the brace closes).
const LET_BINDING_RE = /\blet\s+(?:mut\s+)?([^=;{]+?)=\s*([\s\S]*?);/g;

/**
 * @param {string} loopBody
 * @returns {boolean} true if `loopBody` matches the chase-loop shape
 */
function chaseLoopBodyMatches(loopBody) {
  const bindings = [];
  LET_BINDING_RE.lastIndex = 0;
  let m;
  while ((m = LET_BINDING_RE.exec(loopBody))) {
    const patternVars = (m[1].match(/[a-z_][A-Za-z0-9_]*/g) || []).filter((v) => v !== 'mut' && v !== 'ref');
    bindings.push({ vars: patternVars, rhs: m[2] });
  }

  // Fixed-point closure: a bound variable is "decoded" if its own RHS
  // directly calls decode_by_id/resolve_ref/resolve_ref_list, or if its RHS
  // references a variable already known to be decoded.
  const decodedVars = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { vars, rhs } of bindings) {
      if (vars.every((v) => decodedVars.has(v))) continue;
      const decodedByCall = DECODE_CALL_RE.test(rhs);
      const decodedByReference = [...decodedVars].some((v) => new RegExp(`\\b${escapeRe(v)}\\b`).test(rhs));
      if (decodedByCall || decodedByReference) {
        for (const v of vars) decodedVars.add(v);
        changed = true;
      }
    }
  }

  REASSIGN_RE.lastIndex = 0;
  while ((m = REASSIGN_RE.exec(loopBody))) {
    const [, letPrefix, varName, rhs] = m;
    if (letPrefix) continue; // fresh per-iteration binding, not a cursor mutation
    const rhsIsDecodeDerived =
      DECODE_CALL_RE.test(rhs) || [...decodedVars].some((v) => new RegExp(`\\b${escapeRe(v)}\\b`).test(rhs));
    if (!rhsIsDecodeDerived) continue;
    const attrAccessRe = new RegExp(`\\b${escapeRe(varName)}\\.get(?:_ref)?\\s*\\(`);
    if (attrAccessRe.test(loopBody)) return true;
  }
  return false;
}

/**
 * Classify one file's text against the shape the maintainer proposed for
 * issue #2944 Option 1 -- "a loop or recursion reaching decode_by_id /
 * resolve_ref / resolve_ref_list" -- refined to require CYCLE membership
 * rather than "any loop": a function is "flagged" when it sits on a local
 * self- or mutual-recursion cycle AND that cycle (or something it calls
 * downstream of the cycle) reaches a decode/resolve call -- even if the
 * decode call itself lives in a different function of the cycle, as in
 * `process_with_depth` <-> `process_operand_with_depth` where only the
 * second directly calls `decode_by_id`.
 *
 * "bounded" is every OTHER function that directly contains a decode/resolve
 * call -- ordinary iteration over a decode-derived id with no cycle behind
 * it, the edge_loop.rs shape.
 *
 * Also runs the SEPARATE chase-loop signal (`findChaseLoopFunctions`) over
 * the same functions and reports it as `chaseFlagged`/`chaseGuarded` --
 * independent of `flagged`/`bounded` so the two signals can be measured
 * against each other. A function can appear in both `flagged` (it sits on a
 * local recursion cycle) and `chaseFlagged` (it also contains a chase loop);
 * that overlap is real, not a bug -- e.g. `processors/boolean/mod.rs`'s
 * `process_with_depth` both mutually recurses with `process_operand` AND
 * contains an inline chase loop over `IfcBooleanResult.FirstOperand`.
 *
 * @param {string} text
 * @returns {{ flagged: string[], bounded: string[], chaseFlagged: string[], chaseGuarded: string[] }}
 */
export function classifyFile(text) {
  const fns = extractFunctions(text);
  const recursive = findRecursiveFunctions(fns);
  const graph = buildCallGraph(fns);
  const directDecode = new Set(fns.filter((f) => DECODE_CALL_RE.test(f.body)).map((f) => f.name));

  function reachesDecode(name, seen = new Set()) {
    if (directDecode.has(name)) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    for (const callee of graph.get(name) ?? []) {
      if (reachesDecode(callee, seen)) return true;
    }
    return false;
  }

  const flagged = [];
  const bounded = [];
  for (const fn of fns) {
    const reaches = reachesDecode(fn.name);
    if (!reaches) continue;
    if (recursive.has(fn.name)) flagged.push(fn.name);
    else if (directDecode.has(fn.name)) bounded.push(fn.name);
  }

  const chase = findChaseLoopFunctions(fns);
  const chaseFlagged = [...chase.keys()];
  const chaseGuarded = chaseFlagged.filter((name) => chase.get(name).guarded);

  return { flagged, bounded, chaseFlagged, chaseGuarded };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* Guard detection (added when this feasibility study became the gate  */
/* for issue #2944 -- scripts/check-refwalk-guards.mjs).               */
/* ------------------------------------------------------------------ */

/**
 * A visited-set guard: some binding whose name marks it as walk state --
 * `visited`, `seen`, `stack`, `path`, `walk`, `chain` -- is queried or
 * populated with `.insert(` / `.contains(` / `.push(`.
 *
 * Every widening here is a measured false positive of a narrower rule, not
 * anticipation:
 *
 *  - `processors/boolean/mod.rs` threads an `OperandPath` and writes
 *    `visited.insert(...)`; matching only the bare word `visited` sufficed.
 *  - `processors/surface.rs` threads a `CurveWalk` and writes
 *    `walk.seen.insert(curve_id)`, so the receiver is a FIELD path, not a
 *    plain identifier.
 *  - `rust/processing/src/processor/color_layer.rs`'s
 *    `resolve_presentation_layer_name` (the #2874 fix) uses a `Vec<u32>`
 *    named `traversal_stack` with `.contains(&id)` / `.push(id)` / `.pop()`
 *    -- a correct path-scoped guard that uses neither the word `visited` nor
 *    the method `insert`. An insert-only rule reported that fix as unguarded.
 *
 * The looseness is deliberate and its direction is the safe one for a gate
 * whose failure mode is a false ALARM on a guarded walk: `.contains(` on a
 * variable merely named `path` would read as guarded. That is why the
 * LIMITATIONS block in scripts/check-refwalk-guards.mjs says this asserts the
 * PRESENCE of a guard shape, not its correctness.
 */
const VISITED_GUARD_RE =
  /\b[A-Za-z0-9_.]*(?:visited|seen|stack|path|walk|chain)[A-Za-z0-9_.]*\s*\.\s*(?:insert|contains|push)\s*\(/i;

/**
 * A depth-cap guard: a `depth`-ish binding compared against something, or any
 * comparison against a SCREAMING_SNAKE constant whose name carries DEPTH /
 * MAX / LIMIT / BUDGET, or iteration over a bounded `0..CONST` range.
 *
 * The constant half is required and not redundant: `router/transforms/mod.rs`
 * caps with `if depth >= MAX_PLACEMENT_DEPTH`, which the `depth` half catches,
 * but `router/voids/probe.rs` caps by iterating `0..MAX_EXTRUSION_EXTRACT_DEPTH`
 * with no comparison operator anywhere in the loop.
 *
 * The bounded-range form requires the constant to NAME a bound
 * (DEPTH/MAX/LIMIT/BUDGET/ITER). Accepting any `0..=CONST` was measured wrong
 * against real history: at #2869's parent (27c6d9962),
 * `rust/processing/src/symbolic/items.rs` had NO guard at all, and the only
 * thing matching was `0..=SEGMENTS` -- an unrelated arc-tessellation loop --
 * so the walk #2869 exists to fix read as guarded. With the constant
 * restricted, that commit is correctly reported unguarded.
 */
const DEPTH_GUARD_RE =
  /\b_?depth\b[^;\n]{0,80}?(>=|<=|>|<)|(>=|<=|>|<)[^;\n]{0,40}?\b[A-Z][A-Z0-9_]*(?:DEPTH|MAX|LIMIT|BUDGET|ITER)[A-Z0-9_]*\b|\bMAX_[A-Z0-9_]*\b[^;\n]{0,40}?(>=|<=|>|<)|\b0\s*\.\.=?\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Z][A-Z0-9_]*(?:DEPTH|MAX|LIMIT|BUDGET|ITER)[A-Z0-9_]*\b/;

/**
 * Tarjan strongly-connected components over the local call graph. A function
 * is part of a recursion cycle when its SCC has more than one member, or when
 * it calls itself directly.
 *
 * SCCs rather than the pairwise DFS `findRecursiveFunctions` uses, because the
 * gate needs the cycle's MEMBERSHIP, not just a yes/no: the guard for a mutual
 * recursion routinely lives in a different member than the decode call.
 * `processors/boolean/mod.rs` is the measured case -- `process_with_depth_inner`
 * holds `if depth > MAX_BOOLEAN_DEPTH` and the `visited` insert, while
 * `process_operand_with_depth` holds the `decode_by_id`. Scoping the guard
 * search to one function at a time reports both halves as unguarded.
 *
 * @param {Map<string, Set<string>>} graph
 * @returns {Map<string, string[]>} function name -> the members of its cycle,
 *   for cycle members only. Non-recursive functions are absent.
 */
export function findRecursionCycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  /** @type {string[][]} */
  const components = [];

  // Iterative Tarjan: a recursive one would itself stack-overflow on a deep
  // call graph, which would be a poor look for this particular check.
  for (const root of graph.keys()) {
    if (idx.has(root)) continue;
    /** @type {Array<{ node: string, iter: Iterator<string> }>} */
    const work = [{ node: root, iter: (graph.get(root) ?? new Set()).values() }];
    idx.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const next = frame.iter.next();
      if (!next.done) {
        const w = next.value;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, iter: (graph.get(w) ?? new Set()).values() });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node), idx.get(w)));
        }
        continue;
      }
      work.pop();
      const v = frame.node;
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === idx.get(v)) {
        const component = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        components.push(component);
      }
    }
  }

  const cycles = new Map();
  for (const component of components) {
    const isCycle = component.length > 1 || (graph.get(component[0])?.has(component[0]) ?? false);
    if (!isCycle) continue;
    for (const name of component) cycles.set(name, component);
  }
  return cycles;
}

/**
 * Does `text` carry a cycle guard? Returns the kind for reporting, or `null`.
 *
 * @param {string} text
 * @returns {'visited'|'depth'|null}
 */
export function guardKindOf(text) {
  if (VISITED_GUARD_RE.test(text)) return 'visited';
  if (DEPTH_GUARD_RE.test(text)) return 'depth';
  return null;
}

/**
 * The gate's view of one file: every candidate reference-following walk, with
 * whether a guard is in scope for it.
 *
 * `signal` is `'recursion'` for a member of a local call cycle that reaches a
 * decode/resolve call, and `'chase'` for the loop shape that reassigns a
 * cursor from a decode call. A function can appear under both; they are
 * reported as two candidates because the guard scope differs -- the recursion
 * candidate is guarded by anything in its whole cycle, the chase candidate
 * only by something inside the chasing loop itself. `router/voids/probe.rs`'s
 * `extract_extrusion_direction_recursive` is a loop, not a recursion, and only
 * the chase candidate exists for it.
 *
 * @param {string} text
 * @returns {Array<{ name: string, signal: 'recursion'|'chase', guard: 'visited'|'depth'|null, cycle: string[] }>}
 */
export function findWalkCandidates(text) {
  const fns = extractFunctions(text);
  if (fns.length === 0) return [];
  const graph = buildCallGraph(fns);
  const cycles = findRecursionCycles(graph);
  const byName = new Map(fns.map((f) => [f.name, f]));
  const directDecode = new Set(fns.filter((f) => DECODE_CALL_RE.test(f.body)).map((f) => f.name));

  function reachesDecode(name, seen = new Set()) {
    if (directDecode.has(name)) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    for (const callee of graph.get(name) ?? []) {
      if (reachesDecode(callee, seen)) return true;
    }
    return false;
  }

  const out = [];
  for (const fn of fns) {
    const cycle = cycles.get(fn.name);
    if (cycle && reachesDecode(fn.name)) {
      // Guard scope = the whole cycle, plus each member's SIGNATURE, so a
      // `visited: &mut OperandPath` / `depth: u32` parameter counts even when
      // the member that owns the comparison is elsewhere in the cycle.
      const scope = cycle.map((n) => scopeOf(byName.get(n))).join('\n');
      out.push({ name: fn.name, signal: 'recursion', guard: guardKindOf(scope), cycle: [...cycle].sort() });
    }
    for (const loopBody of extractLoopBodies(fn.body)) {
      if (!chaseLoopBodyMatches(loopBody)) continue;
      const existing = out.find((c) => c.name === fn.name && c.signal === 'chase');
      const guard = guardKindOf(loopBody);
      if (existing) existing.guard = existing.guard ?? guard;
      else out.push({ name: fn.name, signal: 'chase', guard, cycle: [] });
    }
  }
  return out;
}

/**
 * A function's guard scope: its signature plus its body.
 *
 * @param {{ sig: string, body: string } | undefined} fn
 * @returns {string}
 */
function scopeOf(fn) {
  return fn ? `${fn.sig}
${fn.body}` : '';
}
