/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for `scripts/check-ci-path-coverage.mjs`.
 *
 * Kept in `scripts/lib/` so the parsing and glob semantics can be unit-tested
 * against hand-written fixtures without a checkout of the real workflows.
 */

/**
 * Translate one `dorny/paths-filter` glob into a RegExp over repo-relative
 * POSIX paths.
 *
 * paths-filter matches with picomatch, so `*` does NOT cross `/` and `**`
 * does. `a/**` is written to also match `a` itself, because a filter entry of
 * that shape is universally meant as "this subtree", and a caller that asks
 * whether the DIRECTORY is covered must get `true` rather than being forced to
 * enumerate it.
 *
 * ERRS TOWARD MATCHING is the wrong direction here and this deliberately does
 * not do it: this module decides whether a gate's input can trigger the gate,
 * so a glob translated too WIDELY hides exactly the defect being looked for.
 * Anything it cannot translate throws instead of degrading to a loose match.
 */
const regexCache = new Map();

export function globToRegExp(glob) {
  const cached = regexCache.get(glob);
  if (cached) return cached;
  const built = compileGlob(glob);
  regexCache.set(glob, built);
  return built;
}

function compileGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new Error('globToRegExp: empty glob');
  }
  if (/[[\]{}()+@!|]/.test(glob)) {
    // Brace/extglob/character-class syntax is legal picomatch and none of the
    // filters use it. Refuse rather than mistranslate.
    throw new Error(`globToRegExp: unsupported glob syntax in ${JSON.stringify(glob)}`);
  }
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` — crosses separators. `/**` at the end also matches the bare dir.
        if (out.endsWith('/') && i + 2 === glob.length) {
          out = `${out.slice(0, -1)}(?:/.*)?`;
        } else {
          out += '.*';
        }
        i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(/[.^$\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True when `path` (repo-relative, POSIX) is matched by any glob in `globs`. */
export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Pull the `changes` job's `filters: |` block scalar out of test.yml and return
 * `Map<filterName, string[]>`.
 *
 * Hand-rolled rather than YAML-parsed because the gate scripts run with no
 * third-party dependencies available. The block scalar is a flat two-level
 * shape (`name:` then `- 'glob'`), so the parse is exact for it and throws on
 * anything it does not recognise -- it never silently returns a short list,
 * which would read as "no holes".
 */
export function parseFilterBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*filters:\s*\|\s*$/.test(l));
  if (start === -1) throw new Error('parseFilterBlock: no `filters: |` block found');
  const bodyIndent = lines[start].match(/^(\s*)/)[1].length;

  const filters = new Map();
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const indent = raw.match(/^(\s*)/)[1].length;
    if (indent <= bodyIndent) break; // block scalar ended
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const name = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):$/);
    if (name) {
      current = name[1];
      filters.set(current, []);
      continue;
    }
    const entry = line.match(/^-\s*'([^']+)'$/) || line.match(/^-\s*"([^"]+)"$/);
    if (entry) {
      if (!current) throw new Error(`parseFilterBlock: glob before any filter name: ${line}`);
      filters.get(current).push(entry[1]);
      continue;
    }
    throw new Error(`parseFilterBlock: unrecognised line in filter block: ${JSON.stringify(line)}`);
  }
  if (filters.size === 0) throw new Error('parseFilterBlock: filter block parsed to zero filters');
  for (const [name, globs] of filters) {
    if (globs.length === 0) throw new Error(`parseFilterBlock: filter ${name} has no globs`);
  }
  return filters;
}

/**
 * Split a workflow's `jobs:` mapping into `{ id, text }` slabs.
 *
 * `text` is the job's whole body, comments stripped -- callers regex over it
 * for `node scripts/...` invocations. Stripping comments matters: test.yml
 * mentions `check-module-size.test.mjs` in a comment right above the step that
 * runs it, and a comment mention is not an invocation.
 */
export function splitJobs(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) return [];
  const jobs = [];
  let current = null;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const header = raw.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/);
    if (header) {
      current = { id: header[1], lines: [] };
      jobs.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\S/.test(raw)) break; // back to a top-level key
    if (/^\s*#/.test(raw)) continue; // comment-only line
    current.lines.push(raw);
  }
  return jobs.map((j) => ({ id: j.id, text: j.lines.join('\n') }));
}

/**
 * The filter outputs that must be `true` for a job to run, read off its `if:`.
 *
 * POSITIVE terms only: `needs.changes.outputs.docs == 'true'` gates the job on
 * `docs`, while the `frontend != 'true'` in the same expression only makes the
 * job run LESS often and so cannot add coverage. Returns `null` for a job with
 * no filter reference at all -- that job always runs, which is full coverage.
 */
