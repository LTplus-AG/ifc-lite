#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: a `node:module` `register()` loader hook must not hinge on a bare
 * comparison against a TSCONFIG-ALIASED specifier — neither matching on `===`
 * nor passing through on `!==`, since the comparison's outcome is fixed either
 * way and one whole side of the branch is dead.
 *
 * THE TRAP, from two real incidents rather than a hypothetical:
 *
 * `module.registerHooks` (synchronous, in-thread) landed in Node 22.15.0, and
 * tsx feature-detects it. tsx's synchronous hook applies the tsconfig `paths`
 * mapping ITSELF and short-circuits, so on a newer 22 a specifier a `paths`
 * entry claims never reaches an async `register()` hook AT ALL. A hook whose
 * only arm is `specifier === '@/lib/collab/geometry-sync'` then never matches,
 * the target module is never wrapped, the gate the test parks on never fires,
 * and the file hangs until the runner's timeout.
 *
 * It is invisible on an older 22 and deterministic on CI, whose workflow pins
 * `node-version: 22` and so floats to the newest 22.x. `collab-session-race-hook.mjs`
 * hit it first and now carries a twenty-line comment about it;
 * `collab-hydrate-gate-hook.mjs` was written afterwards and walked into it
 * anyway. A comment did not prevent the second occurrence. Hence a gate.
 *
 * WHAT WAS MEASURED, and what an earlier revision of this file got wrong.
 *
 * That earlier revision justified itself with a broader claim: that after tsx's
 * sync path normalises a specifier to a `file://` URL, a bare equality can never
 * be true. THAT CLAIM IS FALSE, and the counter-evidence was already in CI.
 *
 *   - MEASURED, from CI: run 32532771710, job 96928471894, "Viewer tests
 *     (shard 3)" on `main`, Node v22.23.2. `CesiumOverlay — state writes after
 *     the init effect is torn down (#2685)` passes, with its 4 subtests. It can
 *     only pass if `vite-module-hooks-impl.mjs`'s `specifier === 'cesium'` arm
 *     fires: the component reaches the real bare specifier through
 *     `loadCesium()` → `import('cesium')` (`cesium-module.ts:24`), and the stub
 *     and the component share a module instance only when that arm matches. Had
 *     it missed, `waitFor()` would time out on the real `new Cesium.Viewer()`.
 *     So a bare-only arm is NOT automatically dead.
 *
 *   - MEASURED, locally, Node v22.23.2 + tsx 4.23.12, an instrumented async
 *     `register()` resolve hook logging every specifier it is handed:
 *
 *       bare package from node_modules   → hook called TWICE: once with a
 *                                          speculative `file:///…/<name>` that
 *                                          does not resolve, then again with the
 *                                          BARE specifier. Bare arm fires.
 *       workspace package, file-linked   → same; bare arm fires.
 *       virtual specifier (`~virt/…`)    → hook called once, bare. Arm fires.
 *       specifier claimed by `paths`     → hook NEVER called, in any form.
 *
 *   - THE CONTROL, which is what makes this causal rather than correlational:
 *     ONE specifier, `@lab/aliased`, spelled identically in both runs. With a
 *     `paths` entry claiming it, the async hook is never called and the real
 *     module loads. With that one tsconfig line removed and nothing else
 *     changed, the hook is called with the bare specifier and the stub applies.
 *     The `paths` entry is the cause, not the specifier's spelling.
 *
 * This also corrects the incident write-up. Both incidents were tsconfig
 * aliases, not "an alias and a workspace package": `@ifc-lite/collab` is an
 * EXACT key in `apps/viewer/tsconfig.json`, alongside the `@/*` wildcard that
 * claims `@/lib/collab/geometry-sync`. A genuinely workspace-resolved package
 * would not have hung — which is why trying to reproduce the failure with a
 * symlinked workspace package fails, as an earlier attempt found.
 *
 * THE RULE, and its exact scope: for every `resolve` hook found, this collects
 * the `if (...)` conditions in its body and, per condition, finds
 *
 *   - BARE targets  — a comparison against the specifier parameter whose other
 *                  side is a string with no URI scheme (`specifier === '@/x'`,
 *                  or `specifier === TARGET` where `TARGET` is a top-level
 *                  string const), collected with its SENSE: `===` and `!==` are
 *                  both bare targets and mean opposite things. A scheme-carrying
 *                  literal (`'node:fs'`, `'file://…'`) is not a bare target:
 *                  Node does not rewrite those.
 *   - URL-CAPABLE signals — the condition tests something that survives
 *                  normalisation: a `.url` property, a regex `.test(`,
 *                  `.endsWith(`, `.includes(`, `.match(`, a `file://` literal,
 *                  or `pathToFileURL` / `fileURLToPath`.
 *
 * The one measured fact is asymmetric: an equality against an alias-covered
 * specifier can never be TRUE. Everything else is boolean algebra over it. So
 * each condition is evaluated in BOTH directions — can it still be true, can it
 * still be false — and the flag depends on which side of the branch the hook's
 * real work sits on:
 *
 *   - CANNOT BE TRUE  ⇒ the consequent never runs. Flagged.
 *   - CANNOT BE FALSE ⇒ everything BELOW the `if` never runs, which matters only
 *                       when the branch is a bare pass-through (`return
 *                       nextResolve(specifier, context);`). Flagged then, and
 *                       only then.
 *
 * That second case is the `!==` spelling, and it is the commoner hook shape of
 * the two — "not my specifier, hand it on":
 *
 *   `if (specifier !== ALIASED) return nextResolve(…)`  everything below is dead
 *   `if (specifier !== ALIASED) { …wrap here… }`        nothing is dead
 *
 * Same operator, same specifier, opposite verdicts. The OPERATOR does not decide
 * and the CONSEQUENT does, which is why only the canonical pass-through shape is
 * flagged: an always-taken branch that does the wrapping itself is a working
 * hook, and a gate that reds working hooks gets disabled.
 *
 * Both directions are computed over the condition's `||`/`&&`/`!` STRUCTURE, not
 * by scanning it flat, because the connectives do opposite things to a dead
 * equality:
 *
 *   `specifier === ALIASED || resolved.url.includes(X)`   matches via the right
 *   `specifier === ALIASED && resolved.url.includes(X)`   can NEVER match
 *
 * A flat scan clears both. An OR can be true when EITHER side can and false only
 * when BOTH can; an AND is the mirror; `!` swaps the two. A leaf can never be
 * true exactly when it is an equality against an alias-covered specifier with
 * nothing URL-capable in it, and never false exactly when it is the matching
 * inequality. That keeps the `&&` self-wrap guard the fixed hooks use
 * (`(specifier === TARGET || <url test>) && !context.parentURL?.startsWith(MARKER)`)
 * green while flagging the `&&` form that cannot fire — and it retires a false
 * positive an earlier revision had on `!(specifier === ALIASED)`, which reads as
 * a dead equality flat but is the negation of one, so it always holds.
 *
 * The URL-capable escape is what keeps the remedy green. That remedy is the one
 * both fixed hooks use: call `nextResolve` first and match the resolved URL,
 * keeping the specifier arm as an `||` IN THE SAME CONDITION for the older
 * async-only loader path. Alias coverage and the URL escape are both
 * load-bearing and both pinned by tests: alias coverage is what separates the
 * two incidents from `cesium`, in the `!==` direction as well as the `===` one.
 *
 * Note the rule is PER ARM, not per hook. A dead alias arm is not excused by a
 * URL-capable arm sitting beside it, because the hook still hangs on that one
 * specifier whatever its other arms match. That is affordable only because the
 * alias predicate is narrow: `vite-module-hooks-impl.mjs`'s bare `cesium` arm
 * and its `~icons/` prefix arm — both verified working, per the CI run above —
 * are cleared on their own merits rather than by a per-hook escape hatch.
 *
 * WHAT THIS CANNOT SEE. It is a lexical check on one function body; it does not
 * load a hook, register it, or observe a single resolution. Specifically:
 *
 *   1. A BARE ARM ON A NON-ALIASED SPECIFIER IS NOT FLAGGED — the false negative
 *      this narrowing deliberately buys. Measured today (above), such an arm is
 *      reached and does fire, so flagging it would be a false positive on
 *      proven-good code. But "reached today, on tsx 4.23.12" is the whole of the
 *      evidence: if a later tsx resolves node_modules synchronously too, that
 *      arm becomes dead and this check will stay silent about it. The tsx
 *      version is not pinned by anything here.
 *   2. AN ALIAS THIS SCAN CANNOT SEE IS NOT FLAGGED. The alias table is the
 *      union of `paths` keys written LITERALLY in `tsconfig*.json` files under
 *      the search roots, plus the repo-root `tsconfig.json`. `extends` is not
 *      followed, so an alias inherited only through a base config is invisible,
 *      and a hook depending on it would be missed. That is latent rather than
 *      live here, but NOT because every alias is written in the file that uses
 *      it — it is not. `tsconfig.packages.json` extends the repo-root
 *      `tsconfig.json`, and every `packages/*` config extends that in turn, so
 *      most of the tree INHERITS the root's `paths` rather than declaring them.
 *      The table is complete anyway because the root config is read directly,
 *      and it is the only inherited `paths` table in the repo. A second base
 *      config carrying its own `paths` would open the hole for real.
 *      The table is also a repo-wide union rather than a per-consumer
 *      resolution, which errs the other way — toward flagging an arm that would
 *      in fact have matched.
 *   3. A DYNAMIC MATCH TARGET IS INVISIBLE. `specifier === buildTarget()`, or a
 *      target read from a config object or an env var, is classified as neither:
 *      the const map below only follows top-level string literals. Such a hook
 *      is neither flagged nor vouched for. A BACKTICK target falls here too:
 *      both the const map and the operand pattern accept `'` and `"` only, so
 *      `` specifier === `@/lib/x` `` reads as dynamic even though it is a
 *      constant. Interpolation is what makes a template literal genuinely
 *      dynamic and a no-substitution one indistinguishable at a glance, so this
 *      declines to guess rather than half-supporting the form.
 *   4. A URL-CAPABLE-LOOKING ARM MAY NOT ACTUALLY MATCH. `specifier.endsWith(
 *      '/geometry-sync')` is true of the alias and false of
 *      `file:///…/geometry-sync.ts`; a regex anchored on the alias spelling is
 *      the same shape. Both read as URL-capable here and would still hang. Only
 *      running the hook on a newer Node can tell those apart.
 *   5. IT DOES NOT KNOW HOW A HOOK IS REGISTERED. `module.registerHooks` is
 *      synchronous and DOES see the bare specifier, so an exact match is correct
 *      there. A hook file written for that API and for nothing else would be
 *      flagged by this check, wrongly. No such file exists in the repo today.
 *   6. IT SEES ONLY `if (...)`. A hook that matches inside a ternary, a `switch`,
 *      or a bare `return a || b` has no `if` condition to classify; that is a
 *      hard failure ("no match condition") rather than a pass, so the shape is
 *      fail-closed but not understood. A ternary INSIDE an `if` condition is a
 *      different matter and is seen, as one leaf.
 *   7. AN ALWAYS-TRUE GUARD IS FLAGGED ONLY IN ITS PASS-THROUGH SHAPE. The
 *      `!==` rule fires when the branch is exactly `return nextResolve(specifier,
 *      context);`, braces optional. `if (specifier !== ALIASED) return real;`,
 *      or a branch that logs before passing on, or one that returns a
 *      pre-resolved result, is NOT flagged even though everything below it is
 *      equally dead. That is deliberate: the pass-through is the shape whose
 *      deadness is unambiguous from the text alone, and over-flagging here reds
 *      a working hook — the failure mode that gets a gate deleted. The narrower
 *      rule is the affordable one.
 *   8. `!x === y` IS NOT MODELLED. A leading `!` is read as negating the whole
 *      operand only when no comparison follows it at the top level, since
 *      `!specifier === TARGET` actually parses as `(!specifier) === TARGET`.
 *      That shape falls through to the flat leaf classifier, which is what the
 *      previous revision did with every negation. No hook in the repo writes it.
 *
 * Closing gaps 1 and 4 needs a RUNTIME probe — register the hook on the pinned
 * Node and assert the stub applied — not a lexical one. This file is not that,
 * and does not claim to be.
 *
 * Every step fails closed. A missing root, a search root that does not exist,
 * an unreadable file, zero files scanned, zero hooks found, an empty or
 * unparseable alias table, a `resolve` whose body cannot be delimited, or a
 * `resolve` with no locatable condition is an error with a named reason and a
 * non-zero exit. The success line prints the counts — including how many bare
 * arms were alias-covered and how many alias keys were found — so a zero-measure
 * green is visible in the line itself.
 *
 * Run: node scripts/check-loader-hook-specifier-match.mjs [--root <dir>]
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArgIndex = process.argv.indexOf('--root');
const ROOT =
  rootArgIndex !== -1 && process.argv[rootArgIndex + 1]
    ? process.argv[rootArgIndex + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where a loader hook can live. At least one must exist, or the scan is not the scan. */
const SEARCH_ROOTS = ['apps', 'packages', 'scripts'];

const SOURCE_EXT = new Set(['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts']);

/** `tsconfig.json`, `tsconfig.test.json`, … — where the `paths` aliases live. */
const TSCONFIG_NAME = /^tsconfig(?:\..+)?\.json$/;

const SKIP_DIR = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  'out',
  '.next',
  '.turbo',
  'pkg',
]);

