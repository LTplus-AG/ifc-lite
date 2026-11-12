/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The top-level workflow files whose edit can change a Test cache key, so a
 * push touching one must still run in full on main (ci-push-replay.mjs).
 *
 * A workflow file reaches a cache key in one of two ways: it is executed by the
 * run (test.yml, or a reusable workflow test.yml calls with `uses: ./...`), so
 * its own text sets keys; or a `hashFiles(...)` or `cache-dependency-path` in an
 * executed file hashes it. Executed files are those workflows plus every file
 * under `.github/actions/` (which ci-push-replay blocks on its own). A step that
 * merely READS another workflow is test behaviour, already covered by the
 * exact-tree evidence.
 *
 * THE SCAN IS AN ALLOW-LIST. Every `uses:` value, `cache-dependency-path:`
 * value and hashFiles argument must be one of a few plain forms; anything else
 * (a YAML tag, alias, escape, flow list, block scalar, expression, `~`, `..`)
 * makes the answer unknown, and the caller blocks every workflow file. Each
 * allowed pattern is then judged for whether it can reach
 * `.github/workflows/<x>.yml`, directories included, since hashFiles hashes
 * every file below a matched one. Patterns are judged relative to the workspace
 * root, where Test checks the repository out (no checkout `path:`). Not
 * detected: a key computed in a `run:` step or a script from a workflow file's
 * bytes (a `key:` from a step output), or by a remote action's other inputs.
 */

import { posix } from 'node:path';

