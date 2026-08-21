#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Report which `it(...)` / `test(...)` calls carry an explicit vitest timeout.
 *
 * WHY THIS IS A SCRIPT AND NOT A GREP. There are three spellings of a per-test
 * timeout in this repo, and a search for any one reports the other two as
 * ABSENT:
 *
 *   it('x', async () => { ... }, 30_000);      trailing argument
 *   it('x', { timeout: 30_000 }, async () => …) options object
 *   it(                                        multi-line trailing
 *     'x',
 *     async () => { ... },
 *     30_000,
 *   );
 *
 * That is not hypothetical. While fixing #2947 the mistake was made in both
 * directions in one session: a grep for the trailing form scored
 * `blocked-source-equivalence.test.ts` as unprotected when it carries the
 * options form, and a review that caught that error then reported
 * `overlay-effective-model.test.ts` as unprotected when it carries the
 * multi-line form. Both mistakes render identically — a protected file looks
 * unguarded — so neither is self-correcting.
 *
 * Only matching the call's own parentheses gets a true answer, which is what
 * this does.
 *
 * Usage:
 *   node scripts/audit-test-timeouts.mjs                 # all test files
 *   node scripts/audit-test-timeouts.mjs --untimed-only  # just the gaps
 *   node scripts/audit-test-timeouts.mjs packages/parser # scope to a subtree
 *
 * This reports; it does not gate. A timeout is only warranted when a test is
 * genuinely slow, and this script cannot know that — pair it with the per-test
 * durations in a CI run's reporter output.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const untimedOnly = args.includes('--untimed-only');
const roots = args.filter((a) => !a.startsWith('--'));

const SKIP = new Set(['node_modules', 'dist', 'target', '.git', 'pkg', '.turbo', 'coverage']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.test\.[cm]?[jt]sx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Blank out comments and string/template bodies, preserving length and newlines.
 *
 * Scanning the raw source does not work: an apostrophe in a COMMENT ("the
 * worker doesn't come back") reads as a string opener, the scan runs to EOF,
 * and the call is silently dropped from every count. That bug was in the first
 * version of this script and hid 449 of 13016 tests — the audit reporting a
 * clean sheet because it could not see them, which is the same
 * absence-reads-as-success shape the audit exists to break.
 */
function blankNonCode(src) {
  // Collect ranges to blank, then rebuild ONCE. An earlier version did
  // `src.split('')` and mutated the char array, which allocates a string per
  // character of every file: 5.5 minutes and heap exhaustion on packages/.
  const ranges = [];
  let i = 0;
  let prev = ''; // last significant character, for regex-vs-division
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const s0 = i;
      while (i < src.length && src[i] !== '\n') i++;
      ranges.push([s0, i]);
    } else if (c === '/' && d === '*') {
      const s0 = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      ranges.push([s0, i]);
    } else if (c === "'" || c === '"' || c === '`') {
      const s0 = i + 1; // keep the quotes so name extraction still works
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      ranges.push([s0, Math.min(i, src.length)]);
      i++;
      prev = c;
    } else if (c === '/' && REGEX_PRECEDES.has(prev)) {
      // A regex literal, not division. Its body can hold quotes and `//`, and
      // an unhandled apostrophe there is the same defect as the comment one:
      // `const re = /it's fine/;` used to run the scan to EOF.
      const s0 = i + 1;
      i++;
      while (i < src.length && src[i] !== '/' && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') {
          while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
            if (src[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      ranges.push([s0, Math.min(i, src.length)]);
      i++;
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  if (!ranges.length) return src;
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    out += src.slice(pos, a);
    out += src.slice(a, b).replace(/[^\n]/g, ' ');
    pos = b;
  }
  return out + src.slice(pos);
}

/**
 * Characters after which a `/` opens a REGEX rather than division. Standard
 * lexer heuristic; ambiguous only after an identifier or `)`, where division
 * is the correct reading anyway.
 */
const REGEX_PRECEDES = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Index of the `)` closing the call opened at `open`, or -1. */
function matchParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a call slice `( a, b, c )` into its TOP-LEVEL argument texts.
 *
 * Needed because a tail regex cannot tell an argument from something inside
 * one. `it('x', () => ready, 30_000)` has no `}` before the timeout comma, so
 * a `[)}\]]\s*,\s*\d+\s*\)$` pattern reports it untimed; and any
 * `{ timeout: N }` deeper in the body looks like an argument to a pattern that
 * only sees text.
 */
function splitArgs(call) {
  const inner = call.slice(1, -1);
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

/**
 * Does this call carry a per-test timeout?
 *
 * Two forms, both decided on ARGUMENTS rather than on the call's text:
 *   - a trailing numeric literal:  it('x', fn, 30_000)
 *   - an options object with `timeout:` anywhere before the callback
 *
 * Deciding on text is what made the first version report a test as protected
 * because its BODY called `execFileAsync(..., { timeout: 120_000 })`.
 */
function hasTimeout(call) {
  const args = splitArgs(call);
  if (args.length === 0) return false;
  if (/^[0-9][0-9_]*$/.test(args[args.length - 1])) return true;
  return args.slice(0, -1).some((a) => /^\{[\s\S]*\btimeout\s*:/.test(a));
}

// The modifier's own argument list (`it.each([...])`) may span lines, so it
// is matched by paren-scanning below rather than by this regex.
const CALL = /\b(?:it|test)(?:\.(?:each|skipIf|runIf|only|skip|concurrent|sequential|todo|fails)\b)*\s*\(/g;

let timed = 0;
let untimed = 0;
const gaps = [];
const unparseable = [];

for (const root of roots.length ? roots : ['.']) {
  for (const file of walk(isAbsolute(root) ? root : join(ROOT, root))) {
    const src = readFileSync(file, 'utf8');
    const code = blankNonCode(src);
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(code)) !== null) {
      let open = code.indexOf('(', m.index + m[0].length - 1);
      let close = matchParen(code, open);
      // `it.each([...])( 'name', fn, 30_000 )` — the first group is the table,
      // the second is the test call. Step past any groups followed by another.
      while (close !== -1 && /^\s*\(/.test(code.slice(close + 1, close + 8))) {
        open = code.indexOf('(', close + 1);
        close = matchParen(code, open);
      }
      if (close === -1) {
        // Never drop silently: an unparseable call is a hole in the audit, and
        // a hole that prints nothing is indistinguishable from no gap.
        unparseable.push(`${relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`);
        continue;
      }
      const call = code.slice(open, close + 1);
      if (hasTimeout(call)) timed++;
      else {
        untimed++;
        const line = src.slice(0, m.index).split('\n').length;
        const name = /['"`](.*?)['"`]/.exec(src.slice(open, close + 1));
        gaps.push(`${relative(ROOT, file)}:${line}  ${name ? name[1].slice(0, 66) : '?'}`);
      }
      CALL.lastIndex = close;
    }
  }
}

if (!untimedOnly) {
  console.log(`tests with an explicit timeout: ${timed}`);
  console.log(`tests on the default budget:    ${untimed}`);
  console.log(`calls this audit could not parse: ${unparseable.length}`);
  console.log('');
  console.log('Most tests SHOULD be on the default — a tight bound is what makes a');
  console.log('genuine hang fail fast. Cross-reference against per-test durations;');
  console.log('anything above ~2000ms on a green run is a candidate.');
  console.log('');
}
for (const g of gaps) console.log(g);