/**
 * The marker that says "this file implements loader hooks": the third parameter
 * Node passes to a `resolve` hook. Naming that parameter is how a hook is a
 * hook, so this is structural rather than a remembered filename pattern — a hook
 * added under a new name, in a new package, is covered on the day it is written.
 */
const HOOK_MARKER = 'nextResolve';

/**
 * The marker must appear as real CODE — as a parameter or a call — not merely as
 * text. Built with `new RegExp` rather than written as a literal so this file's
 * own source does not contain the pattern it searches for; the same reason the
 * scan runs over a string-blanked view. Without both, this guard reports itself
 * and every test that embeds a hook's source as a fixture.
 */
const HOOK_USE = new RegExp(String.raw`\b${HOOK_MARKER}\b\s*[(,)]`);

/** Errors are collected so one run reports everything, then exits once. */
const failures = [];
function fail(lines) {
  failures.push(lines);
}

/**
 * Blank COMMENTS to spaces (newlines kept, so line numbers survive) while
 * leaving strings, template literals and regex literals verbatim — the literal
 * text of a match target is the thing being classified, so it cannot be blanked
 * the way sibling guards blank it.
 *
 * Regex literals are tracked because their bodies can contain `//` and slash-star
 * sequences that would otherwise open a phantom comment and swallow real code. A
 * `/` opens a regex only when the previous significant character cannot end an
 * expression — the standard heuristic, and correct for every hook in this repo.
 */
