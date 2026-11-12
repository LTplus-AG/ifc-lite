/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which workflow and action files can change a Test cache key, worked out with
 * a real YAML parser. scripts/ci-cache-keying-files.txt is the committed answer
 * the push-replay probe reads (the probe's job has no install, so it cannot
 * parse); this module is what the unit test uses to keep that list exact.
 *
 * A file can change a Test cache key when Test executes it (test.yml, a
 * reusable workflow it calls with `uses: ./...`, a local action it uses, all
 * transitively), because its text sets the key names and prefixes; or when a
 * cache key input in an executed file can read it:
 *   - an argument of `hashFiles(...)` in any string;
 *   - a `cache-dependency-path` value (setup-node, setup-python, ...);
 *   - a `key`, `shared-key`, `prefix-key` or `restore-keys` value built from a
 *     step output, whose step's `run` text names a path.
 * Each such path or pattern is matched against the real files under
 * `.github/workflows/` and `.github/actions/` of the tree being tested (a
 * matched directory counts for every file below it, as hashFiles hashes them),
 * and every file it matches must be listed. That is exact for the tested tree,
 * and the tested tree is the one a replay needs a green run of: adding a file a
 * pattern matches fails this test in that very run. What cannot be matched is
 * an error: a non-literal hashFiles argument, an absolute or climbing path, a
 * checkout into a subdirectory (`actions/checkout` with `path:`), a reusable
 * workflow called by owner/repo, a non-composite local action.
 */

import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';

export { isListed, parseKeyingList } from './cache-keying-list.mjs';

