#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A test file a runner cannot match is worse than no test: it looks like
 * coverage, it passes review, and it reports nothing forever.
 *
 * `scripts/check-test-wiring.mjs` already catches the coarse case — a
 * package with test files but NO `test` script at all. This checker catches
 * the finer one: a package DOES have a `test` script, but the glob (or
 * vitest `include` config) that script runs does not actually reach every
 * `*.test.*` / `*.spec.*` file the package contains.
 *
 * The seed: `packages/renderer/package.json` runs `tsx --test src/*.test.ts`.
 * A bare shell glob has no `**` behaviour — it matches only files directly
 * in `src/`, never `src/<subdir>/*.test.ts`. `packages/ifcx` runs the same
 * shape. Both happen to have zero nested test files today, so the glob is a
 * live but *latent* trap, not a current defect — this checker is the ratchet
 * that keeps it that way.
 *
 * Runners differ per package, so this recognises the shapes actually used in
 * this repo rather than guessing:
 *
 *   1. `vitest run` (any flags) — vitest's own `include`, read from
 *      `vitest.config.{ts,mts,cts,js,mjs}` if the package has one (only a
 *      literal array of glob strings assigned to `include:` is understood),
 *      otherwise vitest's recursive default, which by construction reaches
 *      every test-looking file, so packages with no config are never
 *      flagged here for this shape.
 *   2. `<runner> --test <dir>/*.<ext>` (a bare shell glob passed straight to
 *      Node's `--test`, e.g. `tsx --test src/*.test.ts`) — matches ONLY
 *      files directly inside `<dir>`, not nested ones.
 *   3. `<runner> --test <flags> $(find <dir> -type f ( -name '*.a' -o -name
 *      '*.b' ... ) | sort)` — a shell-expanded `find`, which IS recursive;
 *      checked structurally rather than executed (executing `$(...)` from a
 *      package.json string is not something this checker will do).
 *
 * A `test` script shaped some OTHER way is a fail-closed error, not a silent
 * skip — teach this checker the new shape rather than let it wave a package
 * through unexamined (same policy as scripts/check-server-bin-targets.mjs's
 * `rustTripleFor`).
 *
 * `--root <dir>` points every read at an alternate tree, exactly like
 * scripts/check-server-bin-targets.mjs's `--root`; the regression harness
 * (scripts/check-test-glob-coverage.test.mjs) uses it to drive the
 * unmodified checker against synthetic fixture packages, never real repo
 * state.
 *
 * Run via `node scripts/check-test-glob-coverage.mjs`. NOT wired into CI —
 * see the report that shipped this file for the wiring proposal.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const rootFlagIdx = process.argv.indexOf('--root');
if (rootFlagIdx !== -1 && !process.argv[rootFlagIdx + 1]) {
  fail('--root requires a directory argument');
}
const ROOT = rootFlagIdx === -1 ? join(SCRIPT_DIR, '..') : resolveArg(process.argv[rootFlagIdx + 1]);

function resolveArg(p) {
  return p.startsWith('/') ? p : join(process.cwd(), p);
}

export function fail(message) {
  console.error(`\ncheck-test-glob-coverage: ${message}\n`);
  process.exitCode = 1;
  throw new FailError(message);
}

export class FailError extends Error {}

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo', 'generated']);
const PACKAGE_PARENTS = ['packages', 'apps'];

/** All test-looking files under `dir`, as paths relative to `dir`, POSIX-separated. */
export function findTestLookingFiles(dir) {
  const found = [];
  walk(dir, dir, found);
  return found.sort();
}

function walk(root, dir, found) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // Fail closed elsewhere (a missing package dir is a caller bug); an
    // unreadable subdirectory here is treated as empty rather than crashing
    // the whole audit over one package.
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(root, full, found);
    } else if (TEST_FILE_RE.test(entry)) {
      found.push(relative(root, full).split('\\').join('/'));
    }
  }
}

/**
 * Minimal glob -> RegExp, sufficient for the `include:` arrays actually seen
 * in this repo's vitest configs (`'test/**\/*.test.ts'`, `'src/**\/*.test.ts'`).
 * Supports `*`, `**\/`, `?` and `{a,b}` alternation. Deliberately does not
 * support extglob (`?(c|m)`) — vitest's own DEFAULT include string uses that,
 * but the default case is never parsed as a glob here (see resolveVitestGlobs).
 */