function blankComments(source) {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  // Stack of open template literals; each `${...}` entry counts brace depth so
  // real code braces do not close the interpolation early.
  const templates = [];
  const inQuasi = () => templates.length > 0 && templates[templates.length - 1].mode === 'quasi';
  const canPrecedeRegex = () => !/[A-Za-z0-9_$)\]]/.test(prevSignificant);

  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);

    if (inQuasi()) {
      if (two === '${') {
        templates.push({ mode: 'code', depth: 0 });
        out += two;
        i += 2;
        continue;
      }
      if (ch === '`') {
        templates.pop();
        out += ch;
        i += 1;
        prevSignificant = '`';
        continue;
      }
      if (ch === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      out += quote;
      i += 1;
      prevSignificant = quote;
      continue;
    }
    if (ch === '`') {
      templates.push({ mode: 'quasi' });
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && canPrecedeRegex()) {
      // Regex literal: copy through to the unescaped closing `/`, character
      // classes included (a `/` inside `[...]` does not close it).
      out += ch;
      i += 1;
      let inClass = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === '\n') break; // Not a regex after all; bail rather than run to EOF.
        out += c;
        i += 1;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      prevSignificant = '/';
      continue;
    }

    if (templates.length > 0) {
      const top = templates[templates.length - 1];
      if (ch === '{') {
        top.depth += 1;
      } else if (ch === '}') {
        if (top.depth > 0) {
          top.depth -= 1;
        } else {
          templates.pop();
          out += ch;
          i += 1;
          continue;
        }
      }
    }

    out += ch;
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return out;
}

