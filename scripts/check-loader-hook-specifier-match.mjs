#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: a `node:module` `register()` loader hook must not be able to match ONLY
 * a bare specifier.
 *
 * THE TRAP, from two real incidents rather than a hypothetical:
 *
 * `module.registerHooks` (synchronous, in-thread) landed in Node 22.15.0, and
 * tsx feature-detects it. On a newer 22 an alias like `@/lib/collab/geometry-sync`
 * or a workspace package like `@ifc-lite/collab` is normalised to a `file://`
 * URL by that synchronous path BEFORE the async `register()` hook is consulted.
 * A hook whose only arm is `specifier === '@/lib/collab/geometry-sync'` then
 * never matches, the target module is never wrapped, the gate the test parks on
 * never fires, and the file hangs until the runner's timeout.
 *
 * It is invisible on an older 22 and deterministic on CI, whose workflow pins
 * `node-version: 22` and so floats to the newest 22.x. `collab-session-race-hook.mjs`
 * hit it first and now carries a twenty-line comment about it;
 * `collab-hydrate-gate-hook.mjs` was written afterwards and walked into it
 * anyway. A comment did not prevent the second occurrence. Hence a gate.
 *
 * THE RULE, and its exact scope: for every `resolve` hook found, this collects
 * the `if (...)` conditions in its body and classifies each as
 *
 *   - BARE-ONLY  — an exact equality against the specifier parameter whose
 *                  right-hand side is a string with no URI scheme
 *                  (`specifier === '@/x'`, or `specifier === TARGET` where
 *                  `TARGET` is a top-level string const). After normalisation
 *                  the specifier is a `file://` URL, so this can never be true.
 *                  A scheme-carrying literal (`'node:fs'`, `'file://…'`) is NOT
 *                  bare-only: Node does not rewrite those.
 *   - URL-CAPABLE — the condition tests something that survives normalisation:
 *                  a `.url` property, a regex `.test(`, `.endsWith(`,
 *                  `.includes(`, `.match(`, a `file://` literal, or
 *                  `pathToFileURL` / `fileURLToPath`.
 *
 * A hook is FLAGGED when it has at least one bare-only arm and zero URL-capable
 * arms — i.e. every way it can match is dead on a newer Node. The remedy is the
 * one both fixed hooks use: call `nextResolve` first and match the resolved URL,
 * keeping the specifier arm as an `||` for the older async-only loader path.
 *
 * WHAT THIS CANNOT SEE. It is a lexical check on one function body; it does not
 * load a hook, register it, or observe a single resolution. Specifically:
 *
 *   1. PER-ARM RISK IS NOT FLAGGED. A hook with one URL-capable arm passes even
 *      if another arm is bare-only and load-bearing on its own.
 *      `apps/viewer/src/test/vite-module-hooks-impl.mjs` is exactly this today:
 *      its `specifier === 'cesium'` arm is bare-only, and the file passes on the
 *      strength of its `.endsWith('.css')` / `.endsWith('?raw')` arms. Widening
 *      the rule to per-arm would red that file, and a gate that reds working
 *      code gets disabled — so this is a deliberate, recorded gap, not an
 *      oversight.
 *   2. A DYNAMIC MATCH TARGET IS INVISIBLE. `specifier === buildTarget()`, or a
 *      target read from a config object or an env var, resolves to neither
 *      class: the const map below only follows top-level string literals. Such a
 *      hook is neither flagged nor vouched for.
 *   3. A URL-CAPABLE-LOOKING ARM MAY NOT ACTUALLY MATCH. `specifier.endsWith(
 *      '/geometry-sync')` is true of the alias and false of
 *      `file:///…/geometry-sync.ts`; a regex anchored on the alias spelling is
 *      the same shape. Both read as URL-capable here and would still hang. Only
 *      running the hook on a newer Node can tell those apart.
 *   4. IT DOES NOT KNOW HOW A HOOK IS REGISTERED. `module.registerHooks` is
 *      synchronous and DOES see the bare specifier, so an exact match is correct
 *      there. A hook file written for that API and for nothing else would be
 *      flagged by this check, wrongly. No such file exists in the repo today.
 *   5. IT SEES ONLY `if (...)`. A hook that matches inside a ternary, a `switch`,
 *      or a bare `return a || b` has no `if` condition to classify; that is a
 *      hard failure ("no match condition") rather than a pass, so the shape is
 *      fail-closed but not understood.
 *
 * Every step fails closed. A missing root, a search root that does not exist,
 * an unreadable file, zero files scanned, zero hooks found, a `resolve` whose
 * body cannot be delimited, or a `resolve` with no locatable condition is an
 * error with a named reason and a non-zero exit. The success line prints the
 * counts, so a zero-measure green is visible in the line itself.
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

