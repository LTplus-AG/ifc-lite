/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Text-extraction layer for scripts/check-server-bin-targets.mjs.
 *
 * Everything here is COMMENT-AWARE, and that is the point of the module: an
 * adversarial review of PR #2642 showed that regex-anywhere matching gave the
 * parity gate four false greens (a commented-out matrix entry still counted
 * as a target; a commented-out entry in SUPPORTED_TARGETS still parsed; a
 * stale literal in a comment satisfied the upload-name check) and three false
 * reds (a TODO comment inside the Set demanded a matrix change; an entry
 * whose target: was not the first key vanished; a quoted scalar leaked its
 * quotes). So comments are stripped BEFORE any matching, matrix entries are
 * parsed as key/value blocks whose key order is irrelevant, and quoted
 * scalars are unquoted.
 *
 * This is deliberately NOT a YAML or TypeScript parser - the repo root has no
 * YAML dependency, and two known files are the whole input domain. Where the
 * simplification could misread an exotic construct (a regex literal
 * containing `//`, flow-style YAML), the damage is over-stripping or a
 * skipped entry, and every consumer treats a missing value as a hard error:
 * a misparse fails closed, never green. The executable proof lives in
 * scripts/check-server-bin-targets.test.mjs.
 */

export function fail(message) {
  console.error(`check-server-bin-targets: ERROR: ${message}`);
  process.exit(1);
}

/**
 * Strip YAML comments: a `#` at line start or preceded by whitespace opens a
 * comment unless it sits inside a quoted scalar. Shell embedded in `run: |`
 * blocks uses the same `#`-to-end-of-line form, so one strip is correct for
 * both. Quote state is per-line on purpose - a stray quote in one line must
 * not hide a comment marker in the next.
 */
export function stripYamlComments(source) {
  return source.split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (quote === '"' && c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
        return line.slice(0, i).replace(/[ \t]+$/, '');
      }
    }
    return line;
  }).join('\n');
}

/**
 * Strip TypeScript `//` and block comments without touching string contents
 * (', " and ` strings are tracked, so a slash inside a literal never opens a
 * comment). Comments become a single space so token boundaries survive;
 * newlines are kept. Regex literals are not modelled: platform.ts has none,
 * and if one ever contains `//` the result is over-stripping, which the
 * caller's fewer-than-2-targets guard turns into a hard error.
 */
export function stripTsComments(source) {
  let out = '';
  let state = null; // null = code; a quote char = in string; 'line'/'block' = in comment
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const d = source[i + 1];
    if (state === 'line') {
      if (c === '\n') { state = null; out += c; }
    } else if (state === 'block') {
      if (c === '*' && d === '/') { state = null; out += ' '; i++; }
      else if (c === '\n') out += c;
    } else if (state) {
      out += c;
      if (c === '\\') { out += d ?? ''; i++; }
      else if (c === state) state = null;
    } else if (c === '/' && d === '/') { state = 'line'; i++; }
    else if (c === '/' && d === '*') { state = 'block'; i++; }
    else {
      out += c;
      if (c === "'" || c === '"' || c === '`') state = c;
    }
  }
  return out;
}

/** Strip one layer of matching surrounding quotes from a YAML scalar. */
export function unquoteScalar(value) {
  const m = /^'([^']*)'$/.exec(value) ?? /^"([^"]*)"$/.exec(value);
  return m ? m[1] : value;
}

/**
 * Extract one job's block from the workflow (2-space-indented job keys).
 * Expects comment-stripped source, like every function below.
 */
export function jobBlock(source, jobName, origin) {
  const start = new RegExp(`^  ${jobName}:[ \\t]*$`, 'm').exec(source);
  if (!start) {
    fail(`cannot find job "${jobName}" in ${origin}; if it was renamed, update this check`);
  }
  const bodyStart = start.index + start[0].length;
  const next = /^  [A-Za-z0-9_-]+:/m.exec(source.slice(bodyStart));
  return next ? source.slice(bodyStart, bodyStart + next.index) : source.slice(bodyStart);
}

/**
 * Parse `- target:` / `rust-target:` / `archive:` tuples from a job's matrix
 * include list. Entries are parsed as blocks - a `- ` line opens an entry and
 * indented `key: value` lines extend it - so the target: key may sit anywhere
 * in its entry, not only first. A `- ` line whose first key is missing still
 * opens an entry, and an entry that never names a target is a hard error.
 */
export function parseMatrix(workflow, jobName, origin, { requireArchive }) {
  const block = jobBlock(workflow, jobName, origin);
  const includeIdx = block.indexOf('include:');
  const steps = /^    steps:/m.exec(block);
  if (includeIdx === -1 || !steps || steps.index < includeIdx) {
    fail(`cannot find the matrix include list in job "${jobName}" of ${origin}`);
  }
  const entries = [];
  let current = null;
  for (const line of block.slice(includeIdx, steps.index).split('\n')) {
    if (/^[ \t]*-[ \t]*$/.test(line)) {
      entries.push((current = {}));
      continue;
    }
    const kv = /^[ \t]*(-[ \t]+)?([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1]) entries.push((current = {}));
    if (current) current[kv[2]] = unquoteScalar(kv[3].trim());
  }
  if (entries.length === 0) {
    fail(`matrix include list in job "${jobName}" of ${origin} yielded zero targets; refusing a vacuous pass`);
  }
  return entries.map((entry, i) => {
    if (!entry.target) {
      fail(`matrix include entry ${i + 1} in job "${jobName}" of ${origin} has no target: key; refusing a vacuous pass`);
    }
    if (requireArchive && !entry.archive) {
      fail(`matrix entry "${entry.target}" in job "${jobName}" of ${origin} has no archive: key`);
    }
    if (!entry['rust-target']) {
      fail(
        `matrix entry "${entry.target}" in job "${jobName}" of ${origin} has no rust-target: key; ` +
        `refusing a vacuous pass - without it nothing pins which triple that leg builds`,
      );
    }
    return { target: entry.target, archive: entry.archive ?? null, rustTarget: entry['rust-target'] };
  });
}

/** Parse the SUPPORTED_TARGETS set literal out of platform.ts source text. */
export function parseSupportedTargets(rawSource, origin) {
  const source = stripTsComments(rawSource);
  const m = source.match(/const SUPPORTED_TARGETS = new Set\(\[([^\]]*)\]\)/);
  if (!m) {
    fail(
      `cannot find the "const SUPPORTED_TARGETS = new Set([...])" list in ${origin}; ` +
      `if the const moved or was renamed, update this check - it must not pass without the list`,
    );
  }
  const targets = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((q) => q[1]);
  if (targets.length < 2) {
    fail(`parsed only ${targets.length} target(s) from SUPPORTED_TARGETS in ${origin}; refusing a vacuous pass`);
  }
  return targets;
}