export function gatingFilters(jobText) {
  const ifLine = jobText.match(/^\s{4}if:\s*(.*)$/m);
  if (!ifLine) return null;
  const expr = ifLine[1];
  const positives = [...expr.matchAll(/needs\.changes\.outputs\.([A-Za-z0-9_]+)\s*==\s*'true'/g)].map(
    (m) => m[1],
  );
  const negatives = [...expr.matchAll(/needs\.changes\.outputs\.([A-Za-z0-9_]+)\s*!=\s*'true'/g)].map(
    (m) => m[1],
  );
  if (positives.length === 0) {
    // An `if:` that never mentions a filter output (e.g. `always()`, or an
    // event-name guard) does not path-gate the job.
    return negatives.length === 0 ? null : [];
  }
  return positives;
}

/**
 * `on.pull_request.paths` for a workflow, or `null` when it has none (= all
 * paths).
 *
 * FAILS CLOSED ON SHAPES IT DOES NOT PARSE. `null` here means "this workflow
 * triggers on everything", which is the widest possible coverage claim -- so a
 * `paths:` block quietly parsed as absent is not a degraded answer, it is the
 * opposite answer, and it hides exactly the uncovered gate input this module
 * exists to find. Two shapes therefore throw rather than return:
 *
 *   - an INLINE list (`paths: ['rust/**']`). The block-scalar matcher requires
 *     an empty tail after the colon, so an inline list fell through to the
 *     "some other key" branch and left `paths` at `null`.
 *   - an UNQUOTED or otherwise unrecognised entry inside a block list. That one
 *     errs the safe way -- a short list under-claims coverage and over-reports
 *     violations -- but a finding derived from a silently truncated trigger
 *     list is noise a reader cannot distinguish from a real hole.
 */
export function parseWorkflowPrPaths(text) {
  const lines = text.split('\n');
  const onAt = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onAt === -1) return { triggersOnPr: false, paths: null };
  let inPr = false;
  let inPaths = false;
  let paths = null;
  for (let i = onAt + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\S/.test(raw)) break;
    if (/^\s*#/.test(raw)) continue;
    if (/^ {2}pull_request:\s*$/.test(raw)) {
      inPr = true;
      continue;
    }
    if (/^ {2}\S/.test(raw)) {
      inPr = false;
      inPaths = false;
      continue;
    }
    if (!inPr) continue;
    const pathsKey = raw.match(/^ {4}(paths(?:-ignore)?):(.*)$/);
    if (pathsKey) {
      const tail = pathsKey[2].trim();
      if (tail !== '' && !tail.startsWith('#')) {
        throw new Error(
          `parseWorkflowPrPaths: on.pull_request.${pathsKey[1]} is written inline ` +
            `(${JSON.stringify(raw.trim())}). Only the block-list form is parsed, and reading ` +
            'this as "no path filter" would claim the workflow triggers on everything. ' +
            'Rewrite it as a block list, or teach this parser the inline form.',
        );
      }
      // `paths-ignore` is an exclusion list, not an inclusion list; a workflow
      // using it triggers on everything else, which is full coverage.
      if (pathsKey[1] === 'paths-ignore') return { triggersOnPr: true, paths: null };
      inPaths = true;
      paths = [];
      continue;
    }
    if (/^ {4}\S/.test(raw)) {
      inPaths = false;
      continue;
    }
    if (inPaths) {
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      const entry = trimmed.match(/^-\s*'([^']+)'$/) || trimmed.match(/^-\s*"([^"]+)"$/);
      if (!entry) {
        throw new Error(
          `parseWorkflowPrPaths: unparseable entry in on.pull_request.paths: ` +
            `${JSON.stringify(trimmed)}. Dropping it silently would shorten the trigger list ` +
            'and turn a covered gate input into a reported violation.',
        );
      }
      paths.push(entry[1]);
    }
  }
  return { triggersOnPr: inPrSeen(lines, onAt), paths };
}

function inPrSeen(lines, onAt) {
  for (let i = onAt + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    if (/^ {2}pull_request:/.test(lines[i])) return true;
  }
  return false;
}

/**
 * Repo-relative paths a gate script READS, derived from its own source.
 *
 * Two literal shapes, both of which the real gates use:
 *   - a quoted string that is itself a repo path (`'packages'`, `'apps'`,
 *     `'.github/workflows'`, `'apps/landing/app.jsx'`)
 *   - `join(ROOT, 'tests', 'benchmark', 'baseline.json')` and the same shape
 *     with any root identifier
 *
 * A literal only survives if it resolves to something that EXISTS in the repo,
 * which is what keeps prose and non-path strings out. `exists` is injected so
 * this stays pure.
 */
/**
 * Not a repo INPUT even though it resolves: the tree root, its parent (every
 * gate computes ROOT as `join(dirname(...), '..')`), and git's own directory.
 * Left in, `.` makes every gate read the whole repo and the check says nothing.
 */
const NOT_AN_INPUT = new Set(['.', '..', '.git', '']);

