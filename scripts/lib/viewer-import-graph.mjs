/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The static import graph of the viewer test suite, read from SOURCES.
 *
 * Starting at every viewer test file (plus the modules the test command
 * preloads with `--import`, which every test implicitly depends on), it walks
 * each module's import specifiers and resolves them the way the viewer's
 * tsconfig and the workspace packages do: relative paths with the TypeScript
 * `.js` -> `.ts` convention, tsconfig `paths` (`@/*`, `@ifc-lite/parser`, ...),
 * and a workspace package's `exports` mapped from `dist/` back to `src/`.
 * Reversed, it answers: which test files can a changed file affect?
 *
 * WHAT IT SEES: `import`/`export ... from`, side-effect `import 'x'`, literal
 * `import('x')`, `require('x')`, `mock.module('x')`, and literal
 * `new URL('x', import.meta.url)` / `register('x', import.meta.url)` (workers,
 * loader hooks, assets). Query suffixes (`?raw`, `?worker`) are stripped.
 *
 * WHAT IT CANNOT SEE, by construction: a specifier built at runtime (template
 * literal, concatenation), a file read with `readFileSync` by a path string,
 * anything that reaches a test through a BUILT artifact rather than a source
 * import (the WASM bundle, a package whose `exports` point outside `dist/`),
 * and test-runner configuration. Callers must treat those as unmappable.
 *
 * Over-approximation is deliberate: a commented-out import still counts as an
 * edge. Only whole `import type` / `export type` statements are dropped,
 * because tsx erases them and they cannot change what a test runs. A spurious edge costs a test run; a missing one costs recall.
 */

import { posix } from 'node:path';

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, '.json'];
const TS_FOR_JS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/** A file the graph parses for imports. */
export const isCodeFile = (path) => CODE_EXTENSIONS.some((ext) => path.endsWith(ext));

/** A viewer test file, the same set `apps/viewer`'s `test` script finds. */
export const isViewerTest = (path) => /^apps\/viewer\/src\/.*\.test\.tsx?$/.test(path);

// `import type` / `export type` statements are erased by tsx before the test
// runs, so they are not runtime edges. A mixed `import { type A, b }` is kept.
// The clause is bounded (one identifier, `* as n`, or a `{...}` list) so the
// match cannot run past the statement when there is no semicolon.
const TYPE_ONLY = /(?:^|[^\w$.])(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?|[\w$]+)\s*from\s*['"][^'"\n]+['"]/g;

const SPECIFIER_PATTERNS = [
  // import x from 'a'; import { a, b } from 'a'; import x, * as n from 'a';
  // export * from 'a'; export { a } from 'a'; import 'a'. A `{...}` list may
  // hold comments, so it is matched as anything but `}`.
  /(?:^|[^\w$.])(?:import|export)\s+(?:(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?|[\w$]+)\s*from\s*)?['"]([^'"\n]+)['"]/g,
  /(?:^|[^\w$.])import\s*\(\s*['"]([^'"\n]+)['"]\s*[,)]/g,
  /(?:^|[^\w$.])require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bmock\.module\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\bnew\s+URL\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
  /\bregister\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
];

/** Every literal module specifier in `code`, query and hash stripped. */
export function extractSpecifiers(code) {
  const out = new Set();
  const runtime = code.replace(TYPE_ONLY, '');
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of runtime.matchAll(pattern)) {
      const spec = m[1].replace(/[?#].*$/, '');
      if (spec) out.add(spec);
    }
  }
  return [...out];
}

/** Strip the extension, so `a/b.ts` and a missing `a/b.js` import compare equal. */
export const extensionless = (path) => path.replace(/\.(?:d\.)?[cm]?[jt]sx?$|\.json$/, '');

/**
 * @param {{
 *   files: Set<string>,
 *   aliases?: Array<{ pattern: string, targets: string[] }>,
 *   packages?: Map<string, { dir: string, exports?: unknown, main?: string }>,
 * }} input  repo-relative POSIX paths; alias targets repo-relative, `*` allowed
 */