export function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      let j = i + 2;
      if (glob[j] === '/') j++;
      re += '(?:.*/)?';
      i = j;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
        continue;
      }
      const options = glob.slice(i + 1, end).split(',');
      re += `(?:${options.map(escapeRegExpLiteral).join('|')})`;
      i = end + 1;
    } else {
      re += escapeRegExpLiteral(c);
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses a literal `include: [ 'a', "b", ... ]` array out of a vitest config
 * source. Returns null if no `include:` key is found (meaning: use vitest's
 * recursive default). Deliberately does not evaluate the config as code —
 * every real config in this repo assigns a plain string-literal array.
 */
export function parseViteInclude(source) {
  const m = source.match(/\binclude\s*:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const items = [...m[1].matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((mm) => mm[2]);
  return items;
}

const VITEST_CONFIG_NAMES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
];

/**
 * Files a `vitest run` invocation reaches, relative to the package dir, or
 * `null` meaning "vitest's recursive default — reaches every test-looking
 * file by construction, nothing to check".
 */
function resolveVitestGlobs(pkgDir, testLooking) {
  const configName = VITEST_CONFIG_NAMES.find((n) => existsSync(join(pkgDir, n)));
  if (!configName) return null;
  const source = readFileSync(join(pkgDir, configName), 'utf8');
  const includes = parseViteInclude(source);
  if (includes === null) return null;
  if (includes.length === 0) {
    fail(`${join(pkgDir, configName)} has an "include:" key that parsed to zero patterns`);
  }
  const regexes = includes.map(globToRegExp);
  return testLooking.filter((f) => regexes.some((re) => re.test(f)));
}

/** `<dir>/*.<ext>` — bare shell glob(s), single directory level only. */
const BARE_GLOB_RE = /(?:^|\s)(?:--test\s+)?([\w./-]+)\/\*\.([\w.]+)(?=\s|$)/g;

/** `find <dir> ... ( -name '*.a' -o -name '*.b' ... )` — recursive by construction. */
const FIND_RE = /find\s+([\w./-]+)\s+-type\s+f/;
const FIND_NAME_RE = /-name\s+'(\*\.[\w.]+)'/g;

/**
 * Files a package's `test` script actually reaches, or throws (fail-closed)
 * for an unrecognised shape.
 */
function resolveMatched(pkgDir, testScript, testLooking) {
  const trimmed = testScript.trim();

  if (/^vitest\s+run\b/.test(trimmed)) {
    const globMatched = resolveVitestGlobs(pkgDir, testLooking);
    return globMatched === null ? testLooking : globMatched;
  }

  const findMatch = trimmed.match(FIND_RE);
  if (findMatch && trimmed.includes('$(find')) {
    const dir = findMatch[1];
    const patterns = [...trimmed.matchAll(FIND_NAME_RE)].map((m) => m[1]);
    if (patterns.length === 0) {
      fail(`${pkgDir}: test script uses $(find ...) but no -name '*.ext' pattern could be parsed: ${trimmed}`);
    }
    const regexes = patterns.map((p) => globToRegExp(`${dir}/**/${p}`));
    return testLooking.filter((f) => regexes.some((re) => re.test(f)));
  }

  const bareMatches = [...trimmed.matchAll(BARE_GLOB_RE)];
  if (bareMatches.length > 0) {
    // One or more `<dir>/*.<ext>` globs (a command can list several, e.g.
    // "tsx --test src/*.test.ts src/*.test.tsx"). Each reaches only files
    // directly inside its own `dir` — no `**` behaviour — so the matched set
    // is the union of each glob's single-level hits.
    const wants = bareMatches.map(([, dir, extRest]) => ({ dir, wanted: `.${extRest}` }));
    return testLooking.filter((f) => {
      const slash = f.lastIndexOf('/');
      const parentDir = slash === -1 ? '' : f.slice(0, slash);
      return wants.some(({ dir, wanted }) => parentDir === dir && f.endsWith(wanted));
    });
  }

  fail(
    `${pkgDir}: test script has an unrecognised shape, cannot verify its coverage: "${trimmed}"\n` +
      `Teach resolveMatched() in scripts/check-test-glob-coverage.mjs the new shape before adding it,\n` +
      `or this checker would otherwise wave the package through unexamined.`,
  );
}

export function auditPackage(pkgDir, pkgJson) {
  const testScript = pkgJson.scripts?.test;
  if (!testScript) return null; // scripts/check-test-wiring.mjs's job, not this one.
  const testLooking = findTestLookingFiles(pkgDir);
  if (testLooking.length === 0) return { testLooking: [], matched: [], missed: [] };
  const matched = resolveMatched(pkgDir, testScript, testLooking);
  const matchedSet = new Set(matched);
  const missed = testLooking.filter((f) => !matchedSet.has(f));
  return { testLooking, matched, missed };
}

export function listPackages(root) {
  const out = [];
  for (const parent of PACKAGE_PARENTS) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const name of readdirSync(parentDir).sort()) {
      const pkgDir = join(parentDir, name);
      const pkgJsonPath = join(pkgDir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      let pkgJson;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      } catch (err) {
        fail(`${pkgJsonPath} is not valid JSON: ${err.message}`);
      }
      out.push({ rel: `${parent}/${name}`, dir: pkgDir, pkgJson });
    }
  }
  return out;
}

function main() {
  const packages = listPackages(ROOT);
  const offenders = [];
  let audited = 0;

  for (const { rel, dir, pkgJson } of packages) {
    const result = auditPackage(dir, pkgJson);
    if (result === null) continue;
    audited++;
    if (result.missed.length > 0) {
      offenders.push({ rel, ...result });
    }
  }

  if (offenders.length > 0) {
    console.error('\nTest files no runner matches (these NEVER execute):\n');
    for (const { rel, missed, testLooking, matched } of offenders) {
      console.error(`  ${rel}: ${missed.length} unrun of ${testLooking.length} test-looking files (${matched.length} matched)`);
      for (const f of missed) console.error(`    - ${rel}/${f}`);
    }
    console.error(`
Either widen the test script's glob / vitest "include" to reach these files
(and expect them to start running — a file that never ran may not pass), or
if they are dead and should be deleted, delete them. Do not add a skip.
`);
    process.exitCode = 1;
    return;
  }

  console.log(`check-test-glob-coverage: OK (${audited} packages audited, 0 unrun test files)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof FailError)) throw err;
  }
}