/**
 * Blank the CONTENTS of every string and template quasi in an
 * already-comment-blanked source, keeping the delimiters and every offset. This
 * is the view used to decide "is this a hook file", to locate `resolve`, and to
 * balance its braces — a fixture that embeds a hook's source as a string literal
 * is data, not a hook, and a `{` inside a string must not shift the body span.
 * Classification still reads the string-intact view, because the match target's
 * literal text is the thing being classified.
 */
function blankStrings(clean) {
  let out = '';
  let i = 0;
  const templates = [];
  const inQuasi = () => templates.length > 0 && templates[templates.length - 1].mode === 'quasi';
  let prevSignificant = '';
  const canPrecedeRegex = () => !/[A-Za-z0-9_$)\]]/.test(prevSignificant);

  while (i < clean.length) {
    const ch = clean[i];
    if (inQuasi()) {
      if (clean.slice(i, i + 2) === '${') {
        templates.push({ mode: 'code', depth: 0 });
        out += '${';
        i += 2;
        continue;
      }
      if (ch === '`') {
        templates.pop();
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      out += ch;
      i += 1;
      while (i < clean.length && clean[i] !== ch) {
        if (clean[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += clean[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += clean[i] ?? '';
      i += 1;
      prevSignificant = ch;
      continue;
    }
    if (ch === '`') {
      templates.push({ mode: 'quasi' });
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && canPrecedeRegex()) {
      // Regex literals are copied through, exactly as `blankComments` left them.
      out += ch;
      i += 1;
      let inClass = false;
      while (i < clean.length) {
        const c = clean[i];
        if (c === '\\') {
          out += clean.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === '\n') break;
        out += c;
        i += 1;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      prevSignificant = '/';
      continue;
    }
    if (templates.length > 0) {
      const top = templates[templates.length - 1];
      if (ch === '{') {
        top.depth += 1;
      } else if (ch === '}') {
        if (top.depth > 0) {
          top.depth -= 1;
        } else {
          templates.pop();
          out += ch;
          i += 1;
          continue;
        }
      }
    }
    out += ch;
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return out;
}

/**
 * Every `tsconfig*.json` seen during the walk. Populated as a side effect of
 * `collectFiles` so the tree is walked once.
 */
const tsconfigFiles = [];

/** Every JS/TS-family source file under the search roots. Failures are recorded, not thrown. */
function collectFiles() {
  const present = SEARCH_ROOTS.filter((r) => existsSync(join(ROOT, r)) && statSync(join(ROOT, r)).isDirectory());
  if (present.length === 0) {
    fail([
      `search roots missing: none of ${SEARCH_ROOTS.map((r) => `\`${r}/\``).join(', ')} exist under ${ROOT}.`,
      '',
      'Nothing was scanned, so "no bare-specifier hook" would be vacuously true.',
      'Point --root at the repo root, or re-point SEARCH_ROOTS at whatever replaced them.',
    ]);
    return [];
  }
  const files = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      fail([
        `unreadable directory ${relative(ROOT, abs) || abs}: ${err.message}`,
        '',
        'A directory that cannot be listed is a hole in the scan, not an empty one.',
      ]);
      return;
    }
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name)) continue;
        walk(child);
      } else if (entry.isFile() && SOURCE_EXT.has(extname(entry.name))) {
        files.push(child);
      } else if (entry.isFile() && TSCONFIG_NAME.test(entry.name)) {
        tsconfigFiles.push(child);
      }
    }
  };
  for (const r of present) walk(join(ROOT, r));
  if (files.length === 0) {
    fail([
      `zero source files under ${present.map((r) => `\`${r}/\``).join(', ')} in ${ROOT}.`,
      '',
      'The extension list stopped matching, or the tree is empty. Either way nothing',
      'was scanned and this guard would pass forever.',
    ]);
  }
  return files;
}

/**
 * Every `compilerOptions.paths` KEY declared anywhere in the tree, plus the
 * repo-root `tsconfig.json` if there is one. This is the alias table the
 * measured mechanism turns on: a specifier a `paths` entry claims is resolved
 * by tsx's synchronous hook and never reaches the async chain at all.
 *
 * Deliberately a repo-wide UNION rather than a per-consumer resolution. A hook
 * in `apps/viewer` is checked against `packages/*`'s aliases too, which can only
 * over-approximate — the safe direction for a guard, since the cost is a
 * flagged arm that would in fact have matched, not a missed hang. `extends` is
 * not followed: only `paths` written literally in a file is read. That is enough
 * here NOT because every alias is declared where it is used — `tsconfig.packages.json`
 * extends the repo-root config and every `packages/*` config extends that — but
 * because the root is the only `paths` table anything inherits, and it is read
 * directly above. An alias reachable ONLY through some other `extends` chain
 * would be invisible.
 */
function collectAliasKeys() {
  const rootTsconfig = join(ROOT, 'tsconfig.json');
  const candidates = existsSync(rootTsconfig) ? [rootTsconfig, ...tsconfigFiles] : [...tsconfigFiles];
  const keys = new Set();
  for (const abs of candidates) {
    const rel = relative(ROOT, abs) || abs;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      fail([
        `unreadable tsconfig ${rel}: ${err.message}`,
        '',
        'The alias table decides which bare arms are dead. A tsconfig that cannot be',
        'read is a hole in it, so this fails rather than under-reporting.',
      ]);
      continue;
    }
    // `tsconfig.json` is JSONC by specification: strip line comments and
    // trailing commas before parsing. Block comments are left to `JSON.parse`
    // to reject loudly, since none of this repo's tsconfigs use them.
    const stripped = text
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      fail([
        `unparseable tsconfig ${rel}: ${err.message}`,
        '',
        'The alias table decides which bare arms are dead, so a tsconfig this guard',
        'cannot read is an error rather than an empty contribution. Teach the stripper',
        'the syntax this file uses.',
      ]);
      continue;
    }
    const paths = parsed?.compilerOptions?.paths;
    if (paths && typeof paths === 'object') for (const key of Object.keys(paths)) keys.add(key);
  }
  if (keys.size === 0 && failures.length === 0) {
    fail([
      `no tsconfig \`paths\` aliases found under ${SEARCH_ROOTS.map((r) => `\`${r}/\``).join(', ')} in ${ROOT}.`,
      '',
      `${candidates.length} tsconfig file(s) were read. The alias table is what makes this`,
      'guard fire at all; an empty one would clear every bare arm in the repo. Either',
      'the aliases moved, or the scan no longer reaches them.',
    ]);
  }
  return keys;
}

/**
 * Does a tsconfig `paths` entry claim this specifier? Exact keys match exactly;
 * a `X/*` key matches anything under `X/`. Both spellings are load-bearing:
 * `@ifc-lite/collab` is an exact key and `@/lib/collab/geometry-sync` matches
 * the `@/*` wildcard, and those are the two historical incidents.
 */
function aliasCovers(aliasKeys, specifier) {
  for (const key of aliasKeys) {
    const star = key.indexOf('*');
    if (star === -1) {
      if (key === specifier) return key;
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      return key;
    }
  }
  return null;
}

/** Delimit the brace-balanced body that starts at the `{` at or after `from`. */
function bodyAt(clean, from) {
  const open = clean.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === '{') depth += 1;
    else if (clean[i] === '}') {
      depth -= 1;
      if (depth === 0) return { start: open, end: i + 1, text: clean.slice(open, i + 1) };
    }
  }
  return null;
}

/** `function resolve(a, b, c) {` and `const resolve = async (a, b, c) => {`, exported or not. */
const RESOLVE_DECL =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+resolve\s*\(([^)]*)\)\s*\{|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+resolve\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*\{/g;

/** Top-level `const NAME = 'literal';` — how `specifier === TARGET` is resolved to text. */
function stringConsts(clean) {
  const map = new Map();
  const re = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])((?:\\.|(?!\2).)*)\2\s*;/g;
  for (const m of clean.matchAll(re)) map.set(m[1], m[3]);
  return map;
}

/**
 * The statement the `if` guards, starting at `from`: a brace-balanced block, or
 * everything up to the first depth-zero `;`. Read from the string-INTACT view,
 * so a `;` inside a string literal can truncate it — which only ever makes the
 * text fail `isPassThrough` below, i.e. errs toward not flagging.
 */
function consequentAt(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] === '{') {
    let depth = 0;
    for (let j = i; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
    return text.slice(i);
  }
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return text.slice(i, j + 1);
  }
  return text.slice(i);
}

/**
 * Every `if (...)` inside a body: its condition, and the statement it guards.
 *
 * The consequent is needed because a NEGATED equality's sense depends on what
 * the branch does, not on the operator — see `isPassThrough`.
 */
function ifConditions(bodyText) {
  const conditions = [];
  for (const m of bodyText.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < bodyText.length; i += 1) {
      if (bodyText[i] === '(') depth += 1;
      else if (bodyText[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          conditions.push({
            condition: bodyText.slice(open + 1, i),
            consequent: consequentAt(bodyText, i + 1),
          });
          break;
        }
      }
    }
  }
  return conditions;
}

/**
 * Is this consequent a bare PASS-THROUGH — `return nextResolve(specifier,
 * context);`, block-wrapped or not, and nothing else?
 *
 * This is what makes an early return an early return. `if (specifier !==
 * ALIASED) return nextResolve(...)` hands every OTHER specifier straight on, so
 * the hook's real work sits BELOW the guard and runs only when the specifier IS
 * the aliased one — which never happens. `if (specifier !== ALIASED) { …wrap
 * here… }` puts the work on the branch that always runs and is not dead at all.
 * One operator, opposite verdicts; the consequent is what separates them.
 *
 * Built from `HOOK_MARKER` rather than written out, for the same reason
 * `HOOK_USE` is: this file must not contain the pattern it searches for.
 */
const PASS_THROUGH = new RegExp(
  String.raw`^\{?\s*return\s+(?:await\s+)?${HOOK_MARKER}\s*\([^()]*\)\s*;?\s*\}?$`,
);
function isPassThrough(consequent) {
  return PASS_THROUGH.test(consequent.replace(/\s+/g, ' ').trim());
}

/** A literal carrying a URI scheme (`node:fs`, `file://…`) is not rewritten by Node. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const URL_CAPABLE_SIGNALS = [
  { re: /\.url\b/, why: 'tests a resolved `.url`' },
  { re: /\.test\s*\(/, why: 'tests a regex' },
  { re: /\.endsWith\s*\(/, why: 'tests a suffix' },
  { re: /\.includes\s*\(/, why: 'tests a substring' },
  { re: /\.match\s*\(/, why: 'tests a regex' },
  { re: /file:\/\//, why: 'names a `file://` URL' },
  { re: /\b(?:pathToFileURL|fileURLToPath)\s*\(/, why: 'converts between path and URL' },
];

/**
 * Classify one `if (...)` condition: the bare-only match targets it contains,
 * split by the SENSE of the comparison, and the URL-capable signals it carries.
 *
 * `bare` holds equality targets (`specifier === ALIASED`), `bareNegated` holds
 * inequality targets (`specifier !== ALIASED`). The two are collected apart
 * because the mechanism makes an aliased equality permanently FALSE, which makes
 * the matching inequality permanently TRUE — dead in opposite directions, and
 * `analyze` needs to know which.
 *
 * The two operator patterns are disjoint by construction: `===?` cannot match at
 * the `!` of `!==`, and `!==?` requires it.
 */
function classifyCondition(condition, specifierParam, consts) {
  const bare = [];
  const bareNegated = [];
  const ident = specifierParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const operand = String.raw`(['"]((?:\\.|[^'"])*)['"]|[A-Za-z_$][\w$]*)`;
  const forms = [
    { into: bare, re: new RegExp(String.raw`\b${ident}\b\s*===?\s*${operand}`, 'g') },
    { into: bare, re: new RegExp(String.raw`${operand}\s*===?\s*\b${ident}\b`, 'g') },
    { into: bareNegated, re: new RegExp(String.raw`\b${ident}\b\s*!==?\s*${operand}`, 'g') },
    { into: bareNegated, re: new RegExp(String.raw`${operand}\s*!==?\s*\b${ident}\b`, 'g') },
  ];
  for (const { into, re } of forms) {
    for (const m of condition.matchAll(re)) {
      const raw = m[1];
      const text = raw.startsWith("'") || raw.startsWith('"') ? m[2] : consts.get(raw);
      // An identifier that is not a known top-level string const is a dynamic
      // target: neither flagged nor vouched for (limitation 2 in the header).
      if (text === undefined) continue;
      if (HAS_SCHEME.test(text)) continue;
      into.push(text);
    }
  }
  const urlSignals = URL_CAPABLE_SIGNALS.filter((s) => s.re.test(condition)).map((s) => s.why);
  return { bare, bareNegated, urlSignals };
}

/**
 * Split `text` at its DEPTH-ZERO occurrences of `op` (`||` or `&&`), ignoring
 * anything inside parentheses, brackets, braces or a string/template literal.
 * Returns a single-element array when the operator does not appear at the top
 * level, so callers can treat "no split" and "leaf" identically.
 */
function splitTopLevel(text, op) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; continue; }
    if (depth === 0 && text.startsWith(op, i)) {
      parts.push(text.slice(start, i));
      i += op.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** `(...)` wrapping the WHOLE expression, so it can be recursed into. */
function unwrapParens(text) {
  let t = text.trim();
  while (t.startsWith('(') && t.endsWith(')') && splitTopLevel(t, '||').length === 1 && splitTopLevel(t, '&&').length === 1) {
    const inner = t.slice(1, -1).trim();
    // Only strip when the parens really are the outermost pair, i.e. the inner
    // text is itself balanced — `(a) && (b)` must not become `a) && (b`.
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth < 0) { balanced = false; break; } }
    }
    if (!balanced || depth !== 0) break;
    t = inner;
  }
  return t;
}