export function createResolver({ files, aliases = [], packages = new Map() }) {
  function resolveFile(base) {
    const p = posix.normalize(base);
    if (p.startsWith('..') || p.startsWith('/')) return null;
    if (files.has(p)) return p;
    const ext = posix.extname(p);
    for (const ts of TS_FOR_JS[ext] ?? []) {
      const candidate = p.slice(0, -ext.length) + ts;
      if (files.has(candidate)) return candidate;
    }
    for (const e of RESOLVE_EXTENSIONS) if (files.has(p + e)) return p + e;
    for (const e of RESOLVE_EXTENSIONS) if (files.has(`${p}/index${e}`)) return `${p}/index${e}`;
    return null;
  }

  function fromAliases(spec) {
    for (const { pattern, targets } of aliases) {
      const star = pattern.indexOf('*');
      let capture = null;
      if (star < 0) {
        if (spec === pattern) capture = '';
      } else if (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))) {
        capture = spec.slice(star, spec.length - (pattern.length - star - 1));
      }
      if (capture === null) continue;
      const bases = targets.map((t) => t.replace('*', capture));
      for (const base of bases) {
        const hit = resolveFile(base);
        if (hit) return { kind: 'file', path: hit };
      }
      // tsx still resolves a workspace package through node_modules, so try
      // its exports before recording the import as missing.
      return fromPackage(spec) ?? { kind: 'missing', base: posix.normalize(bases[0]) };
    }
    return null;
  }

  function fromPackage(spec) {
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pkg = packages.get(name);
    if (!pkg) return null;
    const sub = spec === name ? '.' : `./${spec.slice(name.length + 1)}`;
    let target = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports[sub] : undefined;
    if (target === undefined && typeof pkg.exports === 'string' && sub === '.') target = pkg.exports;
    if (target === undefined && pkg.exports === undefined && sub === '.') target = pkg.main;
    if (target && typeof target === 'object') target = target.import ?? target.default ?? target.types;
    if (typeof target === 'string') {
      const dist = /^\.\/dist\/(.+?)(?:\.d)?\.[cm]?js$|^\.\/dist\/(.+?)\.d\.ts$/.exec(target);
      const rest = dist && (dist[1] ?? dist[2]);
      if (rest) {
        const hit = resolveFile(`${pkg.dir}/src/${rest}`);
        if (hit) return { kind: 'file', path: hit };
      }
    }
    // A package entry the graph cannot follow into source (a WASM bundle, an
    // export map shape not handled above). The edge goes to the PACKAGE, so a
    // change anywhere in its sources still reaches the importer.
    return { kind: 'package', name };
  }

  /**
   * @returns {{ kind: 'file', path: string } | { kind: 'package', name: string }
   *   | { kind: 'missing', base: string } | { kind: 'external' }}
   */
  return function resolve(importer, spec) {
    if (spec.startsWith('.')) {
      const base = posix.join(posix.dirname(importer), spec);
      // A relative path into a package's BUILT output stands for its source.
      const dist = /^(packages\/[^/]+)\/dist\/(.+?)(?:\.d)?\.[cm]?js$/.exec(posix.normalize(base));
      const hit = resolveFile(base) ?? (dist && resolveFile(`${dist[1]}/src/${dist[2]}`));
      return hit ? { kind: 'file', path: hit } : { kind: 'missing', base: posix.normalize(base) };
    }
    return fromAliases(spec) ?? fromPackage(spec) ?? { kind: 'external' };
  };
}

export const packageNode = (name) => `pkg:${name}`;

/**
 * Walk forward from `tests` (and `preloads`, which every test depends on).
 *
 * @param {{ tests: string[], preloads?: string[], read: (path: string) => string,
 *   resolve: ReturnType<typeof createResolver> }} input
 * @returns {{ nodes: Set<string>, edges: Map<string, Set<string>>,
 *   missing: Map<string, Set<string>>, tests: string[] }}
 *   `missing`: extensionless import target that resolved to no file -> importers.
 */
export function buildGraph({ tests, preloads = [], read, resolve }) {
  const edges = new Map();
  const missing = new Map();
  const nodes = new Set();
  const queue = [...preloads, ...tests];
  for (const t of tests) edges.set(t, new Set(preloads));
  while (queue.length > 0) {
    const file = queue.pop();
    if (nodes.has(file)) continue;
    nodes.add(file);
    if (!isCodeFile(file)) continue;
    const out = edges.get(file) ?? new Set();
    edges.set(file, out);
    for (const spec of extractSpecifiers(read(file))) {
      const r = resolve(file, spec);
      if (r.kind === 'file') {
        out.add(r.path);
        if (!nodes.has(r.path)) queue.push(r.path);
      } else if (r.kind === 'package') {
        out.add(packageNode(r.name));
        nodes.add(packageNode(r.name));
      } else if (r.kind === 'missing') {
        const key = extensionless(r.base);
        if (!missing.has(key)) missing.set(key, new Set());
        missing.get(key).add(file);
      }
    }
  }
  return { nodes, edges, missing, tests: [...tests] };
}

/**
 * The tests that reach any of `seeds`, with the length of the shortest path
 * (a changed test file is at 0, a test importing a changed module at 1).
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {Iterable<string>} seeds  graph nodes (files or `pkg:` nodes)
 * @returns {Map<string, number>} test -> distance
 */
export function affectedTests(graph, seeds) {
  const reverse = new Map();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      if (!reverse.has(to)) reverse.set(to, []);
      reverse.get(to).push(from);
    }
  }
  const depth = new Map();
  let frontier = [];
  for (const s of seeds) {
    if (!depth.has(s)) {
      depth.set(s, 0);
      frontier.push(s);
    }
  }
  for (let d = 1; frontier.length > 0; d++) {
    const next = [];
    for (const node of frontier) {
      for (const importer of reverse.get(node) ?? []) {
        if (depth.has(importer)) continue;
        depth.set(importer, d);
        next.push(importer);
      }
    }
    frontier = next;
  }
  const out = new Map();
  for (const t of graph.tests) if (depth.has(t)) out.set(t, depth.get(t));
  return out;
}