function normalise(p) {
  return p.replace(/\/+$/, '').replace(/^\.\//, '');
}

/**
 * A `..` segment leaves the repo, so whatever it resolves to is not a repo
 * input and no filter could ever name it. `join(ROOT, '..', '..', x)` in a
 * gate's own test fixtures otherwise walks out of the checkout entirely.
 */
const escapesRepo = (p) => p.split('/').includes('..');

export function deriveInputs(source, exists) {
  const found = new Set();

  for (const m of source.matchAll(/\bjoin\(\s*([A-Za-z_$][\w$]*)\s*,\s*([^)]*)\)/g)) {
    const args = m[2];
    if (/[^\s,'"\w./$-]/.test(args)) continue; // an expression, not a literal path
    const parts = [...args.matchAll(/'([^']*)'|"([^"]*)"/g)].map((p) => p[1] ?? p[2]);
    if (parts.length === 0) continue;
    const candidate = normalise(parts.join('/').replace(/\/+/g, '/'));
    if (!NOT_AN_INPUT.has(candidate) && !escapesRepo(candidate) && exists(candidate)) found.add(candidate);
  }

  for (const m of source.matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)) {
    const raw = m[1] ?? m[2];
    if (!raw || raw.includes('${') || raw.includes(' ')) continue;
    if (!/^[\w.][\w./-]*$/.test(raw)) continue;
    const lit = normalise(raw);
    if (NOT_AN_INPUT.has(lit) || escapesRepo(lit)) continue;
    if (exists(lit)) found.add(lit);
  }

  return dropSubsumed([...found]);
}

/**
 * Drop `packages/bcf` when `packages` is already in the set.
 *
 * Purely an economy -- a subtree cannot be covered when its parent is not, so
 * the answer is identical. Without it, `check-module-size.mjs` names all 38
 * workspace packages individually and each one is walked again.
 */
export function dropSubsumed(paths) {
  const sorted = [...new Set(paths)].sort();
  return sorted
    .filter((p) => !sorted.some((q) => q !== p && p.startsWith(`${q}/`)))
    .sort();
}

/**
 * Translate a `.gitignore` into globs over repo-relative POSIX paths.
 *
 * WHY THIS EXISTS. The gate derives a job's inputs by walking the tree. A walk
 * over the WORKING tree sees whatever happens to be on disk: `node_modules`
 * after an install, a package's `dist` after a build, the `.ifc` corpus under
 * `tests/models` after the fixture cache warms. None of those are committed, so none of them
 * can ever be what a `paths:` filter matches -- but their presence changed the
 * VERDICT. The check passed on a developer's clean checkout and failed in CI
 * on the identical commit, which makes it not a check at all. Restricting the
 * walk to what git tracks makes the answer a function of the commit alone.
 *
 * Read from the committed `.gitignore` rather than by shelling out to
 * `git check-ignore`, so the synthetic trees in the harness -- which are not
 * git repositories -- run the SAME exclusion the real repository runs. A
 * fallback path for "not a repo" would be a second behaviour nothing tests.
 *
 * The supported subset is exactly what this repository's `.gitignore` uses.
 * Anything else THROWS: a pattern silently dropped is a tree the walk wanders
 * back into, which is the defect this function exists to remove.
 *
 * @param {string} text
 * @returns {string[]} globs consumable by {@link matchesAny}.
 */
export function gitignoreToGlobs(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      // A re-inclusion means the ignore set is no longer a plain union and
      // ordering starts to matter. Refusing is the honest answer.
      throw new Error(`gitignoreToGlobs: negation is not supported: ${JSON.stringify(line)}`);
    }
    if (line.includes('\\')) {
      throw new Error(`gitignoreToGlobs: escapes are not supported: ${JSON.stringify(line)}`);
    }

    const trailingSlash = line.endsWith('/');
    let body = trailingSlash ? line.slice(0, -1) : line;
    const anchored = body.startsWith('/');
    if (anchored) body = body.slice(1);
    if (body === '') {
      throw new Error(`gitignoreToGlobs: empty pattern: ${JSON.stringify(line)}`);
    }

    // git anchors a pattern to the repo root as soon as it contains a slash
    // anywhere but the end; otherwise it matches at every depth.
    const rooted = anchored || body.includes('/');
    const bases = rooted ? [body] : [body, `**/${body}`];
    for (const base of bases) {
      // Both the node itself and everything under it: git ignoring a directory
      // ignores its whole subtree, and the walk must be able to ask either
      // question.
      out.push(base, `${base}/**`);
      // `a/**/b` in git matches ZERO or more intervening directories, so
      // `tests/models/**/*.ifc` covers `tests/models/AB22.ifc`. `globToRegExp`
      // renders `**` as `.*`, which needs the separators on both sides and so
      // would miss the zero-directory case -- and missing it is what left the
      // corpus visible to the walk in the first place. Emit the collapsed form
      // alongside rather than loosening the shared translator, which decides a
      // different question for the filter globs.
      if (base.includes('/**/')) {
        const collapsed = base.replaceAll('/**/', '/');
        out.push(collapsed, `${collapsed}/**`);
      }
    }
  }
  return out;
}