/** Every `if (...)` condition inside a body, as raw text. */
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
          conditions.push(bodyText.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return conditions;
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
 * and the URL-capable signals it carries.
 */
function classifyCondition(condition, specifierParam, consts) {
  const bare = [];
  const ident = specifierParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const operand = String.raw`(['"]((?:\\.|[^'"])*)['"]|[A-Za-z_$][\w$]*)`;
  const forms = [
    new RegExp(String.raw`\b${ident}\b\s*===?\s*${operand}`, 'g'),
    new RegExp(String.raw`${operand}\s*===?\s*\b${ident}\b`, 'g'),
  ];
  for (const re of forms) {
    for (const m of condition.matchAll(re)) {
      const raw = m[1];
      const text = raw.startsWith("'") || raw.startsWith('"') ? m[2] : consts.get(raw);
      // An identifier that is not a known top-level string const is a dynamic
      // target: neither flagged nor vouched for (limitation 2 in the header).
      if (text === undefined) continue;
      if (HAS_SCHEME.test(text)) continue;
      bare.push(text);
    }
  }
  const urlSignals = URL_CAPABLE_SIGNALS.filter((s) => s.re.test(condition)).map((s) => s.why);
  return { bare, urlSignals };
}

const files = collectFiles();

let hookFileCount = 0;
let resolveHookCount = 0;
let conditionCount = 0;
let bareArmCount = 0;
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

    const bareTargets = [];
    const urlWhy = [];
    for (const condition of conditions) {
      const { bare, urlSignals } = classifyCondition(condition, specifierParam, consts);
      bareTargets.push(...bare);
      urlWhy.push(...urlSignals);
    }
    bareArmCount += bareTargets.length;
    urlArmCount += urlWhy.length;

    if (bareTargets.length > 0 && urlWhy.length === 0) {
      flagged.push({ rel, line: lineOf(declOffset), targets: bareTargets });
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
  fail([
    `${hit.rel}:${hit.line}: \`resolve\` can only match a bare specifier.`,
    '',
    ...hit.targets.map((t) => `  matches only \`${t}\``),
    '',
    `\`module.registerHooks\` (synchronous, in-thread) landed in Node 22.15.0 and tsx
feature-detects it. On a newer 22 that specifier is normalised to a \`file://\`
URL BEFORE this async \`register()\` hook is consulted, so the equality never
holds, the target module is never wrapped, and whatever the hook exists to gate
never fires — a hang until the runner's timeout, on CI only, because the
workflow pins \`node-version: 22\` and floats to the newest 22.x.

This has happened twice: \`collab-session-race-hook.mjs\` and
\`collab-hydrate-gate-hook.mjs\`. Both fixes are the same: call \`nextResolve\`
first and match the RESOLVED url, keeping the specifier arm as an \`||\` for the
older async-only loader path. Guard on \`context.parentURL\` if the hook's
replacement module imports the real url, or it will wrap itself forever.`,
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
    `${bareArmCount} bare-specifier arm(s), ${urlArmCount} url-capable signal(s))`,
);
