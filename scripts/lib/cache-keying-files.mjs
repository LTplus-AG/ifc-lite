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

// An input that names or builds a cache key: key, shared-key, prefix-key, restore-keys,
// cache-prefix, cache-key, cache, ...
const KEYISH = /key|cache/;
// What setup-node/setup-python hash for `cache:` when no cache-dependency-path is given.
const CACHE_DEFAULTS = {
  pnpm: ['**/pnpm-lock.yaml'], npm: ['**/package-lock.json', '**/npm-shrinkwrap.json'], yarn: ['**/yarn.lock'],
  pip: ['**/requirements.txt'], pipenv: ['**/Pipfile.lock'], poetry: ['**/poetry.lock'],
};
// A key-producing run that may hash .github without naming a file.
const BROAD_RUN = /\.github(?!\/)|\bgit\s+ls-(?:files|tree)\b|\bfind\s/;
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
  if (pattern.includes('${{')) return { error: `'${pattern}' is built from an expression, which the check cannot follow` };
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

/** A parsed document with every mapping key lowercased, so lookups do not depend on case. */
function lowerKeys(node) {
  if (Array.isArray(node)) return node.map(lowerKeys);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [String(k).toLowerCase(), lowerKeys(v)]));
  return node;
}

/** Every value in a parsed document, with its key, the mapping holding it, and the steps array around it. */
function* walk(node, key = null, steps = null, parent = null) {
  if (Array.isArray(node)) {
    const isSteps = key === 'steps';
    for (const item of node) yield* walk(item, null, isSteps ? node : steps, null);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield { key: k, value: v, steps, parent: node };
      yield* walk(v, k, steps, node);
    }
  } else if (typeof node === 'string' && key === null) {
    yield { key: null, value: node, steps, parent };
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
  // Who calls each executed action or reusable workflow, with what `with:`: a key built
  // from `inputs.X` inside it is traced to each caller's value of X once all are known.
  const callers = new Map();
  const callerOf = (target, step, steps, file) => {
    if (!callers.has(target)) callers.set(target, []);
    callers.get(target).push({ file, with: step?.with && typeof step.with === 'object' ? step.with : {}, steps });
  };
  const inputRefs = [];
  // A value that feeds a cache key: env/needs cannot be followed; a step output is traced
  // to its step's `run`, and a `uses:` step's output cannot be seen into.
  const traceKeyValue = (value, steps, where) => {
    if (/\b(?:env|needs)\./.test(value)) errors.push(`${where} is built from env or needs, which the check cannot follow`);
    for (const [, id] of value.matchAll(STEP_OUTPUT)) {
      const step = (steps ?? []).find((s) => s && s.id === id);
      if (!step) errors.push(`${where} uses steps.${id}, which is not in the same steps list`);
      else if (typeof step.run !== 'string') errors.push(`${where} uses the output of step ${id}, which runs an action the check cannot see into`);
      else {
        if (BROAD_RUN.test(step.run)) errors.push(`${where}: step ${id}'s run may hash .github without naming a file`);
        for (const [p] of step.run.matchAll(GITHUB_PATH)) need(p, `${where} step ${id}`);
      }
    }
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
      doc = lowerKeys(parseYaml(text));
    } catch (err) {
      errors.push(`${file} does not parse: ${err.message.split('\n')[0]}`);
      continue;
    }
    for (const { key, value, steps, parent } of walk(doc)) {
      if (typeof value !== 'string') continue;
      const hashed = hashFilesPatterns(value);
      if (hashed.error) errors.push(`${file}: ${hashed.error}`);
      else for (const p of hashed.patterns) need(p, file);
      if (key === null) continue;
      if (key === 'uses') {
        const v = value.trim();
        if (/^actions\/checkout@/i.test(v) && parent?.with && typeof parent.with === 'object' && 'path' in parent.with) {
          errors.push(`${file}: actions/checkout with path: moves the repository under a subdirectory`);
        }
        if (v.startsWith('./')) {
          const ref = posix.normalize(v);
          if (ref.startsWith('..') || ref.includes('/../')) errors.push(`${file}: uses ${v} climbs`);
          else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(ref)) {
            callerOf(ref, parent, steps, file);
            required.add(ref);
            if (!executed.includes(ref)) executed.push(ref);
          } else if (!ref.startsWith('.github/actions/')) {
            errors.push(`${file}: local action ${v} is outside .github/actions/, where the list can cover it`);
          } else {
            const dir = `${ref.replace(/\/$/, '')}/`;
            required.add(dir);
            const meta = [`${dir}action.yml`, `${dir}action.yaml`].find((p) => typeof readText(p) === 'string');
            if (!meta) errors.push(`${file}: local action ${v} has no action.yml`);
            else {
              callerOf(meta, parent, steps, file);
              if (!executed.includes(meta)) executed.push(meta);
            }
            let using;
            try {
              using = meta && lowerKeys(parseYaml(readText(meta)))?.runs?.using;
            } catch (err) {
              errors.push(`${meta} does not parse: ${err.message.split('\n')[0]}`);
            }
            if (meta && using !== 'composite') errors.push(`${meta}: only composite local actions can be checked`);
          }
        } else if (/\/\.github\/workflows(?:\/|@)/.test(v)) {
          errors.push(`${file}: reusable workflow ${v} by owner/repo cannot be checked`);
        }
      } else if (key === 'cache-dependency-path') {
        for (const p of value.split('\n')) need(p, file);
      } else if (KEYISH.test(key)) {
        traceKeyValue(value, steps, `${file}: ${key}`);
        for (const [, input] of value.matchAll(/\binputs\.([\w-]+)/g)) inputRefs.push({ file, key, input: input.toLowerCase() });
        if (key === 'cache' && steps) {
          // `cache:` under a step's `with:`; its step is the one whose `with` this is.
          const step = steps.find((s) => s && s.with === parent);
          if (step && /^actions\/setup-/i.test(String(step.uses))) {
            const defaults = CACHE_DEFAULTS[value.trim().toLowerCase()];
            if (defaults) for (const p of defaults) need(p, file);
            else if (!/^(?:false|)$/i.test(value.trim())) errors.push(`${file}: ${step.uses} cache: ${value} has no known default lockfile`);
          }
        }
      }
    }
  }
  for (const { file, key, input } of inputRefs) {
    for (const caller of callers.get(file) ?? []) {
      const v = caller.with[input];
      if (typeof v === 'string') traceKeyValue(v, caller.steps, `${caller.file} -> ${file}: ${key} via inputs.${input}`);
    }
  }
  return { required: [...required].sort(), errors };
}