/** Does a top-level comparison operator appear in `text`? */
function hasTopLevelComparison(text) {
  return splitTopLevel(text, '==').length > 1 || splitTopLevel(text, '!=').length > 1;
}

/**
 * Can this condition still be TRUE, can it still be FALSE, and which
 * alias-covered targets are responsible?
 *
 * BOTH directions are needed, because a hook can park its real work on either
 * side of the branch and the mechanism kills only one of them:
 *
 *   `if (specifier === ALIASED) …`                the consequent never runs
 *   `if (specifier !== ALIASED) return next…`     everything BELOW never runs
 *
 * The equality against an alias-covered specifier is the single asymmetric fact
 * — measured, per the header: it can never hold. Everything else follows from
 * ordinary boolean algebra, evaluated over the condition's STRUCTURE rather than
 * as one flat string, because `||` and `&&` do opposite things to a dead arm:
 *
 *   `specifier === ALIASED || resolved.url.includes(X)`  matches via the right
 *   `specifier === ALIASED && resolved.url.includes(X)`  can NEVER match
 *
 * A flat "does this condition mention anything URL-capable" test clears both,
 * which lets an `&&` chain hide exactly the dead arm this guard exists to find.
 * An OR can be true when EITHER side can and false only when BOTH can; an AND is
 * the mirror; `!` swaps the two. The `||` remedy both fixed hooks use therefore
 * stays green — its left half can never be true, its right half can — and
 * `specifier === 'cesium' && …` stays green too, because `cesium` is not
 * alias-covered and so is not dead in either direction.
 *
 * Deciding the FALSE direction is also what retires an old false positive:
 * `!(specifier === ALIASED)` reads as a dead equality to a flat scan, but the
 * negation of something that can never be true can always be true, so it is
 * live — which it is.
 */