export const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;
const isBlank = (line) => /^[ \t]*(?:#.*)?\r?$/.test(line);
// A line that opens a block scalar (`run: |`, `- >-`); group 1 runs up to the key's column.
// A key or a list dash must precede the indicator: a bare `|` line can be inside a quoted scalar.
const BLOCK_SCALAR_START = /^([ \t]*(?:-[ \t]+)*)(?:([^\s#][^#]*?)[ \t]*:[ \t]+|(?<=-[ \t]+))[|>][1-9+-]*[ \t]*(?:#.*)?\r?$/;

/**
 * The indices of lines inside a YAML block scalar: after a `key: |` or `key: >` line,
 * every line indented deeper than that key (or blank). Their text is a string (a
 * run: script), not YAML.
 */
function blockScalarLines(lines) {
  const inside = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (inside.has(i)) continue;
    const m = BLOCK_SCALAR_START.exec(lines[i]);
    if (!m) continue;
    // The parent's column: the key's, or for a bare `- |` the dash's (content may sit just past it).
    const keyCol = m[2] === undefined ? m[1].trimEnd().length - 1 : m[1].length;
    // Only a whitespace-only line continues it; a less-indented comment line ends it.
    for (let j = i + 1; j < lines.length && (/^[ \t]*\r?$/.test(lines[j]) || indentOf(lines[j]) > keyCol); j += 1) inside.add(j);
  }
  return inside;
}

/**
 * Every occurrence of `key:` outside comments and block scalars, several per line in a
 * flow mapping, as { before (a `{` or `[` there means flow context), rest of the line,
 * continues (block context, and the next non-blank line is indented deeper than the
 * key, so the value is a plain scalar folded over several lines) }.
 */
function keyEntries(lines, inBlock, key) {
  // Not after `-`: `my-uses:` is another key, and a list item's `- uses:` has a space.
  // Case-insensitive: action inputs are (`Cache-Dependency-Path:`), and for `uses:` it fails closed.
  const re = new RegExp(`(^|[\\s{[,])['"]?${key}['"]?[ \\t]*:`, 'gi');
  const out = [];
  lines.forEach((line, i) => {
    if (inBlock.has(i) || /^[ \t]*#/.test(line)) return;
    for (const m of line.matchAll(re)) {
      const before = line.slice(0, m.index + m[1].length);
      let next = i + 1;
      while (next < lines.length && isBlank(lines[next])) next += 1;
      // A sibling key (`with:` under `- uses:`) sits at the key's column; a folded line is deeper.
      const continues = !/[{[]/.test(before) && next < lines.length && indentOf(lines[next]) > before.length;
      out.push({ before, rest: line.slice(m.index + m[0].length), continues });
    }
  });
  return out;
}
// In YAML (not in an action's scripts): a hex or unicode escape can spell a key or a call
// the scan looks for (`"u\x73es":`, `hashFiles\x28`), and `? ` starts a complex key.
// An alias as a key (`*k : value`) hides the key's name the same way.
const YAML_HIDDEN = /\\[xuU][0-9A-Fa-f]|(?:^|[\s{[,])\?(?:[ \t\r]|$)|(?:^|[\s{[,])\*[^\s,[\]{}]+[ \t]*:/m;
const IS_YAML = /\.ya?ml$/;
// Expression function names are case-insensitive, and `hashFiles (` is a call (any escape
// in a double-quoted scalar, such as `\t` or `\n`, may decode to whitespace).
const HASHFILES = /hashFiles(?:\s|\\.)*\(/gi;
// Outside a block scalar, a line ending in `\` is an escaped line break in a
// double-quoted scalar, which joins it to the next line (`hash\` newline `Files(`).
const ESCAPED_BREAK = /\\\r?$/;
const QUOTED_ARG = /^\s*(?:'([^']*)'|"([^"]*)")\s*([,)])/;

// The allowed forms. A path is plain characters only: no escapes, `~`, `!`, braces or brackets.
const PLAIN_PATH = /^[\w./*-]+$/;
const LOCAL_WORKFLOW = /^\.\/(\.github\/workflows\/[\w.-]+\.ya?ml)$/;
const LOCAL_ACTION = /^\.\/\.github\/actions\/[\w.-]+(?:\/[\w.-]+)*$/;
// An owner never starts with `.`: `./foo@v1` is a local action in directory `foo@v1`.
const REMOTE_ACTION = /^[\w-][\w.-]*\/[\w.-]+(?:\/[\w./-]+)?@[\w./-]+$/;
const DOCKER = /^docker:\/\/\S+$/;

/**
 * The scalar a `key: <rest>` line gives: comment dropped, in a flow mapping the entry's
 * tail (`, ...` / ` }`) too (in block context a comma is part of the scalar), one
 * quote pair removed. Null when unquoted text starts with a YAML indicator (alias `*`,
 * anchor `&`, tag `!`, block `|` `>`, flow `[` `{`, reserved `%` `@` backtick): then
 * the line does not show the value.
 */
function scalar(before, rest) {
  let v = rest.replace(/[ \t]+#.*$/, '').trim();
  if (before.includes('{')) v = v.replace(/[ \t]*[,}].*$/, '');
  const quoted = /^(['"])(.*)\1$/.exec(v);
  if (quoted) return quoted[2];
  return /^[*&!|>[{%@`]/.test(v) ? null : v;
}

/** A hashFiles call's quoted arguments, or null when one is not a quoted literal. */
function hashFilesArgs(text, from) {
  const args = [];
  let rest = text.slice(from);
  for (;;) {
    const m = QUOTED_ARG.exec(rest);
    if (!m) return null;
    args.push(m[1] ?? m[2]);
    rest = rest.slice(m[0].length);
    if (m[3] === ')') return args;
  }
}

const WORKFLOW_SEGMENTS = ['.github', 'workflows'];
const isWild = (seg) => seg.includes('*');

/** Whether one glob segment can match target segment `ti` (0 `.github`, 1 `workflows`, 2 any YAML name). */
// Case-insensitive: hashFiles on a macOS or Windows runner is.
function segmentMatches(seg, ti) {
  // A YAML name: a literal ends in .yml/.yaml; a wildcard can unless its literal tail rules it out (`*.png`).
  if (ti === 2) {
    if (!isWild(seg)) return /\.ya?ml$/i.test(seg);
    const tail = seg.slice(seg.lastIndexOf('*') + 1).toLowerCase();
    return ['.yml', '.yaml'].some((ext) => ext.endsWith(tail) || tail.endsWith(ext));
  }
  if (!isWild(seg)) return seg.toLowerCase() === WORKFLOW_SEGMENTS[ti];
  return new RegExp(`^${seg.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`, 'i').test(WORKFLOW_SEGMENTS[ti]);
}

/**
 * Whether `segs` can match `.github`, `.github/workflows` or a YAML file in it.
 * hashFiles hashes every file below a matched directory, so an ancestor counts.
 */
function reachesWorkflows(segs, pi = 0, ti = 0) {
  if (pi === segs.length) return ti >= 1;
  if (segs[pi] === '**') return reachesWorkflows(segs, pi + 1, ti) || (ti < 3 && reachesWorkflows(segs, pi, ti + 1));
  if (ti >= 3) return false;
  return segmentMatches(segs[pi], ti) && reachesWorkflows(segs, pi + 1, ti + 1);
}

/** For one plain pattern: the workflow file it names, 'none', or 'unknown' (it may reach one it does not name). */
function judgePattern(pattern) {
  const segs = pattern.replace(/^\.\//, '').split('/');
  // The workspace root, an absolute path, an empty or climbing segment, or a trailing slash.
  if (pattern === '.' || pattern === './' || pattern.startsWith('/') || segs.some((s) => s === '' || s === '.' || s === '..')) return 'unknown';
  if (!reachesWorkflows(segs)) {
    // A segment below the first that can be `.github`, followed by a path into workflows/:
    // that names the repository checked out under a directory (a checkout `path:`), which
    // this scan does not follow. A `**` standing in for `.github` does not count.
    const underPrefix = segs.some((seg, k) => k > 0 && seg !== '**' && segmentMatches(seg, 0) && reachesWorkflows(segs.slice(k)));
    return underPrefix ? 'unknown' : 'none';
  }
  const p = segs.join('/');
  return WORKFLOW_FILE.test(p) && !segs.some(isWild) ? p : 'unknown';
}

/**
 * Whether a YAML structure line leaves a quoted scalar open, so it continues on the next
 * line. Inside such a scalar a `#` line or a `key: |` line is text, which the line-based
 * scan would read as a comment or a block scalar.
 */
function opensMultilineQuote(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (double) {
      if (c === '\\') i += 1;
      else if (c === '"') double = false;
    } else if (single) {
      if (c === "'" && line[i + 1] === "'") i += 1;
      else if (c === "'") single = false;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    // A quote opens a quoted scalar only where a value starts; inside a plain scalar
    // (`${{ hashFiles(' x ') }}`) it is an ordinary character.
    else if ((c === '"' || c === "'") && /(?:^|[:[{,-])[ \t]*$/.test(line.slice(0, i))) {
      if (c === '"') double = true;
      else single = true;
    }
  }
  return single || double;
}

/**
 * What one file says, before any judging: its `uses:` values, `cache-dependency-path:`
 * values and hashFiles patterns, or why it cannot be read. `uses:` and
 * `cache-dependency-path:` are YAML keys, read only from YAML files and outside block
 * scalars; hashFiles is read everywhere except YAML comment lines, since `${{ }}`
 * expands inside a run: script and an action's scripts can call @actions/glob.
 *
 * @param {string} path
 * @param {string} text
 * @returns {{ unknown: string } | { uses: string[], cacheDependencyPaths: string[], hashFilesPatterns: string[] }}
 */
export function scanFile(path, text) {
  // An action's README or notes are not executed.
  if (/\.(?:md|txt)$/i.test(path)) return { uses: [], cacheDependencyPaths: [], hashFilesPatterns: [] };
  const yaml = IS_YAML.test(path);
  // YAML also breaks lines at a lone CR.
  const lines = text.split(/\r\n|\r|\n/);
  const inBlock = yaml ? blockScalarLines(lines) : new Set();
  const isComment = (line) => /^[ \t]*#/.test(line);
  const uses = [];
  const cacheDependencyPaths = [];
  if (yaml) {
    // Neither block scalar text nor a comment line is YAML structure.
    const yamlLines = lines.filter((line, i) => !inBlock.has(i) && !isComment(line)).join('\n');
    if (YAML_HIDDEN.test(yamlLines)) return { unknown: `${path} has a YAML escape or complex key the scan cannot read through` };
    if (lines.some((line, i) => !inBlock.has(i) && !isComment(line) && opensMultilineQuote(line))) return { unknown: `${path} has a quoted scalar over several lines` };
    if (lines.some((line, i) => !inBlock.has(i) && !isComment(line) && ESCAPED_BREAK.test(line))) return { unknown: `${path} has an escaped line break outside a block scalar` };
    for (const [key, out] of [['uses', uses], ['cache-dependency-path', cacheDependencyPaths]]) {
      for (const { before, rest, continues } of keyEntries(lines, inBlock, key)) {
        if (continues) return { unknown: `${path} has a ${key}: value folded over several lines` };
        const v = scalar(before, rest);
        if (v === null) return { unknown: `${path} has a ${key}: value the line does not show` };
        out.push(v);
      }
    }
  }
  const scanned = yaml ? lines.filter((line, i) => inBlock.has(i) || !isComment(line)).join('\n') : lines.join('\n');
  const hashFilesPatterns = [];
  for (const m of scanned.matchAll(HASHFILES)) {
    const args = hashFilesArgs(scanned, m.index + m[0].length);
    if (args === null) return { unknown: `${path} calls hashFiles with an argument that is not a quoted literal` };
    // A line break inside an argument folds to a space in a plain, quoted or `>` scalar,
    // so the pattern GitHub sees is not the one the lines show.
    if (args.some((a) => a.includes('\n'))) return { unknown: `${path} calls hashFiles with an argument split over lines` };
    // @actions/glob trims each pattern.
    hashFilesPatterns.push(...args.map((a) => a.trim()).filter(Boolean));
  }
  return { uses, cacheDependencyPaths, hashFilesPatterns };
}

/**
 * @param {{
 *   root: string,
 *   actionFiles: string[] | null,
 *   symlinks: Array<{ path: string, target: string }> | null,
 *   readText: (path: string) => string | null,
 * }} input `root` is `.github/workflows/test.yml`; `actionFiles` every file under
 *   `.github/actions/` at the commit (null when unlisted); `symlinks` every
 *   symlink in the tree with its target (null when unlisted); `readText` a file's
 *   text at the commit (null when absent).
 * @returns {{ files: string[] } | { unknown: string }} the sorted workflow files
 *   that key Test's caches, `root` included, or why that cannot be told.
 */
export function workflowsKeyingCaches({ root, actionFiles, symlinks, readText }) {
  if (!Array.isArray(actionFiles)) return { unknown: 'the .github/actions/ files could not be listed' };
  if (!Array.isArray(symlinks)) return { unknown: 'the symlinks could not be listed' };
  // hashFiles follows symlinks, and a link inside .github/ can hide what an action runs.
  for (const { path, target } of symlinks) {
    const to = posix.normalize(posix.join(posix.dirname(path), target)).replace(/(.)\/$/, '$1');
    if (path === '.github' || path.startsWith('.github/') || target.startsWith('/') || to === '.' || to === '..' || to.startsWith('../') || to === '.github' || to.startsWith('.github/')) {
      return { unknown: `symlink ${path} -> ${target} may reach .github/` };
    }
  }
  const files = new Set([root]);
  const executed = [root, ...actionFiles];
  for (let i = 0; i < executed.length; i += 1) {
    const path = executed[i];
    const text = readText(path);
    if (typeof text !== 'string') return { unknown: `${path} could not be read` };
    const scan = scanFile(path, text);
    if (scan.unknown) return scan;
    for (const v of scan.uses) {
      if (v.split('/').includes('..')) return { unknown: `${path} has uses: ${v}, which climbs` };
      const local = LOCAL_WORKFLOW.exec(v);
      if (local) {
        files.add(local[1]);
        if (!executed.includes(local[1])) executed.push(local[1]);
      } else if (!LOCAL_ACTION.test(v) && !(REMOTE_ACTION.test(v) && !/\/\.github\/workflows(?:\/|@)/.test(v)) && !DOCKER.test(v)) {
        return { unknown: `${path} has uses: ${v}, which is not a plain local or remote action` };
      }
    }
    for (const pattern of [...scan.cacheDependencyPaths, ...scan.hashFilesPatterns]) {
      if (!PLAIN_PATH.test(pattern)) return { unknown: `${path} hashes '${pattern}', which is not a plain path` };
      const verdict = judgePattern(pattern);
      if (verdict === 'unknown') return { unknown: `${path} hashes '${pattern}', which may reach a workflow file` };
      if (verdict !== 'none') files.add(verdict);
    }
  }
  return { files: [...files].sort() };
}
