#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2948: a reliable answer to "does this vitest `it`/`test` call carry an
 * explicit timeout" — reliable meaning it does not fall for either mistake
 * that was actually made while fixing #2947:
 *
 *   - a grep for `}, 60_000);` (the TRAILING form) scores a test written as
 *     `it(name, { timeout: 60_000 }, fn)` (the OPTIONS-OBJECT form) as
 *     unprotected;
 *   - a grep for the options-object form, or for a single-line trailing
 *     number, scores a test whose trailing number is split across lines
 *     (the MULTI-LINE form — same idiom as trailing, just wrapped) as
 *     unprotected.
 *
 * All three are really only TWO shapes once whitespace stops mattering:
 * "3rd top-level argument is a numeric literal" (trailing / multi-line — the
 * two differ only in whether a newline sits before the number) and "2nd
 * top-level argument is an object literal with a `timeout` key". Grep sees
 * whitespace and string content; it cannot tell "argument boundary" from
 * "comma inside a string" or "number inside a comment". This module does,
 * via a small brace/paren-depth scan instead of a regex over raw text.
 *
 * IT ALSO RESOLVES ONE MORE CASE THAT GREP-BASED AUDITS (INCLUDING THE ONE
 * THAT PRODUCED #2948'S OWN AT-RISK TABLE) MISS: a `describe(name, {
 * timeout }, fn)` timeout is inherited by every `it`/`test` nested inside
 * it that does not set its own. Confirmed behaviourally (not asserted from
 * vitest's docs) in this fix's own verification: a child `it` with no
 * timeout of its own, nested under a `describe` carrying `{ timeout: 7000
 * }`, passed a 6000ms sleep under vitest's 5000ms default, and the SAME
 * shape with `{ timeout: 2000 }` failed the 6000ms sleep with "Test timed
 * out in 2000ms" — so the inheritance is real enforcement, not a decorative
 * option only the describe block itself observes. `auditSource` walks
 * enclosing `describe` calls for exactly this reason: a test can be fully
 * protected while its own `it(...)` call carries no timeout argument at
 * all, and a checker that only looks at the `it` call, brace-matched or
 * not, still reports a false positive there.
 *
 * NOT covered, and deliberately out of scope: `beforeEach`/`afterEach`/
 * `beforeAll`/`afterAll` hook timeouts. A hook's own timeout argument is a
 * different budget (`hookTimeout`, 10_000ms default, vs. `testTimeout`'s
 * 5000ms) governing a different span of the test's wall clock — vitest
 * starts a test's own timeout clock only once its hooks have resolved
 * (confirmed the same way: a `beforeEach` that alone takes 5.8s passed
 * under the default 5000ms `testTimeout`). Slow work sitting in a hook is a
 * real thing to check for, but it is not an instance of the three-spellings
 * problem this module solves and folding it in would silently misattribute
 * hook budget to test budget. `parser-worker-panic-forward.test.ts` is a
 * real example of exactly this trap (#2948's own fix).
 *
 * LIMITATIONS, honestly listed rather than silently wrong:
 *   - detection of `it`/`test`/`describe` call sites is lexical (a global
 *     scan for the bare word, not preceded by `.`), so a local variable or
 *     object property literally named `it`/`test`/`describe` used as a
 *     function call would be misread as a vitest call. Not observed in this
 *     repo's test files; if it ever happens, `auditSource` reports an entry
 *     for it rather than crashing, and that entry is wrong. This mirrors the
 *     honesty requirement `scripts/check-source-text-assertions.mjs`
 *     documents for its own lexical (not data-flow) detection.
 *   - template-literal interpolations (`` `${…}` ``) are treated as opaque
 *     text, not parsed — a call inside `${…}` would not be found. Not used
 *     anywhere in this repo's `it`/`test`/`describe` argument lists.
 *   - `/regex/` literals are recognised by the standard prev-token
 *     heuristic: a `/` starts a regex when the last significant token
 *     before it is an operator, punctuator, or one of the keywords in
 *     `REGEX_PRECEDING_RE` (`(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`,
 *     `{`, `;`, `return`, `typeof`, … or start-of-file), and is division
 *     otherwise — including right after a string or template literal,
 *     which `stripNoise` tracks separately because a blanked literal is
 *     indistinguishable from whitespace. This covers every shape actually
 *     seen in this codebase. NOT handled: a regex after an operator absent
 *     from that list; a regex spanning a line break (bailed on, and the `/`
 *     is then read as ordinary); a `/` immediately after `}` where the `}`
 *     closed a block rather than an object literal (read as division).
 *     `stripNoise` MUST step over regex literals — before it did, a regex
 *     containing an apostrophe (`toMatch(/^'/)`) opened a phantom string
 *     that swallowed the rest of the file and dropped EVERY call site in
 *     it, including ones before the regex. Pinned by
 *     `vitest-timeout-audit.test.mjs`.
 *   - a `describe`/`it`/`test` reached through a value rather than named
 *     directly — `const t = it; t('name', fn)`, or a `.each` table built by
 *     a helper — is not found. The one indirection that IS handled is the
 *     immediately-invoked parenthesized form `(cond ? it : it.skip)('name',
 *     fn)`, which this repo uses.
 *   - TypeScript type-argument lists on the call or its modifier
 *     (`it.each<[Role, boolean]>([...])`) are stepped over; see
 *     `skipTypeArguments` for what that scan does not cover.
 *
 * Run standalone: `node scripts/lib/vitest-timeout-audit.mjs <file...>`
 * prints one line per `it`/`test` call — deliberately a reporting tool a
 * human reads, not a CI gate: the issue this answers (#2948) is explicit
 * that the RIGHT timeout for a slow test requires understanding what the
 * test does, which this module cannot judge — it only answers "does this
 * call already carry an explicit one, and if so which spelling and value".
 * Unit-tested against synthetic source snippets (never against this repo's
 * real test files — that would be exactly the source-text-as-behaviour
 * substitution `check-source-text-assertions.mjs` exists to block) in
 * `vitest-timeout-audit.test.mjs`.
 *
 * Standalone exit codes: 0 once every file it was given is a vitest test
 * file whose call sites it could parse — INCLUDING a `describe`-wrapped
 * shared-suite runner with zero literal `it`/`test` call sites of its own.
 * 1 if it was given no file arguments, if none of the named files holds a
 * `describe`/`it`/`test` token (wrong paths), or if a call site was found
 * but could not be parsed (a parser blind spot, reported as such). An audit
 * of nothing prints a summary of all zeros, which reads like a clean report
 * — see the guard at the bottom of this file.
 *
 * CONFIG-LEVEL PROTECTION (the blind spot fixed after #2948 shipped): a
 * package's `vitest.config.ts` can set `test.testTimeout`, which is vitest's
 * DEFAULT for every `it`/`test` in that package that does not carry its own
 * (call-level or `describe`-level) timeout. Two packages in this repo do
 * this deliberately — `packages/data` and `packages/create-ifc-lite`, both
 * `testTimeout: 30_000` — and everything that scans only `it`/`describe`
 * call sites, this module included before this fix, reported every one of
 * those tests as unprotected (193 calls, confirmed against this repo). This
 * module now also resolves that config value, per test file, by walking
 * from the test file's directory up to its nearest package root (the first
 * ancestor directory containing a `package.json`) and reading the first
 * matching config filename there. Supported filenames, in vitest's own
 * resolution order: `vitest.config.{ts,mts,cts,js,mjs,cjs}`, then
 * `vite.config.{ts,mts,cts,js,mjs,cjs}` (a `vitest.config.*` always wins
 * over `vite.config.*` when both exist — matches vitest's own precedence).
 * Every `vitest.config.*` in this repo today is a `.ts` file with no
 * matching `vite.config.*` alongside it, and no workspace-level config
 * exists at the repo root; the other filenames are supported because
 * vitest itself accepts them, not because anything here uses them yet.
 *
 * The config file is READ AS TEXT, never imported/executed — same
 * `stripNoise` + depth-aware scan the call-site parser uses, not `eval` or
 * a dynamic `import()`, because a config module can have arbitrary side
 * effects and top-level imports that may not resolve outside a real vitest
 * run. `resolveConfigTimeout` looks for a top-level `testTimeout:` key and
 * classifies its value the same way `classifyExplicitTimeout` classifies a
 * call-level timeout: a bare numeric literal (with underscores) resolves to
 * a number. ANYTHING ELSE — a named identifier (`testTimeout: DEFAULT_MS`,
 * which could be a local const or an import), a ternary, a function call —
 * is reported as `determined: false` rather than guessed either way. This
 * is stricter than the call-site scanner's treatment of a bare identifier
 * (which it still counts as "explicit, value unresolved"): at the config
 * level a wrong "protected" verdict is exactly the failure this fix exists
 * to correct, so an undetermined config value gets its own third status,
 * `config-unknown`, distinct from both `protected` and `unprotected` — see
 * `auditFile`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

const CALL_KEYWORD_RE = /(?<![.\w$])(describe|it|test)(?![\w$])/g;

/**
 * Modifiers that themselves take a parenthesized argument BEFORE the real
 * call's argument list (`describe.skipIf(cond)('name', ...)`,
 * `it.each([...])('name %s', ...)`). Every other modifier (`.only`,
 * `.skip`, `.concurrent`, `.sequential`, `.todo`, `.fails`) is a bare flag —
 * the `(` right after it is the real call's own opening paren, not a
 * modifier argument list, and must NOT be skipped as one.
 */
const PARAMETERIZED_MODIFIERS = new Set(['each', 'skipIf', 'runIf', 'extend']);
const REGEX_PRECEDING_RE = /[([{,;:=!&|?~^%*+-]$|^$|(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/**
 * Replace every comment, string, and template literal in `source` with
 * whitespace of the SAME length (newlines preserved as newlines), so line
 * numbers and character offsets stay valid, while nothing inside a string,
 * template, or comment can be mistaken for real `()[]{}",` structure.
 *
 * Regex literals are left in place as ordinary characters — see the module
 * doc comment's LIMITATIONS note — because unlike strings/comments they can
 * legitimately be adjacent to the very call syntax callers care about (e.g.
 * `it.each(...)`), and blanking them wrongly risks losing real parens that
 * belong to the surrounding call. Depth-tracking code (`findMatchingParen`,
 * `splitTopLevelByComma`) instead treats a well-formed `/…/` as one opaque
 * token via `skipRegexLiteral` below.
 */
export function stripNoise(source) {
  const out = Array.from(source);
  const n = out.length;
  let i = 0;
  // Index just past the most recently blanked string/template literal.
  // After blanking, a literal is indistinguishable from whitespace, so
  // `isRegexStart` would look straight PAST it to whatever preceded the
  // literal and could call a `/` that is plainly division (`'ab' / 2`) a
  // regex. Remembering where the literal ended keeps that one case right.
  let lastLiteralEnd = -1;
  while (i < n) {
    const c = out[i];
    const c2 = i + 1 < n ? out[i + 1] : '';
    if (c === '/' && c2 === '/') {
      while (i < n && out[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    // A `/…/` regex literal stays in place (see the doc comment above), but
    // it MUST be stepped over as one token here rather than scanned
    // character by character: an apostrophe or a backtick inside the
    // pattern — `expect(x).toMatch(/^'/)` — otherwise opens a "string" that
    // swallows the rest of the file, after which `findMatchingParen` fails
    // and EVERY call site in the file disappears, including the ones before
    // the regex. That was silently under-counting protection repo-wide.
    if (c === '/' && lastSignificant(out, i) >= lastLiteralEnd && isRegexStart(out, i)) {
      const after = skipRegexLiteral(out, i);
      if (after !== -1) { i = after; continue; }
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out[i] = ' '; i += 1;
      while (i < n && out[i] !== quote) {
        if (out[i] === '\\' && i + 1 < n) { if (out[i] !== '\n') out[i] = ' '; i += 1; }
        if (out[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) { out[i] = ' '; i += 1; }
      lastLiteralEnd = i;
      continue;
    }
    if (c === '`') {
      out[i] = ' '; i += 1;
      while (i < n && out[i] !== '`') {
        if (out[i] === '\\' && i + 1 < n) { if (out[i] !== '\n') out[i] = ' '; i += 1; }
        if (i < n && out[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) { out[i] = ' '; i += 1; }
      lastLiteralEnd = i;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Index (into `clean`) of the last non-whitespace character before `pos`,
 * or -1. `clean` may be a string or the char ARRAY `stripNoise` is building
 * (both index by number and expose `.length`), so the regex heuristics
 * below can run mid-strip as well as over a finished `clean`.
 */
function lastSignificant(clean, pos) {
  let j = pos - 1;
  while (j >= 0 && /\s/.test(clean[j])) j -= 1;
  return j;
}

/** `slice(...).join('')` for a char array, plain `slice` for a string. */
function sliceText(clean, start, end) {
  return Array.isArray(clean) ? clean.slice(start, end).join('') : clean.slice(start, end);
}

/**
 * True if a `/` at `pos` in `clean` starts a regex literal rather than
 * division, judged from the last significant token before it — the
 * standard heuristic (division only ever follows a value; a regex follows
 * an operator, punctuation, keyword, or start-of-input/statement).
 */
function isRegexStart(clean, pos) {
  const end = lastSignificant(clean, pos);
  if (end < 0) return true;
  let start = end;
  if (/[\w$]/.test(clean[end])) {
    while (start >= 0 && /[\w$]/.test(clean[start])) start -= 1;
    start += 1;
    return REGEX_PRECEDING_RE.test(sliceText(clean, start, end + 1));
  }
  return REGEX_PRECEDING_RE.test(clean[end]);
}

/**
 * Advance past a `/…/flags` regex literal starting at `pos`; returns the
 * index just after it, or -1 if what starts at `pos` is not a terminated
 * single-line regex literal (so the caller treats the `/` as an ordinary
 * character rather than swallowing the rest of the line).
 */
function skipRegexLiteral(clean, pos) {
  let i = pos + 1;
  let inClass = false;
  let closed = false;
  while (i < clean.length) {
    const c = clean[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i += 1; closed = true; break; }
    else if (c === '\n') break; // malformed / not actually a regex — bail, caller treats '/' as ordinary
    i += 1;
  }
  if (!closed) return -1;
  while (i < clean.length && /[a-z]/i.test(clean[i])) i += 1;
  return i;
}

/**
 * Index just past the `)` matching the `(` at `openIdx` in `clean`, scanning
 * both `clean` and treating any `/…/` it finds via {@link isRegexStart} as
 * opaque so a regex containing `)` or `(` cannot corrupt the count.
 */
function findMatchingParen(clean, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < clean.length) {
    const c = clean[i];
    if (c === '/' && isRegexStart(clean, i)) {
      const after = skipRegexLiteral(clean, i);
      if (after !== -1) { i = after; continue; }
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1; // unbalanced — caller must treat as "could not parse"
}

/**
 * Split the text between `[start, end)` in `original` (with `clean` the
 * noise-stripped twin of the same range) into top-level comma-separated
 * argument strings, from `original` so callers see real content.
 */
function splitTopLevelByComma(original, clean, start, end) {
  const parts = [];
  let depth = 0;
  let partStart = start;
  let i = start;
  while (i < end) {
    const c = clean[i];
    if (c === '/' && isRegexStart(clean, i)) {
      const after = skipRegexLiteral(clean, i);
      if (after !== -1) { i = after; continue; }
    }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(original.slice(partStart, i));
      partStart = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  const last = original.slice(partStart, end).trim();
  if (last.length > 0) parts.push(original.slice(partStart, end));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const NUMERIC_RE = /^[0-9][0-9_]*$/;

/**
 * A bare identifier — `AB22_TIMEOUT_MS`, not `() => {}` or `myFn()` or
 * `obj.prop`. In real vitest usage the 3rd `it`/`test` argument and an
 * options object's `timeout` value can only be a number, so a bare
 * identifier there is a named numeric constant (this repo's own convention,
 * e.g. `AB22_TIMEOUT_MS` in `gym.test.ts`, and this fix's own
 * `WORKER_IMPORT_HOOK_TIMEOUT_MS` / `YIELD_HEAVY_TIMEOUT_MS`) — still an
 * explicit timeout, just with a value this lexical scan cannot resolve
 * without evaluating the module.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Classify one vitest call's argument list for an explicit timeout, per the
 * module doc comment: 3rd top-level arg is a bare numeric literal or named
 * constant (TRAILING, whitespace before it irrelevant so this covers the
 * MULTI-LINE spelling too), or the 2nd top-level arg is an object literal
 * carrying a `timeout` key with a numeric or named-constant value
 * (OPTIONS-OBJECT).
 */
export function classifyExplicitTimeout(argTexts) {
  if (argTexts.length >= 3) {
    // A comment justifying the number (as opposed to trailing whitespace
    // alone) legitimately precedes the literal on its own line(s) — see
    // tri-mesh.test.ts's `agrees with an exhaustive scan on %s` for a real
    // example. `stripNoise` before trimming is what keeps that comment from
    // making `trailing` fail NUMERIC_RE/IDENTIFIER_RE and reporting a
    // false "no explicit timeout" on an already-protected test.
    const trailing = stripNoise(argTexts[argTexts.length - 1]).trim();
    if (NUMERIC_RE.test(trailing)) {
      return { explicit: true, form: 'trailing', value: Number(trailing.replace(/_/g, '')) };
    }
    if (IDENTIFIER_RE.test(trailing)) {
      return { explicit: true, form: 'trailing', value: null, valueRef: trailing };
    }
  }
  if (argTexts.length >= 2) {
    const second = argTexts[1].trim();
    if (second.startsWith('{') && second.endsWith('}')) {
      const inner = second.slice(1, -1);
      const cleanInner = stripNoise(inner);
      const props = splitTopLevelByComma(inner, cleanInner, 0, inner.length);
      for (const prop of props) {
        const trimmed = prop.trim();
        const m = /^['"]?timeout['"]?\s*:\s*([0-9][0-9_]*)/.exec(trimmed);
        if (m) return { explicit: true, form: 'options-object', value: Number(m[1].replace(/_/g, '')) };
        const mRef = /^['"]?timeout['"]?\s*:\s*([A-Za-z_$][\w$]*)/.exec(trimmed);
        if (mRef) return { explicit: true, form: 'options-object', value: null, valueRef: mRef[1] };
      }
    }
  }
  return { explicit: false, form: null, value: null };
}

/**
 * Text of the value bound to a `key: VALUE` pair in `clean`, starting the
 * scan just after the `:` at `colonIdx`. Depth-aware over `()[]{}` (and
 * regex-literal-safe via `isRegexStart`/`skipRegexLiteral`) so a value that
 * itself contains a comma or brace (`{ a: 1, b: 2 }`, `fn(1, 2)`) is not cut
 * short — the scan stops only at a top-level comma or the closing bracket
 * of whatever encloses the key (depth going negative).
 */
function extractAssignedValue(clean, colonIdx) {
  let i = colonIdx + 1;
  while (i < clean.length && /\s/.test(clean[i])) i += 1;
  const start = i;
  let depth = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === '/' && isRegexStart(clean, i)) {
      const after = skipRegexLiteral(clean, i);
      if (after !== -1) { i = after; continue; }
    }
    if (c === '(' || c === '{' || c === '[') { depth += 1; i += 1; continue; }
    if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) break;
      depth -= 1; i += 1; continue;
    }
    if (c === ',' && depth === 0) break;
    i += 1;
  }
  return clean.slice(start, i).trim();
}

const TEST_TIMEOUT_KEY_RE = /(?<![.\w$])testTimeout(?![\w$])\s*:/;

/**
 * Resolve a package `vitest.config.*`/`vite.config.*`'s `test.testTimeout`
 * value from its SOURCE TEXT (never imported/executed — see the module doc
 * comment). Returns:
 *   - `null` if the file has no top-level `testTimeout:` key at all (no
 *     config-level override — every test in the package falls back to
 *     vitest's own 5000ms default);
 *   - `{ determined: true, value: N }` if the value is a bare numeric
 *     literal (underscores allowed, e.g. `30_000`);
 *   - `{ determined: false, value: null }` for anything else — a named
 *     identifier, a ternary, a function call — because none of those can be
 *     resolved without evaluating the module, and guessing either
 *     "protected" or "unprotected" here is exactly the mistake this module
 *     exists to avoid making twice.
 */
export function resolveConfigTimeout(configSource) {
  const clean = stripNoise(configSource);
  const m = TEST_TIMEOUT_KEY_RE.exec(clean);
  if (!m) return null;
  const colonIdx = m.index + m[0].length - 1;
  const raw = extractAssignedValue(clean, colonIdx);
  if (NUMERIC_RE.test(raw)) {
    return { determined: true, value: Number(raw.replace(/_/g, '')) };
  }
  return { determined: false, value: null };
}

/**
 * Config filenames vitest itself recognises, in its own resolution order:
 * a `vitest.config.*` always wins over a `vite.config.*` in the same
 * directory. Every extension vitest accepts is listed even though this
 * repo, as of this fix, only actually has `.ts` files — see the module doc
 * comment for the "what actually exists here" audit behind that choice.
 */
const CONFIG_FILENAMES = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts',
  'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.cts',
  'vite.config.js', 'vite.config.mjs', 'vite.config.cjs',
];

const packageConfigCache = new Map();

/**
 * Find and resolve the `testTimeout` governing `testFilePath`, by walking
 * from its directory up to the nearest ancestor containing a
 * `package.json` (that package's root — this is a monorepo, each package
 * carries its own independent vitest config, so walking PAST a package
 * root risks picking up an unrelated sibling or the repo's own tooling
 * config) and reading the first `CONFIG_FILENAMES` match found along the
 * way. Returns `null` if no config file governs this test file, or if one
 * does but sets no `testTimeout`; otherwise the `resolveConfigTimeout`
 * result, plus `configPath` for reporting. Memoised per directory since a
 * single package root serves every test file beneath it.
 */
export function findPackageConfigTimeout(testFilePath) {
  let dir = dirname(resolvePath(testFilePath));
  // Every directory visited on the way to a resolved answer gets that SAME
  // final answer cached against it — not the per-directory "no config
  // here" intermediate — so a second test file starting in a subdirectory
  // one level below the package root (e.g. `src/`, having no config or
  // `package.json` of its own) does not short-circuit on a stale `null`
  // cached for `src/` during the FIRST file's walk-up before it ever
  // reached the package root's real config. That was a real bug caught by
  // running this tool against the whole repo: only the first test file
  // touched per package root came back config-protected; every sibling
  // test file one directory below it wrongly stayed "no config".
  const visited = [];
  for (let guard = 0; guard < 64; guard += 1) {
    if (packageConfigCache.has(dir)) {
      const cached = packageConfigCache.get(dir);
      for (const v of visited) packageConfigCache.set(v, cached);
      return cached;
    }
    visited.push(dir);
    let result = null;
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        const source = readFileSync(candidate, 'utf8');
        const resolved = resolveConfigTimeout(source);
        result = resolved ? { ...resolved, configPath: candidate } : null;
        break;
      }
    }
    const isPackageRoot = existsSync(join(dir, 'package.json'));
    if (result || isPackageRoot) {
      for (const v of visited) packageConfigCache.set(v, result);
      return result;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      for (const v of visited) packageConfigCache.set(v, null);
      return null;
    }
    dir = parent;
  }
  for (const v of visited) packageConfigCache.set(v, null);
  return null;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/**
 * Index just past the `>` closing a TypeScript type-argument list opening at
 * `pos` (`it.each<[Role, boolean]>([...])`, `test<Ctx>(...)`), or -1 if the
 * `<` at `pos` does not open a balanced one. Depth is counted on `<`/`>`
 * with `=>` stepped over so a function type inside the list
 * (`<(a: string) => void>`) does not close it early. Strings and comments
 * are already blanked in `clean`, so nothing inside one can be miscounted.
 * NOT handled: a `>` inside a nested regex or a `>>` shift inside a type-level
 * expression, neither of which occurs in a vitest type-argument list; a `<`
 * that is really a less-than comparison bails out via the -1 return because
 * an unmatched `>` will not be found before the scan cap.
 */
function skipTypeArguments(clean, pos) {
  let depth = 0;
  let i = pos;
  const limit = Math.min(clean.length, pos + 2000);
  while (i < limit) {
    const c = clean[i];
    if (c === '=' && clean[i + 1] === '>') { i += 2; continue; }
    if (c === '<') depth += 1;
    else if (c === '>') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (c === ';' || c === '}') return -1; // ran past the end of an expression
    i += 1;
  }
  return -1;
}

/**
 * Scan `source` for `describe`/`it`/`test` calls (including modifier chains
 * like `.skipIf(...)`, `.only`, `.each(...)`), matching parens via `clean`,
 * and skipping any parenthesized modifier argument (`.each([...])`,
 * `.skipIf(cond)`) as an opaque unit before locating the call's own
 * argument list.
 */
function findCalls(source) {
  const clean = stripNoise(source);
  const calls = [];
  const unparsed = [];
  const seenOpenParen = new Set();
  CALL_KEYWORD_RE.lastIndex = 0;
  let m;
  while ((m = CALL_KEYWORD_RE.exec(clean)) !== null) {
    const keyword = m[1];
    let pos = m.index + keyword.length;
    let ok = true;
    for (;;) {
      while (pos < clean.length && /\s/.test(clean[pos])) pos += 1;
      if (clean[pos] === '.') {
        pos += 1;
        const nameStart = pos;
        while (pos < clean.length && /[\w$]/.test(clean[pos])) pos += 1;
        const modifierName = clean.slice(nameStart, pos);
        while (pos < clean.length && /\s/.test(clean[pos])) pos += 1;
        // `it.each<[Role, boolean]>([...])` — the TS type-argument list sits
        // between the modifier name and its argument list. Without stepping
        // over it the `(` check below fails and the whole call is dropped;
        // the untyped spelling was recognised, so only typed call sites went
        // missing.
        if (clean[pos] === '<') {
          const afterTypeArgs = skipTypeArguments(clean, pos);
          if (afterTypeArgs === -1) { ok = false; break; }
          pos = afterTypeArgs;
          while (pos < clean.length && /\s/.test(clean[pos])) pos += 1;
        }
        if (clean[pos] === '(' && PARAMETERIZED_MODIFIERS.has(modifierName)) {
          const close = findMatchingParen(clean, pos);
          if (close === -1) { ok = false; break; }
          pos = close;
        }
        continue;
      }
      break;
    }
    if (!ok) { unparsed.push({ keyword, line: lineOf(source, m.index) }); continue; }
    while (pos < clean.length && /\s/.test(clean[pos])) pos += 1;
    // Same for a type-argument list on the call itself: `test<Ctx>(...)`.
    if (clean[pos] === '<') {
      const afterTypeArgs = skipTypeArguments(clean, pos);
      if (afterTypeArgs === -1) { unparsed.push({ keyword, line: lineOf(source, m.index) }); continue; }
      pos = afterTypeArgs;
      while (pos < clean.length && /\s/.test(clean[pos])) pos += 1;
    }
    // `(hasBuild ? it : it.skip)('name', fn)` — the keyword sits inside a
    // parenthesized expression that is then invoked, so the call's own `(`
    // comes after one or more closing parens. Both `it` occurrences in that
    // ternary resolve to the SAME opening paren; `seenOpenParen` below keeps
    // that from being counted twice.
    while (clean[pos] === ')') {
      pos += 1;
      while (pos < clean.length && /\s/.test(clean[pos])) pos += 1;
    }
    if (clean[pos] !== '(') continue; // not actually a call (e.g. bare identifier use)
    const openParen = pos;
    if (seenOpenParen.has(openParen)) continue;
    seenOpenParen.add(openParen);
    const close = findMatchingParen(clean, openParen);
    if (close === -1) { unparsed.push({ keyword, line: lineOf(source, m.index) }); continue; }
    const argsStart = openParen + 1;
    const argsEnd = close - 1;
    const argTexts = splitTopLevelByComma(source, clean, argsStart, argsEnd);
    calls.push({
      keyword,
      start: m.index,
      end: close,
      line: lineOf(source, m.index),
      argTexts,
      name: argTexts.length > 0 ? argTexts[0].trim().replace(/^['"`]|['"`]$/g, '') : null,
    });
  }
  return { calls, unparsed };
}

/**
 * Call sites this module recognised as a `describe`/`it`/`test` invocation
 * but could NOT parse (unbalanced parens, or a `<…>` that did not close).
 * Reported separately from "no call sites here" so a file the parser choked
 * on is never mistaken for a file that legitimately declares no tests —
 * that distinction is what the standalone guard at the bottom rests on.
 */
export function findUnparsedCallSites(source) {
  return findCalls(source).unparsed;
}

/**
 * True iff `source` contains a bare `describe`/`it`/`test` token outside
 * every comment, string, and template literal — i.e. it is plausibly a
 * vitest test file, even if it declares no `it`/`test` of its own (a
 * `describe`-wrapped shared-suite runner such as
 * `describe('X', () => runConformanceSuite(...))` is a real test file with
 * zero literal call sites).
 */
export function hasTestKeywordToken(source) {
  const clean = stripNoise(source);
  CALL_KEYWORD_RE.lastIndex = 0;
  return CALL_KEYWORD_RE.test(clean);
}

/**
 * Full audit of one file's `it`/`test` calls: own explicit timeout if any,
 * else the nearest enclosing `describe`'s explicit timeout if any, else
 * none — resolved by textual containment of call spans, which is exact for
 * syntactically valid nesting.
 */
export function auditSource(source) {
  const { calls } = findCalls(source);
  const describes = calls.filter((c) => c.keyword === 'describe');
  const results = [];
  for (const call of calls) {
    if (call.keyword === 'describe') continue;
    const own = classifyExplicitTimeout(call.argTexts);
    if (own.explicit) {
      results.push({ ...call, protectedBy: 'own', form: own.form, value: own.value, valueRef: own.valueRef ?? null });
      continue;
    }
    // Nearest enclosing describe with an explicit timeout: smallest span
    // among describes that strictly contain this call.
    let best = null;
    for (const d of describes) {
      if (d.start < call.start && call.end < d.end) {
        if (best === null || d.end - d.start < best.end - best.start) best = d;
      }
    }
    let inherited = null;
    while (best) {
      const t = classifyExplicitTimeout(best.argTexts);
      if (t.explicit) { inherited = { describeName: best.name, ...t }; break; }
      // Walk further out: the next-smallest describe that also contains `call`.
      let next = null;
      for (const d of describes) {
        if (d === best) continue;
        if (d.start < best.start && best.end < d.end && d.start < call.start && call.end < d.end) {
          if (next === null || d.end - d.start < next.end - next.start) next = d;
        }
      }
      best = next;
    }
    if (inherited) {
      results.push({
        ...call,
        protectedBy: `describe:${inherited.describeName}`,
        form: inherited.form,
        value: inherited.value,
        valueRef: inherited.valueRef ?? null,
      });
    } else {
      results.push({ ...call, protectedBy: null, form: null, value: null, valueRef: null });
    }
  }
  return results;
}

/**
 * True iff this `it`/`test` call has an explicit timeout, own or inherited
 * from an enclosing `describe`. The single-question API #2948 asked for.
 */
export function hasExplicitTimeout(source, testName) {
  const results = auditSource(source);
  const match = results.find((r) => r.name === testName);
  if (!match) return null; // test not found — caller's name/source mismatch, not "no timeout"
  return match.protectedBy !== null;
}

/**
 * `auditSource`'s per-call/`describe` results, PLUS the package-level
 * `testTimeout` fallback resolved from `filePath`'s nearest package config
 * (see `findPackageConfigTimeout`) for whichever calls neither their own
 * nor an enclosing `describe`'s timeout already covers. Three outcomes for
 * `configStatus` on a call this promotes or flags, distinct from the
 * existing `own`/`describe:*`/`null` `protectedBy` values:
 *   - not set at all: an `own`/`describe` timeout already covers this call,
 *     or no package config (or no `testTimeout` key in it) applies — the
 *     `protectedBy`/`unprotected` verdict from `auditSource` stands as-is;
 *   - `'determined'`: no config governs, sets `protectedBy: 'config'` and
 *     `value` to the resolved number — genuinely protected, just by a
 *     package default rather than this call's own argument list;
 *   - `'unknown'`: a `testTimeout:` key exists in the governing config but
 *     its value could not be statically resolved (see
 *     `resolveConfigTimeout`). `protectedBy` is left `null` (NOT flipped to
 *     `'config'`) because we have no evidence the value is anything other
 *     than vitest's 5000ms default made explicit — but this is also not
 *     the plain "no timeout anywhere" case `auditSource` alone would
 *     report, so callers must not silently fold it into "unprotected"
 *     either. Report it as its own bucket.
 */
export function auditFile(filePath, source) {
  const results = auditSource(source);
  let configResult; // resolved lazily, once, only if some call actually needs it
  let configResolved = false;
  for (const r of results) {
    if (r.protectedBy !== null) continue;
    if (!configResolved) {
      configResult = findPackageConfigTimeout(filePath);
      configResolved = true;
    }
    if (!configResult) continue;
    if (configResult.determined) {
      r.protectedBy = 'config';
      r.form = 'config';
      r.value = configResult.value;
      r.configPath = configResult.configPath;
    } else {
      r.configStatus = 'unknown';
      r.configPath = configResult.configPath;
    }
  }
  return results;
}

/**
 * Refuse a vacuous run: a summary of all zeros reads exactly like a clean
 * pass, so an invocation that audited nothing must exit non-zero and say
 * what it expected instead. Three ways to audit nothing, each with its own
 * message because the remedy differs:
 *   - no file arguments at all (e.g. a caller whose target list expanded to
 *     nothing, or a future CI wiring with no default targets);
 *   - files were named, but not one of them holds a bare
 *     `describe`/`it`/`test` token — they are not vitest test files, so the
 *     paths are wrong;
 *   - a file DOES hold call sites, but this module could not parse them.
 *     That is a bug in this parser, not in the caller's paths, and saying
 *     "check your paths" there would send the reader hunting the wrong
 *     thing. Zero such files exist in this repo today (verified by running
 *     `findUnparsedCallSites` over all 1285 test files); the check exists so
 *     a future parser blind spot surfaces as a loud failure instead of a
 *     silently lower count.
 * ZERO `it`/`test` call sites is NOT by itself an error, and must not be:
 * a `describe`-wrapped shared-suite runner
 * (`describe('X conformance', () => runConformanceSuite(fixtures))`) is a
 * legitimate test file with no literal call site of its own, and this repo
 * has four of them. An earlier version of this guard failed exactly those
 * files. This is the same shape as `check-tla-chunk-await.mjs` refusing to
 * run against a missing dist and
 * `scripts/lib/server-bin-targets-parse.mjs`'s `refusing a vacuous pass`.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error(
      'vitest-timeout-audit: ERROR: no file arguments; refusing a vacuous pass.\n\n' +
      'This tool audits the files it is given -- it has no default target list,\n' +
      'so with no arguments it would print a summary of all zeros and exit 0,\n' +
      'which is indistinguishable from a clean report. Pass the test files to\n' +
      'audit:\n\n' +
      '    node scripts/lib/vitest-timeout-audit.mjs <file...>\n',
    );
    process.exit(1);
  }

  let protectedCount = 0;
  let configProtectedCount = 0;
  let configUnknownCount = 0;
  let unprotectedCount = 0;
  let keywordFiles = 0;
  const unparsedSites = [];
  for (const file of targets) {
    const source = readFileSync(file, 'utf8');
    if (hasTestKeywordToken(source)) keywordFiles += 1;
    for (const u of findUnparsedCallSites(source)) unparsedSites.push(`${file}:${u.line}: ${u.keyword}`);
    for (const r of auditFile(file, source)) {
      const shown = r.value ?? r.valueRef ?? '?';
      let status;
      if (r.protectedBy === 'config') {
        status = `protected (config testTimeout=${shown}, via ${r.configPath})`;
        configProtectedCount += 1;
      } else if (r.protectedBy) {
        status = `protected (${r.form}=${shown}, via ${r.protectedBy})`;
        protectedCount += 1;
      } else if (r.configStatus === 'unknown') {
        status = `UNKNOWN — package config sets testTimeout to an unresolvable value (${r.configPath})`;
        configUnknownCount += 1;
      } else {
        status = 'NO EXPLICIT TIMEOUT';
        unprotectedCount += 1;
      }
      console.log(`${file}:${r.line}: ${r.keyword}('${r.name}') — ${status}`);
    }
  }
  if (unparsedSites.length > 0) {
    console.error(
      `vitest-timeout-audit: ERROR: ${unparsedSites.length} call site(s) could not be `
      + 'parsed, so their timeout status is unknown and this run under-reports:\n\n'
      + unparsedSites.map((s) => `    ${s}`).join('\n')
      + '\n\nThe paths are fine -- this is a blind spot in this module\'s parser.\n'
      + 'Fix the parser (see the LIMITATIONS list at the top of this file) rather\n'
      + 'than the invocation.\n',
    );
    process.exit(1);
  }

  if (keywordFiles === 0) {
    console.error(
      `vitest-timeout-audit: ERROR: ${targets.length} file(s) named, but not one holds a `
      + '`describe`/`it`/`test` token; refusing a vacuous pass.\n\n'
      + 'A summary of all zeros here means the audit classified nothing, not that\n'
      + 'every test carries a timeout. Check that the paths point at vitest test\n'
      + 'files.\n',
    );
    process.exit(1);
  }

  console.log(
    `\nsummary: ${protectedCount} protected (own call/describe), `
    + `${configProtectedCount} config-protected, ${configUnknownCount} config-unknown, `
    + `${unprotectedCount} unprotected`,
  );
}