function analyze(condition, specifierParam, consts, aliasKeys) {
  const text = unwrapParens(condition);
  const UNKNOWN = { canBeTrue: true, canBeFalse: true, targets: [] };

  const ors = splitTopLevel(text, '||');
  if (ors.length > 1) {
    const parts = ors.map((p) => analyze(p, specifierParam, consts, aliasKeys));
    return {
      canBeTrue: parts.some((p) => p.canBeTrue),
      canBeFalse: parts.every((p) => p.canBeFalse),
      targets: parts.flatMap((p) => p.targets),
    };
  }

  const ands = splitTopLevel(text, '&&');
  if (ands.length > 1) {
    const parts = ands.map((p) => analyze(p, specifierParam, consts, aliasKeys));
    return {
      canBeTrue: parts.every((p) => p.canBeTrue),
      canBeFalse: parts.some((p) => p.canBeFalse),
      targets: parts.flatMap((p) => p.targets),
    };
  }

  // A leading `!` negates the WHOLE operand only when no comparison follows it
  // at the top level — `!x === y` parses as `(!x) === y`, so that shape is left
  // to the leaf classifier rather than mis-negated.
  if (text.startsWith('!') && !hasTopLevelComparison(text.slice(1))) {
    const inner = analyze(text.slice(1), specifierParam, consts, aliasKeys);
    return { canBeTrue: inner.canBeFalse, canBeFalse: inner.canBeTrue, targets: inner.targets };
  }

  const { bare, bareNegated, urlSignals } = classifyCondition(text, specifierParam, consts);
  // A leaf can carry both an equality and something URL-capable — through a
  // ternary or a nested call, the only shapes the `||`/`&&` split leaves whole.
  // `context.parentURL ? real.url.endsWith(X) : specifier === ALIASED` is live
  // via its consequent, so the URL signal clears the leaf.
  if (urlSignals.length > 0) return UNKNOWN;
  const covered = (targets) =>
    targets.map((target) => ({ target, key: aliasCovers(aliasKeys, target) })).filter((t) => t.key !== null);
  const deadEqualities = covered(bare);
  const deadInequalities = covered(bareNegated);
  // Both senses in one leaf means the leaf is some expression this does not
  // model. Claim nothing rather than pick one.
  if (deadEqualities.length > 0 && deadInequalities.length > 0) return UNKNOWN;
  if (deadEqualities.length > 0) return { canBeTrue: false, canBeFalse: true, targets: deadEqualities };
  if (deadInequalities.length > 0) return { canBeTrue: true, canBeFalse: false, targets: deadInequalities };
  return UNKNOWN;
}