const KEY_INPUTS = /^(?:key|shared-key|prefix-key|restore-keys)$/i;
const HASHFILES = /hashFiles\s*\(/gi;
const QUOTED_ARG = /^\s*'((?:[^']|'')*)'\s*([,)])/;
const STEP_OUTPUT = /steps\.([\w-]+)\.outputs\./g;
const GITHUB_PATH = /\.github\/[^\s'"`;|&)]*/g;

/** A glob as @actions/glob reads it (case-insensitive, to cover macOS and Windows runners). */
function globRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|\\{}[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * The tracked files under `.github/` that one hashed path or pattern reaches, or an
 * error. A pattern matching a directory reaches every file below it.
 */
export function matchedFiles(raw, files) {
  const pattern = raw.trim();
  if (pattern === '' || pattern.startsWith('!')) return { files: [] };
  if (/[[\]{}]/.test(pattern)) return { error: `'${pattern}' uses a glob class or brace the check does not expand` };
  if (pattern.startsWith('/') || pattern.startsWith('~')) return { error: `'${pattern}' is absolute` };
  const p = posix.normalize(pattern).replace(/\/$/, '');
  if (p === '..' || p.startsWith('../')) return { error: `'${pattern}' climbs out of the workspace` };
  const re = globRegex(p === '.' ? '**' : p);
  const hit = files.filter((f) => {
    const parts = f.split('/');
    return parts.some((_, k) => re.test(parts.slice(0, k + 1).join('/')));
  });
  return { files: hit };
}

/** The patterns of every hashFiles call in a string, or an error for a non-literal argument. */
function hashFilesPatterns(text) {
  const out = [];
  for (const m of text.matchAll(HASHFILES)) {
    let rest = text.slice(m.index + m[0].length);
    for (;;) {
      const a = QUOTED_ARG.exec(rest);
      if (!a) return { error: `hashFiles with an argument that is not a quoted literal in '${text.slice(m.index, m.index + 80)}'` };
      // @actions/glob reads each line of a pattern as its own pattern.
      out.push(...a[1].replace(/''/g, "'").split('\n'));
      rest = rest.slice(a[0].length);
      if (a[2] === ')') break;
    }
  }
  return { patterns: out };
}

/** Every value in a parsed document, with the key it sits under and the steps array around it. */
function* walk(node, key = null, steps = null) {
  if (Array.isArray(node)) {
    const isSteps = key === 'steps';
    for (const item of node) yield* walk(item, null, isSteps ? node : steps);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield { key: k, value: v, steps };
      yield* walk(v, k, steps);
    }
  } else if (typeof node === 'string' && key === null) {
    yield { key: null, value: node, steps };
  }
}

/**
 * @param {{
 *   root: string,
 *   readText: (path: string) => string | null,
 *   githubFiles: string[],
 *   symlinks: Array<{ path: string, target: string }>,
 * }} input `githubFiles` every tracked file under .github/workflows/ and .github/actions/.
 * @returns {{ required: string[], errors: string[] }} the files and directories that must be
 *   listed (`/`-terminated for an action directory), and what could not be judged.
 */
export function cacheKeyingFiles({ root, readText, githubFiles, symlinks }) {
  const required = new Set([root]);
  const errors = [];
  for (const { path, target } of symlinks) {
    const to = posix.normalize(posix.join(posix.dirname(path), target)).replace(/\/$/, '');
    if (path === '.github' || path.startsWith('.github/') || target.startsWith('/') || to === '.' || to === '..' || to.startsWith('../') || to === '.github' || to.startsWith('.github/')) {
      errors.push(`symlink ${path} -> ${target} may reach .github/ (hashFiles follows it)`);
    }
  }
  const executed = [root];
  const need = (pattern, where) => {
    const m = matchedFiles(pattern, githubFiles);
    if (m.error) errors.push(`${where}: ${m.error}`);
    else for (const f of m.files) required.add(f);
  };
  for (let i = 0; i < executed.length; i += 1) {
    const file = executed[i];
    const text = readText(file);
    if (typeof text !== 'string') {
      errors.push(`${file} cannot be read`);
      continue;
    }
    let doc;
    try {
      doc = parseYaml(text);
    } catch (err) {
      errors.push(`${file} does not parse: ${err.message.split('\n')[0]}`);
      continue;
    }
    for (const { key, value, steps } of walk(doc)) {
      if (typeof value !== 'string') continue;
      const hashed = hashFilesPatterns(value);
      if (hashed.error) errors.push(`${file}: ${hashed.error}`);
      else for (const p of hashed.patterns) need(p, file);
      if (key === null) continue;
      if (/^uses$/i.test(key)) {
        const v = value.trim();
        if (/^actions\/checkout@/i.test(v) && steps) {
          const step = steps.find((s) => s && s.uses === value);
          if (step?.with && Object.keys(step.with).some((k) => /^path$/i.test(k))) errors.push(`${file}: actions/checkout with path: moves the repository under a subdirectory`);
        }
        if (v.startsWith('./')) {
          const ref = posix.normalize(v);
          if (ref.startsWith('..') || ref.includes('/../')) errors.push(`${file}: uses ${v} climbs`);
          else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(ref)) {
            required.add(ref);
            if (!executed.includes(ref)) executed.push(ref);
          } else {
            const dir = `${ref.replace(/\/$/, '')}/`;
            required.add(dir);
            const meta = [`${dir}action.yml`, `${dir}action.yaml`].find((p) => typeof readText(p) === 'string');
            if (!meta) errors.push(`${file}: local action ${v} has no action.yml`);
            else if (!executed.includes(meta)) executed.push(meta);
            if (meta && !/using:\s*['"]?composite/.test(readText(meta))) errors.push(`${meta}: only composite local actions can be checked`);
          }
        } else if (/\/\.github\/workflows(?:\/|@)/.test(v)) {
          errors.push(`${file}: reusable workflow ${v} by owner/repo cannot be checked`);
        }
      } else if (/^cache-dependency-path$/i.test(key)) {
        for (const p of value.split('\n')) need(p, file);
      } else if (KEY_INPUTS.test(key)) {
        for (const [, id] of value.matchAll(STEP_OUTPUT)) {
          const step = (steps ?? []).find((s) => s && s.id === id);
          if (!step) errors.push(`${file}: ${key} uses steps.${id}, which is not in the same steps list`);
          else if (typeof step.run === 'string') for (const [p] of step.run.matchAll(GITHUB_PATH)) need(p, `${file} step ${id}`);
        }
      }
    }
  }
  return { required: [...required].sort(), errors };
}