const files = collectFiles();
const aliasKeys = collectAliasKeys();

let hookFileCount = 0;
let resolveHookCount = 0;
let conditionCount = 0;
let bareArmCount = 0;
let aliasArmCount = 0;
let urlArmCount = 0;
const flagged = [];

for (const abs of files) {
  const rel = relative(ROOT, abs);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    fail([
      `unreadable file ${rel}: ${err.message}`,
      '',
      'A file that cannot be read is a hole in the scan. Fix the file or the scan;',
      'skipping it silently is how this guard would stop guarding.',
    ]);
    continue;
  }
  if (!raw.includes(HOOK_MARKER)) continue;
  const clean = blankComments(raw);
  const code = blankStrings(clean);
  // The marker in a comment or a string fixture is text, not a hook.
  if (!HOOK_USE.test(code)) continue;
  hookFileCount += 1;

  const consts = stringConsts(clean);
  const lineOf = (offset) => raw.slice(0, offset).split('\n').length;

  RESOLVE_DECL.lastIndex = 0;
  const decls = [...code.matchAll(RESOLVE_DECL)];
  if (decls.length === 0) {
    fail([
      `${rel}: mentions \`${HOOK_MARKER}\` but no \`resolve\` hook could be located.`,
      '',
      'This file looks like a loader hook and could not be classified, so it was',
      'neither checked nor cleared. Re-point RESOLVE_DECL at the declaration form',
      'this file uses.',
    ]);
    continue;
  }

  for (const decl of decls) {
    // `RESOLVE_DECL` opens with `(?:^|\n)\s*`, which swallows any blank lines
    // above the declaration, so report the `resolve` keyword's own line rather
    // than the match start.
    const declOffset = decl.index + Math.max(decl[0].indexOf('resolve'), 0);
    const params = (decl[1] ?? decl[2] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const specifierParam = params[0]?.replace(/[:=].*$/, '').trim();
    if (!specifierParam || !/^[A-Za-z_$][\w$]*$/.test(specifierParam)) {
      fail([
        `${rel}:${lineOf(declOffset)}: \`resolve\` has no usable first parameter (got \`${params[0] ?? ''}\`).`,
        '',
        'The specifier parameter is what this guard classifies. Without a name for it,',
        'nothing was checked.',
      ]);
      continue;
    }
    // Balance braces on the string-blanked view, then read the span back off the
    // string-intact one: the two are offset-identical by construction.
    const span = bodyAt(code, decl.index + decl[0].length - 1);
    const body = span ? { ...span, text: clean.slice(span.start, span.end) } : null;
    if (!body) {
      fail([
        `${rel}:${lineOf(declOffset)}: unbalanced braces in \`resolve\`; its body could not be delimited.`,
        '',
        'Nothing was checked for this hook.',
      ]);
      continue;
    }
    resolveHookCount += 1;

    const conditions = ifConditions(body.text);
    if (conditions.length === 0) {
      fail([
        `${rel}:${lineOf(declOffset)}: \`resolve\` has no \`if (...)\` match condition.`,
        '',
        'This guard classifies `if` conditions. A hook that matches in a ternary, a',
        '`switch`, or a bare `return a || b` cannot be classified, so it fails closed',
        'rather than passing unexamined. Rewrite the match as an `if`, or teach this',
        'guard the shape.',
      ]);
      continue;
    }
    conditionCount += conditions.length;

    // Per ARM, not per hook. An arm is dead when its target is alias-covered and
    // nothing beside it in the same BRANCH of the condition survives
    // normalisation — so a hook stays flagged even if a SIBLING arm is
    // URL-capable, and a bare arm on a non-aliased specifier (`cesium`) stays
    // green because it is not dead. `conditionLiveness` walks the condition's
    // `||`/`&&` structure rather than scanning it flat, so an `&&` cannot
    // launder a dead equality past a URL-capable conjunct it is joined to.
    const deadTargets = [];
    const deadBelowGuard = [];
    for (const { condition, consequent } of conditions) {
      const { bare, bareNegated, urlSignals } = classifyCondition(condition, specifierParam, consts);
      bareArmCount += bare.length + bareNegated.length;
      urlArmCount += urlSignals.length;
      for (const target of [...bare, ...bareNegated]) {
        if (aliasCovers(aliasKeys, target) !== null) aliasArmCount += 1;
      }
      const verdict = analyze(condition, specifierParam, consts, aliasKeys);
      if (!verdict.canBeTrue) {
        // The consequent can never run.
        deadTargets.push(...verdict.targets);
      } else if (!verdict.canBeFalse && isPassThrough(consequent)) {
        // The condition always holds and the branch hands the specifier
        // straight on, so the hook's real work — everything below this guard —
        // is what can never run. Only the PASS-THROUGH shape is flagged: an
        // always-taken branch that does the wrapping itself is live.
        deadBelowGuard.push(...verdict.targets);
      }
    }

    if (deadTargets.length > 0) {
      flagged.push({ rel, line: lineOf(declOffset), kind: 'equality', targets: deadTargets });
    }
    if (deadBelowGuard.length > 0) {
      flagged.push({ rel, line: lineOf(declOffset), kind: 'guard', targets: deadBelowGuard });
    }
  }
}

if (hookFileCount === 0 && failures.length === 0) {
  fail([
    `no loader hooks found: nothing under ${SEARCH_ROOTS.map((r) => `\`${r}/\``).join(', ')} mentions \`${HOOK_MARKER}\`.`,
    '',
    `${files.length} file(s) were scanned. Either every loader hook was deleted, or the`,
    'marker this guard keys on changed. A guard that finds nothing to guard passes',
    'forever, so this is an error.',
  ]);
}

for (const hit of flagged) {
  const guard = hit.kind === 'guard';
  fail([
    guard
      ? `${hit.rel}:${hit.line}: \`resolve\` passes everything through on an inequality that always holds.`
      : `${hit.rel}:${hit.line}: \`resolve\` matches an aliased specifier by equality only.`,
    '',
    ...hit.targets.map((t) =>
      guard
        ? `  returns early unless the specifier is \`${t.target}\`, which tsconfig \`paths\` claims via \`${t.key}\` — so it never is, and everything below the guard is dead`
        : `  matches only \`${t.target}\`, which tsconfig \`paths\` claims via \`${t.key}\``,
    ),
    '',
    `\`module.registerHooks\` (synchronous, in-thread) landed in Node 22.15.0 and tsx
feature-detects it. tsx's synchronous hook applies the tsconfig \`paths\` mapping
ITSELF and short-circuits, so on a newer 22 an aliased specifier never reaches
this async \`register()\` hook in any form — the equality cannot hold, the target
module is never wrapped, and whatever the hook exists to gate never fires. A
hang until the runner's timeout, on CI only, because the workflow pins
\`node-version: 22\` and floats to the newest 22.x.

Measured on Node v22.23.2 with tsx 4.23.12: a specifier covered by a \`paths\`
entry produces ZERO calls into the async resolve hook, while the same specifier
spelled identically with that \`paths\` entry removed reaches it and matches.
That control is what distinguishes this from a bare arm on a non-aliased
specifier, which is NOT dead — see the header.

This has happened twice: \`collab-session-race-hook.mjs\` (\`@ifc-lite/collab\`, an
exact \`paths\` key) and \`collab-hydrate-gate-hook.mjs\`
(\`@/lib/collab/geometry-sync\`, via the \`@/*\` wildcard). Both fixes are the same:
call \`nextResolve\` first and match the RESOLVED url, keeping the specifier arm
as an \`||\` for the older async-only loader path. Guard on \`context.parentURL\` if
the hook's replacement module imports the real url, or it will wrap itself
forever.`,
  ]);
}

if (failures.length > 0) {
  for (const lines of failures) console.error(`\n${lines.join('\n')}`);
  console.error('');
  process.exit(1);
}

console.log(
  `check-loader-hook-specifier-match: OK (${files.length} files scanned, ${hookFileCount} loader hook file(s), ` +
    `${resolveHookCount} resolve hook(s), ${conditionCount} condition(s), ` +
    `${bareArmCount} bare-specifier arm(s), ${aliasArmCount} alias-covered, ` +
    `${aliasKeys.size} alias key(s), ${urlArmCount} url-capable signal(s))`,
);
